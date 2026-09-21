import type { ArkClient, CredentialMetadata, VaultMetadata } from "./ark.ts";
import type { CredentialIdentity } from "./credential-state.ts";
import type { GatewayStore } from "./store.ts";
import { createHash } from "node:crypto";
import { credentialIdentityKey } from "./credential-state.ts";
import { provisioningMetadata, provisioningVaultName, PROVISIONING_PLACEHOLDER, PROVISIONING_SECRET_NAME,
  type CredentialProvisioningRecord } from "./credential-provisioning-state.ts";

export type CredentialProvisioningArk = Pick<ArkClient,
  "listVaults" | "listCredentials" | "createVault" | "createEnvironmentVariableCredential">
  & Partial<Pick<ArkClient, "getVault" | "getCredential">>;

// 调用者必须持有完整用户身份的维护租约。本函数只确认预置资源，不能恢复原业务消息。
export async function provisionUserCredential(store: GatewayStore, ark: CredentialProvisioningArk,
  identity: CredentialIdentity, assertActive: () => void, expectedOperationId?: string): Promise<{ vaultId: string; credentialId: string }> {
  const journal = store.credentialProvisioning;
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive(); const result = await operation(); assertActive(); return result;
  };
  try {
    assertActive();
    if (expectedOperationId !== undefined && (typeof expectedOperationId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(expectedOperationId))) throw unconfirmed();
    let record = journal.get(identity);
    if (record && expectedOperationId !== undefined && record.operationId !== expectedOperationId) throw unconfirmed();
    let vaultVerified = false, credentialVerified = false;
    if (!record) {
      const externalUserId = createHash("sha256").update(credentialIdentityKey(identity)).digest("hex");
      const name = provisioningVaultName(identity);
      const vaults = await checked(() => ark.listVaults());
      // 没有原操作记录的远端资源可能含有已授权Token；名称相同不能证明归属。
      if (!Array.isArray(vaults) || vaults.some(v => v.displayName === name || v.metadata?.external_user_id === externalUserId)) throw unconfirmed();
      record = journal.begin(identity, expectedOperationId);
      const id = await checked(() => ark.createVault(record!.vaultName, provisioningMetadata(record!, "vault")));
      record = journal.confirmVault(record, id);
      vaultVerified = true;
    } else if (record.phase === "vault_pending") {
      const vaults = await checked(() => ark.listVaults());
      const expected = provisioningMetadata(record, "vault");
      const related = vaults.filter(v => v.displayName === record!.vaultName
        || v.metadata?.external_user_id === expected.external_user_id
        || v.metadata?.arkagent_provision_operation === record!.operationId);
      if (related.length !== 1 || !validVault(related[0], record)) throw unconfirmed();
      const id = related[0].id;
      await verifyVault(record, id, related[0]);
      record = journal.confirmVault(record, id);
      vaultVerified = true;
    }

    if (!record.vaultId || record.phase === "completed") throw unconfirmed();
    if (!vaultVerified) await verifyVault(record, record.vaultId);

    if (record.phase === "vault_confirmed") {
      const existing = await checked(() => ark.listCredentials(record!.vaultId!));
      // 首次Credential写入只允许空的专属Vault，避免挂载未识别的其他凭证。
      if (!Array.isArray(existing) || existing.length) throw unconfirmed();
      record = journal.beginCredential(record);
      const id = await checked(() => ark.createEnvironmentVariableCredential(record!.vaultId!, record!.credentialName,
        PROVISIONING_SECRET_NAME, PROVISIONING_PLACEHOLDER, provisioningMetadata(record!, "credential")));
      record = journal.confirmCredential(record, id);
      credentialVerified = true;
    } else if (record.phase === "credential_pending" || record.phase === "ready") {
      const existing = await checked(() => ark.listCredentials(record!.vaultId!));
      if (!Array.isArray(existing) || existing.length !== 1 || !validCredential(existing[0], record)
        || (record.credentialId && existing[0].id !== record.credentialId)) throw unconfirmed();
      const id = existing[0].id;
      if (!ark.getCredential) throw unconfirmed();
      const detail = await checked(() => ark.getCredential!(record!.vaultId!, id));
      if (!validCredential(detail, record) || detail.id !== id || !sameCreation(existing[0], detail)) throw unconfirmed();
      if (record.phase === "credential_pending") record = journal.confirmCredential(record, id);
      credentialVerified = true;
    }
    if (record.phase !== "ready" || !credentialVerified || !record.credentialId) throw unconfirmed();
    assertActive();
    const completed = journal.complete(record);
    return { vaultId: completed.vaultId!, credentialId: completed.credentialId! };

    async function verifyVault(original: CredentialProvisioningRecord, id: string, listed?: VaultMetadata): Promise<void> {
      if (!ark.getVault) throw unconfirmed();
      const detail = await checked(() => ark.getVault!(id));
      if (!validVault(detail, original) || detail.id !== id || (listed && !sameCreation(listed, detail))) throw unconfirmed();
    }
  } catch {
    // 创建响应丢失与尚未发出请求无法安全区分：保留原pending，不重POST、不转发上游秘密正文。
    throw unconfirmed();
  }
}

function validVault(vault: VaultMetadata, record: CredentialProvisioningRecord): boolean {
  return Boolean(vault && identifier(vault.id) && vault.type === "vault" && vault.displayName === record.vaultName
    && (!record.vaultId || vault.id === record.vaultId) && matches(vault.metadata, provisioningMetadata(record, "vault"))
    && unchanged(vault, record.createdAt));
}
function validCredential(credential: CredentialMetadata, record: CredentialProvisioningRecord): boolean {
  return Boolean(credential && identifier(credential.id) && credential.type === "vault_credential"
    && credential.vaultId === record.vaultId && credential.displayName === record.credentialName
    && credential.authType === "environment_variable" && credential.secretName === PROVISIONING_SECRET_NAME
    && credential.networking?.type === "unrestricted"
    && (credential.networking.allowed_hosts === undefined || (Array.isArray(credential.networking.allowed_hosts) && !credential.networking.allowed_hosts.length))
    && matches(credential.metadata, provisioningMetadata(record, "credential"))
    && unchanged(credential, record.credentialRequestedAt!));
}
function matches(actual: Record<string, unknown> | undefined, expected: Record<string, string>): boolean {
  return Boolean(actual && Object.entries(expected).every(([key, value]) => actual[key] === value));
}
function unchanged(resource: { createdAt?: string; updatedAt?: string }, requestedAt: number): boolean {
  const created = timestamp(resource.createdAt), updated = timestamp(resource.updatedAt);
  // secret_value不可回读，只接纳创建后未被修改的原资源；时间偏差超过30秒时交由人工核查。
  return resource.createdAt === resource.updatedAt && Number.isFinite(created) && created === updated && Number.isFinite(requestedAt)
    && created >= requestedAt - 30_000 && created <= Date.now() + 30_000;
}
function sameCreation(listed: { createdAt?: string }, detail: { createdAt?: string }): boolean {
  // 不用Date.parse比较相等性：它会截断MA返回的微秒/纳秒差异。
  return listed.createdAt === detail.createdAt;
}
function timestamp(value: unknown): number {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value);
}
function unconfirmed(): Error {
  return new Error("用户凭证预置结果尚未确认，未重复创建或采用归属不明的凭证；请核查原操作后恢复");
}
