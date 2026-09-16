import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";

export type CredentialIdentity = { channelType: string; installationId: string; tenantId: string; openId: string };
export type CredentialState = {
  vaultId: string; credentialId: string;
  status: "binding" | "ready" | "refreshing" | "refresh_uncertain" | "sync_pending" | "reauth_required";
  refreshToken?: string; pendingAccessToken?: string;
  expiresAt: number; scopes: string[]; retryAfter?: number;
  revision: number;
};

export function credentialIdentityKey(identity: CredentialIdentity): string {
  const values = [identity.channelType, identity.installationId, identity.tenantId, identity.openId];
  if (values.some(value => typeof value !== "string" || !value.trim())) throw new Error("用户凭证缺少完整的Channel、应用、租户或用户身份");
  return JSON.stringify(values);
}

// 密钥独立于WebUI登录Token。持久化数据库必须连同本文件备份；缺失时禁止生成替代密钥。
export class CredentialStateStore {
  private db: DatabaseSync;
  private path: string;
  private key?: Buffer;
  private leases = new Map<string, string>();
  constructor(db: DatabaseSync, path: string) {
    this.db = db; this.path = path;
    db.exec(`
      CREATE TABLE IF NOT EXISTS employee_credentials (
        identity_key TEXT PRIMARY KEY, channel_type TEXT NOT NULL, installation_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL, open_id TEXT NOT NULL, vault_id TEXT NOT NULL, credential_id TEXT NOT NULL,
        status TEXT NOT NULL, secret TEXT NOT NULL, expires_at INTEGER NOT NULL, scopes TEXT NOT NULL,
        retry_after INTEGER, revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(vault_id, credential_id)
      );
      CREATE TABLE IF NOT EXISTS employee_credential_operations (
        identity_key TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS employee_credentials_private_vault ON employee_credentials(vault_id);
    `);
  }

