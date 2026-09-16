import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ArkClient, EnvironmentConfig } from "./ark.ts";
import type { EmployeeConfig } from "./config.ts";
import { configFingerprint, finalizeSessionRequest, mergeSessionRequest, requestEnvironmentId, selectSessionRequest, type SessionConfiguration } from "./session-config.ts";

export function readLocalSessionEvidence(databasePath: string, sessionId: string): { fingerprint?: string; metadata?: Record<string, unknown> } {
  if (!existsSync(databasePath)) return {};
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_configuration'").get()) return {};
    const row = db.prepare("SELECT config_fingerprint, metadata FROM session_configuration WHERE session_id = ?").get(sessionId) as { config_fingerprint: string; metadata: string } | undefined;
    return row ? { fingerprint: row.config_fingerprint, metadata: JSON.parse(row.metadata) } : {};
  } finally { db.close(); }
}

function readKnownUserVaultIds(databasePath: string): string[] {
  if (!existsSync(databasePath)) return [];
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const ids = new Set<string>();
    for (const table of ["employee_oauth", "employee_credentials"]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
      for (const row of db.prepare(`SELECT DISTINCT vault_id FROM ${table}`).all() as { vault_id: string }[]) ids.add(row.vault_id);
    }
    return [...ids];
  } finally { db.close(); }
}

export async function collectEmployeeDiagnostics(options: {
  config: EmployeeConfig;
  configPath: string;
  sessionConfiguration: SessionConfiguration;
  sessionConfigurationPath?: string;
  sessionId?: string;
  version: string;
  executablePath: string;
  build?: { commit?: string; sourceHash?: string; dirty?: boolean };
  ark: Pick<ArkClient, "getAgent" | "getEnvironmentConfig" | "getSessionInfo">;
}) {
  const { config, ark, sessionConfiguration } = options;
  const warnings: string[] = [];
  let ok = true;
  let agent: { id: string; version?: string } | undefined;
  try { agent = await ark.getAgent(config.arkAgentId); } catch { ok = false; warnings.push("无法读取配置绑定的Agent，请检查账号、地域、权限或网络"); }
  const scopes = (["direct", "group", "thread"] as const).map(scope => {
    const request = selectSessionRequest(sessionConfiguration, scope);
    const selectedAgent = request.agent && typeof request.agent === "object" ? request.agent as Record<string, unknown> : undefined;
    const selectedAgentId = typeof request.agent === "string" ? request.agent : selectedAgent?.id || config.arkAgentId;
    if (selectedAgentId !== config.arkAgentId) { ok = false; warnings.push(`${scope} 的Agent绑定与Bot配置冲突`); }
    return {
      scope, environmentId: requestEnvironmentId(request) || config.arkEnvironmentId,
      agentId: selectedAgentId, agentVersion: selectedAgent?.version,
      hasSystemOverride: Boolean(selectedAgent && Object.hasOwn(selectedAgent, "system")),
      systemOverrideFingerprint: selectedAgent && Object.hasOwn(selectedAgent, "system") ? configFingerprint(selectedAgent.system) : undefined,
      fingerprint: configFingerprint({ agentId: config.arkAgentId, environmentId: config.arkEnvironmentId, vaultId: config.arkVaultId, appId: config.feishuAppId,
        scope, sharedGroup: true, configuration: sessionConfiguration, hookRevision: "none" })
    };
  });
  const environmentConfigs = new Map<string, EnvironmentConfig>();
  const environments = await Promise.all([...new Set(scopes.map(scope => scope.environmentId))].map(async id => {
    try {
      const environment = await ark.getEnvironmentConfig(id, { fresh: true });
      environmentConfigs.set(id, environment);
      const actualAppId = environment.env?.LARKSUITE_CLI_APP_ID;
      const appIdStatus = !actualAppId ? "missing_will_inject_for_new_session" : actualAppId === config.feishuAppId ? "match" : "conflict";
      if (appIdStatus === "conflict") ok = false;
      return { id, appId: actualAppId, appIdStatus };
    } catch { ok = false; return { id, appIdStatus: "unavailable" }; }
  }));
  const purposes = sessionConfiguration.vaultPurposes || {};
  const knownUserVaultIds = [...readKnownUserVaultIds(config.databasePath), ...Object.keys(purposes).filter(id => purposes[id] === "user")];
  for (const selected of scopes) {
    const inherited = environmentConfigs.get(selected.environmentId);
    if (!inherited) continue;
    const group = selected.scope !== "direct";
    const identity = group ? { FEISHU_IDENTITY_MODE: "bot_only", LARKSUITE_CLI_STRICT_MODE: "bot" } : {};
    const request = selectSessionRequest(sessionConfiguration, selected.scope);
    if (request.environment_id !== undefined) { request.environment = { id: request.environment_id, type: "environment_with_overrides" }; delete request.environment_id; }
    try {
      const draft = mergeSessionRequest({ agent: config.arkAgentId, environment: { id: selected.environmentId, type: "environment_with_overrides", config: { ...inherited, env: { ...inherited.env, ...identity } } } }, request);
      finalizeSessionRequest(draft, { agentId: config.arkAgentId, requiredVaultIds: [config.arkVaultId], appId: config.feishuAppId,
        mandatoryEnv: identity, sharedGroup: group, knownUserVaultIds,
        applicationVaultIds: Object.keys(purposes).filter(id => purposes[id] === "application") });
    } catch { ok = false; warnings.push(`${selected.scope} 的Session配置未通过身份、Vault或资源校验，Gateway启动时会拒绝该配置`); }
  }
  let session: Record<string, unknown> | undefined;
  if (options.sessionId) {
    try {
      const actual = await ark.getSessionInfo(options.sessionId);
      const local = readLocalSessionEvidence(config.databasePath, options.sessionId);
      const match = local.fingerprint ? scopes.some(scope => scope.fingerprint === local.fingerprint) : undefined;
      const appIdStatus = !actual.appId ? "missing_in_existing_session" : actual.appId === config.feishuAppId ? "match" : "conflict";
      if (actual.agentId && actual.agentId !== config.arkAgentId || appIdStatus === "conflict") ok = false;
      session = { ...actual, appIdStatus, configStatus: match === undefined ? "unknown_legacy_or_external" : match ? "match" : "changed_not_applied",
        originalConfigFingerprint: local.fingerprint,
        explicitSystemOverride: typeof local.metadata?.hasSystemOverride === "boolean" ? local.metadata.hasSystemOverride : "unknown" };
      if (match === false) warnings.push("新配置尚未应用于该Session；不会自动重建，/new不会继承旧沙箱文件");
    } catch { ok = false; warnings.push("无法读取指定Session或其本地证据，未修改任何资源"); }
  }
  return {
    ok, version: options.version, executablePath: options.executablePath, build: options.build || { status: "unavailable_source_run" },
    configPath: options.configPath, sessionConfigurationPath: options.sessionConfigurationPath,
    databasePath: config.databasePath, configuredAppId: config.feishuAppId, configuredAgentId: config.arkAgentId,
    agent, scopes, environments, botVaultId: config.arkVaultId, session,
    cliRuntime: { status: "not_probed", reason: "默认doctor只读控制面，不执行沙箱命令或Agent任务" }, warnings
  };
}
