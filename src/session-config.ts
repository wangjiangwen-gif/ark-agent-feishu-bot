import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import type { SessionCreateRequest, SessionResource } from "./ark.ts";

type RequestFields = Record<string, unknown>;
export type SessionScope = "direct" | "group" | "thread";
export type SessionConfiguration = {
  schemaVersion: 1;
  defaults?: { request: RequestFields };
  direct?: { request: RequestFields };
  group?: { request: RequestFields };
  thread?: { request: RequestFields };
  // 本地管理员的用途声明，不发送到MA；已知个人Vault不能被声明覆盖。
  vaultPurposes?: Record<string, "application" | "user">;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(value: unknown, path = "request"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`${path} 包含不允许的属性`);
    checkKeys(child, `${path}.${key}`);
  }
}

function validateFields(value: unknown): asserts value is RequestFields {
  if (!object(value)) throw new Error("Session request 必须是对象");
  checkKeys(value);
  if (value.vault_ids !== undefined && (!Array.isArray(value.vault_ids) || value.vault_ids.some(id => typeof id !== "string" || !id.trim()))) throw new Error("vault_ids 必须是非空字符串数组");
  if (value.resources !== undefined && (!Array.isArray(value.resources) || value.resources.some(item => !object(item) || typeof item.type !== "string" || !item.type))) throw new Error("resources 必须是包含type的对象数组");
  if (value.agent !== undefined && !(typeof value.agent === "string" && value.agent.trim()) && !(object(value.agent) && typeof value.agent.id === "string" && value.agent.id.trim() && typeof value.agent.type === "string")) throw new Error("agent 必须是ID字符串或原生Agent对象");
  if (value.environment_id !== undefined && (typeof value.environment_id !== "string" || !value.environment_id.trim())) throw new Error("environment_id 必须是非空字符串");
  if (value.environment !== undefined) {
    if (!object(value.environment)) throw new Error("environment 必须是对象");
    if (value.environment.id !== undefined && (typeof value.environment.id !== "string" || !value.environment.id.trim())) throw new Error("environment.id 必须是非空字符串");
    if (value.environment.config !== undefined) {
      if (!object(value.environment.config)) throw new Error("environment.config 必须是对象");
      const env = value.environment.config.env;
      if (env !== undefined && (!object(env) || Object.values(env).some(item => typeof item !== "string"))) throw new Error("environment.config.env 必须是字符串映射");
    }
    if (value.environment_id !== undefined && value.environment_id !== value.environment.id) throw new Error("environment_id 与 environment.id 冲突");
  }
}

export function loadSessionConfiguration(filename: string | undefined, configPath: string): { config: SessionConfiguration; path?: string; fingerprint: string } {
  if (!filename?.trim()) {
    const config: SessionConfiguration = { schemaVersion: 1 };
    return { config, fingerprint: configFingerprint(config) };
  }
  const path = resolve(dirname(configPath), filename);
  let value: unknown;
  try {
    if (statSync(path).size > 256 * 1024) throw new Error("oversize");
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // JSON解析错误可能携带密钥片段，不能原样输出。
    throw new Error("无法读取Session配置：请检查路径、JSON格式及256KB大小限制");
  }
  validateSessionConfiguration(value);
  return { config: value, path, fingerprint: configFingerprint(value) };
}

export function validateSessionConfiguration(value: unknown): asserts value is SessionConfiguration {
  if (!object(value) || value.schemaVersion !== 1) throw new Error("Session配置 schemaVersion 必须为1");
  checkKeys(value);
  const allowed = ["schemaVersion", "defaults", "direct", "group", "thread", "vaultPurposes"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error("Session配置包含未知顶层字段；原生MA字段应放入request");
  for (const key of ["defaults", "direct", "group", "thread"]) {
    if (value[key] === undefined) continue;
    const section = value[key];
    if (!object(section) || Object.keys(section).some(k => k !== "request")) throw new Error(`${key} 仅支持request对象`);
    validateFields(section.request);
  }
  if (value.vaultPurposes !== undefined && (!object(value.vaultPurposes) || Object.entries(value.vaultPurposes).some(([id, purpose]) => !id.trim() || !["application", "user"].includes(String(purpose))))) throw new Error("vaultPurposes 必须将Vault ID映射到application或user");
}

function deepMerge(base: RequestFields, next: RequestFields): RequestFields {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(next)) {
    // 显式空对象必须保留，例如MA的tos:{}不能被深合并还原成旧Bucket配置。
    result[key] = object(value) && Object.keys(value).length > 0 && object(result[key]) ? deepMerge(result[key], value) : structuredClone(value);
  }
  return result;
}