  prepare(): void {
    this.encryptionKey();
    // 旧表暂保留身份信息供有绑定证据的迁移使用，但不再继续保存明文Token。
    const rows = this.db.prepare("SELECT tenant_key, open_id, refresh_token FROM employee_oauth").all() as Array<{ tenant_key: string; open_id: string; refresh_token: string }>;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) if (!row.refresh_token.startsWith("sealed:v1:")) {
        const encrypted = this.seal(row.refresh_token, this.legacyContext(row.tenant_key, row.open_id));
        this.db.prepare("UPDATE employee_oauth SET refresh_token = ? WHERE tenant_key = ? AND open_id = ? AND refresh_token = ?")
          .run(encrypted, row.tenant_key, row.open_id, row.refresh_token);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  sealLegacy(value: string, tenantKey: string, openId: string): string { return this.seal(value, this.legacyContext(tenantKey, openId)); }
  sealAuthorization(value: string, context: string): string { return this.seal(value, `authorization:${context}`); }
  openAuthorization(value: string, context: string): string { return this.open(value, `authorization:${context}`); }
  openLegacy(value: string, tenantKey: string, openId: string): string {
    return value.startsWith("sealed:v1:") ? this.open(value, this.legacyContext(tenantKey, openId)) : value;
  }
  private legacyContext(tenantKey: string, openId: string): string { return JSON.stringify(["legacy", tenantKey, openId]); }

  get(identity: CredentialIdentity): CredentialState | undefined {
    const key = credentialIdentityKey(identity);
    const row = this.db.prepare("SELECT * FROM employee_credentials WHERE identity_key = ?").get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const secrets = JSON.parse(this.open(String(row.secret), key)) as Pick<CredentialState, "refreshToken" | "pendingAccessToken">;
    return { vaultId: String(row.vault_id), credentialId: String(row.credential_id), status: row.status as CredentialState["status"],
      ...secrets, expiresAt: Number(row.expires_at), scopes: JSON.parse(String(row.scopes)),
      retryAfter: row.retry_after === null ? undefined : Number(row.retry_after), revision: Number(row.revision) };
  }

  save(identity: CredentialIdentity, value: Omit<CredentialState, "revision">, expectedRevision: number): CredentialState {
    const key = credentialIdentityKey(identity);
    const secret = this.seal(JSON.stringify({ refreshToken: value.refreshToken, pendingAccessToken: value.pendingAccessToken }), key);
    const result = this.db.prepare(`INSERT INTO employee_credentials
      (identity_key, channel_type, installation_id, tenant_id, open_id, vault_id, credential_id, status, secret, expires_at, scopes, retry_after, revision, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM employee_credentials WHERE identity_key = ?)
      ON CONFLICT(identity_key) DO UPDATE SET vault_id=excluded.vault_id, credential_id=excluded.credential_id,
      status=excluded.status, secret=excluded.secret, expires_at=excluded.expires_at, scopes=excluded.scopes,
      retry_after=excluded.retry_after, revision=excluded.revision, updated_at=excluded.updated_at
      WHERE employee_credentials.revision = ?`
    ).run(key, identity.channelType, identity.installationId, identity.tenantId, identity.openId, value.vaultId, value.credentialId,
      value.status, secret, value.expiresAt, JSON.stringify(value.scopes), value.retryAfter ?? null, expectedRevision + 1,
      new Date().toISOString(), expectedRevision, key, expectedRevision);
    if (Number(result.changes) !== 1) throw new Error("用户凭证版本已变化，请重新读取后处理");
    return { ...value, revision: expectedRevision + 1 };
  }

  acquire(identity: CredentialIdentity): string {
    const key = credentialIdentityKey(identity);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT pid, host FROM employee_credential_operations WHERE identity_key = ?").get(key) as { pid: number; host: string } | undefined;
      if (current) {
        let alive = true;
        if (current.host === hostname()) try { process.kill(current.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw new Error("该身份的凭证操作正在进行，请稍后重试");
      }
      const token = randomUUID();
      this.db.prepare("INSERT OR REPLACE INTO employee_credential_operations VALUES (?, ?, ?, ?)").run(key, token, process.pid, hostname());
      this.db.exec("COMMIT");
      this.leases.set(key, token);
      return token;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  release(identity: CredentialIdentity, token: string): void {
    const key = credentialIdentityKey(identity);
    // close已释放的租约不再访问数据库，允许晚到的异步finally安全退出。
    if (this.leases.get(key) !== token) return;
    this.db.prepare("DELETE FROM employee_credential_operations WHERE identity_key = ? AND token = ?").run(key, token);
    if (this.leases.get(key) === token) this.leases.delete(key);
  }
  close(): void {
    for (const [key, token] of this.leases) this.db.prepare("DELETE FROM employee_credential_operations WHERE identity_key = ? AND token = ?").run(key, token);
    this.leases.clear(); this.key?.fill(0); this.key = undefined;
  }

  private encryptionKey(): Buffer {
    if (this.key) return this.key;
    if (this.path === ":memory:") return this.key = randomBytes(32);
    const path = `${this.path}.credential-key`;
    let fd: number | undefined;
    try {
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const exists = this.db.prepare("SELECT 1 FROM employee_credentials LIMIT 1").get()
          || this.db.prepare("SELECT 1 FROM employee_oauth WHERE refresh_token LIKE 'sealed:v1:%' LIMIT 1").get()
          || (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='employee_authorization_flows'").get()
            && this.db.prepare("SELECT 1 FROM employee_authorization_flows LIMIT 1").get())
          || (this.db.prepare("PRAGMA table_info(authorization_recoveries)").all().some(row => row.name === "evidence")
            && this.db.prepare("SELECT 1 FROM authorization_recoveries WHERE evidence IS NOT NULL LIMIT 1").get())
          || (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='gateway_message_inbox'").get()
            && this.db.prepare("SELECT 1 FROM gateway_message_inbox LIMIT 1").get());
        if (exists) throw new Error("missing");
        let created: number | undefined;
        try {
          created = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          writeFileSync(created, randomBytes(32)); fsyncSync(created);
        } catch (createError) { if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError; }
        finally { if (created !== undefined) closeSync(created); }
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      }
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("permissions");
      const key = readFileSync(fd);
      if (key.length !== 32) throw new Error("invalid");
      this.key = key; return key;
    } catch { throw new Error("用户凭证加密密钥缺失、损坏或权限不安全；请恢复与数据库配套的0600密钥文件，不能自动重置"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  private seal(value: string, context: string): string {
    const key = this.encryptionKey(), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `sealed:v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
  }
  private open(value: string, context: string): string {
    const key = this.encryptionKey();
    try {
      if (!value.startsWith("sealed:v1:")) throw new Error("invalid");
      const data = Buffer.from(value.slice(10), "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
    } catch { throw new Error("用户凭证解密失败，请检查数据库、身份和密钥是否匹配"); }
  }
}
