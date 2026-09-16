import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { credentialIdentityKey, type CredentialIdentity, type CredentialStateStore } from "./credential-state.ts";
import { configFingerprint } from "./session-config.ts";

export const PROVISIONING_CREDENTIAL_NAME = "lark-cli-user-access-token";
export const PROVISIONING_SECRET_NAME = "LARKSUITE_CLI_USER_ACCESS_TOKEN";
export const PROVISIONING_PLACEHOLDER = "ARKAGENT_USER_AUTH_PENDING";
export type CredentialProvisioningPhase = "vault_pending" | "vault_confirmed" | "credential_pending" | "ready" | "completed";
export type CredentialProvisioningRecord = {
  version: 1; identity: CredentialIdentity; operationId: string; revision: number; phase: CredentialProvisioningPhase;
  createdAt: number; credentialRequestedAt?: number; vaultName: string; credentialName: string;
  vaultId?: string; credentialId?: string;
  initialAuthorizationGeneration?: string;
};

const revisions: Record<CredentialProvisioningPhase, number> = {
  vault_pending: 1, vault_confirmed: 2, credential_pending: 3, ready: 4, completed: 5
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const commonKeys = ["version", "identity", "operationId", "revision", "phase", "createdAt", "vaultName", "credentialName"];

// 关联标识只用于核对原请求，不表示MA支持幂等创建，也不允许据此重复POST。
export function provisioningMetadata(record: CredentialProvisioningRecord, kind: "vault" | "credential"): Record<string, string> {
  validateRecord(record);
  if (kind !== "vault" && kind !== "credential") throw new Error("用户凭证预置请求类型无效");
  if (kind === "credential" && !record.vaultId) throw new Error("用户凭证预置尚未确认原Vault");
  const identityKey = credentialIdentityKey(record.identity);
  const request = kind === "vault" ? { identity: record.identity, display_name: record.vaultName }
    : { identity: record.identity, vault_id: record.vaultId, display_name: record.credentialName,
      auth: { type: "environment_variable", secret_name: PROVISIONING_SECRET_NAME, secret_value: PROVISIONING_PLACEHOLDER,
        networking: { type: "unrestricted" } } };
  return { external_user_id: sha256(identityKey), arkagent_provision_operation: record.operationId,
    arkagent_provision_request: configFingerprint(request) };
}

// pending表示写入结果可能未知，不能解释为尚未请求；本模块不发送任何远端请求。
export class CredentialProvisioningStore {
  private db: DatabaseSync;
  private credentials: CredentialStateStore;
  constructor(db: DatabaseSync, credentials: CredentialStateStore) {
    this.db = db; this.credentials = credentials;
    db.exec(`CREATE TABLE IF NOT EXISTS employee_credential_provisioning (
      identity_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
      vault_id TEXT UNIQUE, secret TEXT NOT NULL
    )`);
  }

  get(identity: CredentialIdentity): CredentialProvisioningRecord | undefined {
    validateIdentity(identity);
    const row = this.db.prepare("SELECT * FROM employee_credential_provisioning WHERE identity_key = ?").get(credentialIdentityKey(identity));
    return row ? this.decode(row) : undefined;
  }

  begin(identity: CredentialIdentity, operationId?: string): CredentialProvisioningRecord {
    validateIdentity(identity);
    if (operationId !== undefined && (typeof operationId !== "string" || !uuid.test(operationId))) {
      throw new Error("用户凭证预置操作标识无效");
    }
    return this.transaction(() => {
      if (this.credentials.get(identity)) throw new Error("该用户已有凭证绑定，不能重新预置");
      if (this.get(identity)) throw new Error("用户凭证预置已有记录，必须核查原操作，不能重复创建");
      const record: CredentialProvisioningRecord = { version: 1, identity: structuredClone(identity), operationId: operationId ?? randomUUID(),
        revision: 1, phase: "vault_pending", createdAt: Date.now(), vaultName: vaultName(identity),
        credentialName: PROVISIONING_CREDENTIAL_NAME };
      validateRecord(record);
      this.db.prepare("INSERT INTO employee_credential_provisioning (identity_key, operation_id, revision, vault_id, secret) VALUES (?, ?, ?, NULL, ?)")
        .run(credentialIdentityKey(identity), record.operationId, record.revision, this.encode(record));
      return structuredClone(record);
    });
  }

  confirmVault(expected: CredentialProvisioningRecord, vaultId: string): CredentialProvisioningRecord {
    if (!identifier(vaultId)) throw new Error("用户凭证预置Vault标识无效");
    return this.transaction(() => {
      const current = this.expected(expected, "vault_pending");
      this.assertVaultAvailable(current.identity, vaultId);
      return this.save(current, { ...current, phase: "vault_confirmed", vaultId, revision: current.revision + 1 });
    });
  }

  beginCredential(expected: CredentialProvisioningRecord): CredentialProvisioningRecord {
    return this.transaction(() => {
      const current = this.expected(expected, "vault_confirmed");
      // 等待远端回执期间可能有不经过Manager租约的管理写入；已有绑定不再创建另一份Credential。
      if (this.credentials.get(current.identity)) throw new Error("用户已有凭证绑定，不能继续原预置创建");
      this.assertVaultAvailable(current.identity, current.vaultId!);
      return this.save(current, { ...current, phase: "credential_pending", credentialRequestedAt: Date.now(), revision: current.revision + 1 });
    });
  }

  confirmCredential(expected: CredentialProvisioningRecord, credentialId: string): CredentialProvisioningRecord {
    if (!identifier(credentialId)) throw new Error("用户凭证预置Credential标识无效");
    return this.transaction(() => {
      const current = this.expected(expected, "credential_pending");
      this.assertVaultAvailable(current.identity, current.vaultId!);
      return this.save(current, { ...current, phase: "ready", credentialId, revision: current.revision + 1 });
    });
  }

  complete(expected: CredentialProvisioningRecord): CredentialProvisioningRecord {
    validateRecord(expected);
    return this.transaction(() => {
      const current = this.expected(expected, expected.phase === "completed" ? "completed" : "ready");
      this.assertVaultAvailable(current.identity, current.vaultId!);
      const binding = this.credentials.get(current.identity);
      if (binding && (binding.vaultId !== current.vaultId || binding.credentialId !== current.credentialId)) {
        throw new Error("用户凭证绑定与原预置操作不一致，不能覆盖已有授权");
      }
      if (current.phase === "completed") {
        if (!binding) throw new Error("已完成预置缺少原凭证绑定，不能重新生成");
        return current;
      }
      // 已有相同绑定可能已经OAuth成功，必须保留Token、状态和授权代次。
      let initialAuthorizationGeneration: string | undefined;
      if (!binding) {
        const created = this.credentials.save(current.identity, { vaultId: current.vaultId!, credentialId: current.credentialId!,
          status: "binding", expiresAt: 0, scopes: [] }, 0);
        initialAuthorizationGeneration = created.authorizationGeneration;
        if (typeof initialAuthorizationGeneration !== "string" || !uuid.test(initialAuthorizationGeneration)) {
          throw new Error("首次凭证绑定缺少有效授权代次，未完成原预置操作");
        }
      }
      // 仅记录本事务新建占位绑定的代次，不能把既有授权回填成原任务的初始证明。
      return this.save(current, { ...current, phase: "completed", revision: current.revision + 1,
        ...(initialAuthorizationGeneration === undefined ? {} : { initialAuthorizationGeneration }) });
    });
  }

  private expected(value: CredentialProvisioningRecord, phase: CredentialProvisioningPhase): CredentialProvisioningRecord {
    validateRecord(value);
    const current = this.get(value.identity);
    if (!current || configFingerprint(current) !== configFingerprint(value)) {
      throw new Error("用户凭证预置版本或绑定已变化，不能覆盖原记录");
    }
    if (current.phase !== phase) throw new Error("用户凭证预置阶段不允许此操作");
    return current;
  }

  private assertVaultAvailable(identity: CredentialIdentity, vaultId: string): void {
    const key = credentialIdentityKey(identity);
    if (this.db.prepare("SELECT 1 FROM employee_credentials WHERE vault_id = ? AND identity_key <> ? LIMIT 1").get(vaultId, key)
      || this.db.prepare("SELECT 1 FROM employee_credential_provisioning WHERE vault_id = ? AND identity_key <> ? LIMIT 1").get(vaultId, key)) {
      throw new Error("原Vault已属于其他用户身份，不能在其中预置Credential");
    }
  }

  private save(previous: CredentialProvisioningRecord, record: CredentialProvisioningRecord): CredentialProvisioningRecord {
    validateRecord(record);
    const result = this.db.prepare(`UPDATE employee_credential_provisioning SET revision = ?, vault_id = ?, secret = ?
      WHERE identity_key = ? AND operation_id = ? AND revision = ?`).run(record.revision, record.vaultId ?? null, this.encode(record),
      credentialIdentityKey(previous.identity), previous.operationId, previous.revision);
    if (Number(result.changes) !== 1) throw new Error("用户凭证预置版本已变化，未覆盖原记录");
    return structuredClone(record);
  }

  private context(identityKey: string, operationId: string, revision: number): string {
    return JSON.stringify(["credential-provisioning", identityKey, operationId, revision]);
  }
  private encode(record: CredentialProvisioningRecord): string {
    return this.credentials.sealAuthorization(JSON.stringify(record), this.context(credentialIdentityKey(record.identity), record.operationId, record.revision));
  }
  private decode(row: Record<string, unknown>): CredentialProvisioningRecord {
    if (typeof row.secret !== "string" || row.secret.length > 32768 || typeof row.identity_key !== "string"
      || typeof row.operation_id !== "string" || !Number.isSafeInteger(row.revision)) throw new Error("用户凭证预置记录元数据无效");
    const clear = this.credentials.openAuthorization(row.secret, this.context(row.identity_key, row.operation_id, Number(row.revision)));
    let record: unknown;
    try { record = JSON.parse(clear); validateRecord(record); }
    catch { throw new Error("用户凭证预置加密记录结构无效"); }
    if (credentialIdentityKey(record.identity) !== row.identity_key || record.operationId !== row.operation_id
      || record.revision !== row.revision || (record.vaultId ?? null) !== row.vault_id) throw new Error("用户凭证预置记录与元数据不一致");
    return record;
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("SAVEPOINT credential_provisioning");
    try { const result = operation(); this.db.exec("RELEASE credential_provisioning"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO credential_provisioning; RELEASE credential_provisioning"); throw error; }
  }
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function provisioningVaultName(identity: CredentialIdentity): string {
  validateIdentity(identity);
  return `ark-employee-user-${sha256(credentialIdentityKey(identity)).slice(0, 40)}`;
}
const vaultName = provisioningVaultName;
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], "value"));
}
function validateIdentity(value: unknown): asserts value is CredentialIdentity {
  if (!exact(value, ["channelType", "installationId", "tenantId", "openId"]) || !Object.values(value).every(identifier)) {
    throw new Error("用户凭证预置身份无效");
  }
}
function validateRecord(value: unknown): asserts value is CredentialProvisioningRecord {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "phase")) throw new Error("用户凭证预置记录无效");
  const phaseDescriptor = Object.getOwnPropertyDescriptor(value, "phase");
  const phase = phaseDescriptor && Object.hasOwn(phaseDescriptor, "value") ? phaseDescriptor.value : undefined;
  if (typeof phase !== "string" || !Object.hasOwn(revisions, phase)) throw new Error("用户凭证预置记录阶段无效");
  const keys = [...commonKeys, ...(phase !== "vault_pending" ? ["vaultId"] : []),
    ...(["credential_pending", "ready", "completed"].includes(phase) ? ["credentialRequestedAt"] : []),
    ...(["ready", "completed"].includes(phase) ? ["credentialId"] : []),
    ...(phase === "completed" && Object.hasOwn(value, "initialAuthorizationGeneration") ? ["initialAuthorizationGeneration"] : [])];
  if (!exact(value, keys)) throw new Error("用户凭证预置记录字段组合无效");
  validateIdentity(value.identity);
  if (value.version !== 1 || typeof value.operationId !== "string" || !uuid.test(value.operationId)
    || value.revision !== revisions[phase as CredentialProvisioningPhase]
    || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) <= 0 || Number(value.createdAt) > Date.now()
    || value.vaultName !== vaultName(value.identity) || value.credentialName !== PROVISIONING_CREDENTIAL_NAME
    || (phase !== "vault_pending" && !identifier(value.vaultId))
    || (["credential_pending", "ready", "completed"].includes(phase) && (!Number.isSafeInteger(value.credentialRequestedAt)
      || Number(value.credentialRequestedAt) < Number(value.createdAt) || Number(value.credentialRequestedAt) > Date.now()))
    || (["ready", "completed"].includes(phase) && !identifier(value.credentialId))
    || (Object.hasOwn(value, "initialAuthorizationGeneration") && (typeof value.initialAuthorizationGeneration !== "string"
      || !uuid.test(value.initialAuthorizationGeneration)))
    || Buffer.byteLength(JSON.stringify(value), "utf8") > 16384) throw new Error("用户凭证预置记录结构或大小无效");
}