export function mergeSessionRequest(base: RequestFields, next: RequestFields): RequestFields {
  validateFields(base); validateFields(next);
  const prior = structuredClone(base);
  const patch = structuredClone(next);
  if (patch.environment !== undefined) {
    delete prior.environment_id;
    delete patch.environment_id;
    if (object(prior.environment) && object(patch.environment) && patch.environment.id && patch.environment.id !== prior.environment.id) delete prior.environment;
  } else if (patch.environment_id !== undefined) delete prior.environment;
  return deepMerge(prior, patch);
}

export function selectSessionRequest(config: SessionConfiguration | undefined, scope: SessionScope): RequestFields {
  if (!config) return {};
  validateSessionConfiguration(config);
  let request = config.defaults?.request || {};
  for (const key of scope === "thread" ? ["group", "thread"] as const : [scope]) request = mergeSessionRequest(request, config[key]?.request || {});
  return structuredClone(request);
}

export function configFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : object(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function requestEnvironmentId(request: RequestFields): string | undefined {
  return object(request.environment) && typeof request.environment.id === "string" ? request.environment.id
    : typeof request.environment_id === "string" ? request.environment_id : undefined;
}

export function assertEnvironmentAppId(env: Record<string, string> | undefined, appId: string | undefined): void {
  if (appId && env?.LARKSUITE_CLI_APP_ID && env.LARKSUITE_CLI_APP_ID !== appId) throw new Error("Environment的LARKSUITE_CLI_APP_ID与当前FEISHU_APP_ID冲突，请显式修正绑定");
}

export type SessionRequestPolicy = {
  agentId: string;
  requiredVaultIds: string[];
  mandatoryEnv: Record<string, string>;
  sharedGroup: boolean;
  appId?: string;
  applicationVaultIds?: string[];
  knownUserVaultIds?: string[];
  resources?: SessionResource[];
};

export function finalizeSessionRequest(request: RequestFields, policy: SessionRequestPolicy): SessionCreateRequest {
  validateFields(request);
  const result = structuredClone(request) as SessionCreateRequest;
  const agentId = typeof result.agent === "string" ? result.agent : result.agent?.id;
  if (agentId !== policy.agentId) throw new Error("Session的Agent必须与当前Bot配置绑定一致");
  const environmentId = requestEnvironmentId(result);
  if (!environmentId) throw new Error("Session缺少Environment绑定");
  const environment = result.environment || { id: environmentId, type: "environment_with_overrides", config: { type: "cloud" } };
  const env = { ...(environment.config?.env || {}) };
  assertEnvironmentAppId(env, policy.appId);
  const protectedEnv = { ...policy.mandatoryEnv, ...(policy.sharedGroup ? { FEISHU_IDENTITY_MODE: "bot_only", LARKSUITE_CLI_STRICT_MODE: "bot" } : {}) };
  for (const [key, value] of Object.entries(protectedEnv)) {
    if (env[key] !== undefined && env[key] !== value) throw new Error(`Session配置与受保护的身份字段${key}冲突`);
    env[key] = value;
  }
  if (policy.appId) env.LARKSUITE_CLI_APP_ID = policy.appId;
  if (policy.sharedGroup) {
    for (const key of ["LARKSUITE_CLI_USER_ACCESS_TOKEN", "LARKSUITE_CLI_USER_REFRESH_TOKEN", "FEISHU_USER_ACCESS_TOKEN", "FEISHU_REFRESH_TOKEN", "FEISHU_USER_OPEN_ID"]) {
      if (env[key]) throw new Error(`共享群Session不允许配置个人身份字段${key}`);
      delete env[key];
    }
  }
  result.environment = { ...environment, config: { type: "cloud", ...environment.config, env } };
  delete result.environment_id;
  result.vault_ids = [...new Set([...policy.requiredVaultIds, ...(result.vault_ids || [])])];
  if (policy.sharedGroup) {
    const allowed = new Set([...policy.requiredVaultIds, ...(policy.applicationVaultIds || [])]);
    for (const id of result.vault_ids) {
      if ((policy.knownUserVaultIds || []).includes(id) || !allowed.has(id)) throw new Error("共享群Session包含个人Vault或未声明为application用途的额外Vault");
    }
  }
  const unique = new Map<string, SessionResource>();
  const mounts = new Map<string, string>();
  for (const resource of [...(result.resources || []), ...(policy.resources || [])]) {
    const key = configFingerprint(resource);
    if (resource.mount_path !== undefined) {
      if (typeof resource.mount_path !== "string" || !posix.isAbsolute(resource.mount_path) || resource.mount_path.includes("\0")) throw new Error("资源挂载路径必须是有效绝对路径");
      const path = posix.normalize(resource.mount_path).replace(/\/$/, "") || "/";
      if (mounts.has(path) && mounts.get(path) !== key) throw new Error("不同资源使用了相同挂载路径");
      mounts.set(path, key);
    }
    unique.set(key, resource);
  }
  if (unique.size || result.resources !== undefined) result.resources = [...unique.values()];
  return result;
}
