import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentConfig, ArkClient } from "./ark.ts";
import type { Ask } from "./init.ts";
import { DEFAULT_ARK_BASE_URL, DEFAULT_LARK_DOMAINS, serializeEnv } from "./init.ts";
import { resolveLarkBotScopes } from "./scopes.ts";
import { EMPLOYEE_CALENDAR_USER_SCOPES } from "./employee-auth.ts";

export const EMPLOYEE_AGENT_NAME = "飞书数字员工（方舟 MA 版）";

export const EMPLOYEE_AGENT_CONFIG: AgentConfig = {
  name: EMPLOYEE_AGENT_NAME,
  description: "使用 Bot 身份为获准用户处理飞书文档、云空间及团队办公任务",
  model: { id: "doubao-seed-2-1-pro-260628" },
  system: `你是团队的飞书数字员工，帮助获准用户处理飞书文档、云空间和办公任务。

运行环境已全局安装 lark-cli，并注入 Bot 身份凭证。单聊 Session 还可能注入经当前消息发送者授权的用户身份；群聊 Session 永远不注入用户身份。

决策顺序（最高优先级，先于下面所有工具规则）：
1. 意图判断优先于工具调用。寒暄、能力咨询或缺少明确目标时直接回答，不调用任何工具。
2. 用户使用含糊说法、内部术语，或目标、对象、操作任一不明确时，只提出一个简洁的澄清问题；不得通过执行命令猜测用户意图。
3. 只有任务及其业务域已经明确，且确实需要读取或修改飞书数据时，才允许调用 lark-cli。
4. 禁止运行 lark-cli skills list、lark-cli --version 或其他能力枚举、安装检测、版本探测命令。仅在业务域明确后读取与任务直接匹配的 Skill。
5. 工具调用超时或失败后，不得改用相似的探测命令继续尝试，也不得重复原命令；应根据已有错误向用户说明或提出必要的澄清问题。
6. 单一、非批量的查询或写入任务优先控制在两次 lark-cli 调用以内（一次读取 Skill、一次业务命令）；群成员批量忙闲、创建后授权等明确的多步任务可按成员和必要步骤有界调用，但不得重复读取同一信息。

执行飞书任务时：
1. 先读取 FEISHU_CONVERSATION_TYPE 和 FEISHU_IDENTITY_MODE 判断身份边界。群聊（group / bot_only）始终只使用 Bot 身份，任何命令都显式使用 --as bot，禁止 --as user、禁止申请用户授权。单聊（direct / bot_with_user_oauth）默认使用 Bot 身份，只有规则明确允许时才可切换用户身份。首次处理某业务域且本提示词未给出确定命令时，读取准确命名的内置 Skill：即时通信用 lark-cli skills read lark-im，Wiki 用 lark-cli skills read lark-wiki，云文档用 lark-cli skills read lark-doc，云空间用 lark-cli skills read lark-drive，日历用 lark-cli skills read lark-calendar。skills read 命令本身不得附加 --as。不要猜测 im、wiki、docx 等缩写 Skill 名。同一 Session 已读取过该 Skill，或本提示词已经给出可直接使用的确定命令时，跳过重复读取。
2. 优先使用 lark-cli 的 +shortcut；没有合适 shortcut 时再查询 schema 后调用原生资源命令。
3. 禁止运行 auth login、npx @larksuite/cli、重复安装 CLI 或联网探测版本。
4. 单聊默认所有飞书操作显式使用 --as bot；只有读取发起人的个人日程、忙闲或用于身份识别时，才允许显式使用 --as user，且不得用用户身份执行写操作。群聊不适用这一例外，始终只使用 Bot 身份。
5. 单聊约日程时，可先用 --as user 查询发起人的日程或忙闲，再用 --as bot 创建日程，并将 FEISHU_USER_OPEN_ID 作为参与人加入。若 lark-cli 返回 authentication/token_missing，立即停止当前任务并把错误原样留给 Gateway 处理；不得运行 lark-cli auth login、不得改用 Bot 身份读取个人私有数据、不得自行重试或向用户编造授权方式。
6. FEISHU_USER_OPEN_ID 是本次消息发起人的身份标识；只有同时存在用户凭证时才代表该用户已授权。
7. 不读取、不打印、不写入任何 Token、App Secret 或其他凭证值。用户询问访问身份或凭证时，可以说明凭证类型和来源：Bot 身份使用应用的 tenant access token，用户身份使用当前发送者授权后注入的 user access token；不得因此拒绝回答，也不得展示实际值。
8. lark-cli 标记为 high-risk-write 的操作必须先向用户确认。若用户已经明确要求“创建文档并授权给当前群成员”，这本身就是对该具体授权范围的确认，可在成功创建后为当前群成员执行带 --yes 的权限命令；不得扩展到群外用户或更高权限。
9. 当前飞书位置通过 FEISHU_CHAT_ID、可选的 FEISHU_THREAD_ID 和 FEISHU_TRIGGER_MESSAGE_ID 注入。输入已包含近期会话快照时，不得再次读取相同范围；只有任务确实依赖更早记录时，普通群使用 lark-cli im +chat-messages-list --chat-id "$FEISHU_CHAT_ID" --as bot，话题使用 lark-cli im +threads-messages-list --thread "$FEISHU_THREAD_ID" --as bot。
10. 已知的确定命令直接执行，不先读 Skill、不查看 help：
   - 查询当前群成员：lark-cli im +chat-members-list --chat-id "$FEISHU_CHAT_ID" --as bot --page-all。
   - 查询某位群成员的闲忙：lark-cli calendar +freebusy --as bot --user-id "<成员 open_id>" --start "<RFC3339>" --end "<RFC3339>"。这里只能据忙闲时间段判断是否有冲突，不得声称读取到了日程标题、描述或参与人；多人时先取群成员，再对目标成员有界查询。
   - 读取群里分享的 /wiki/ 或 /docx/ 链接：lark-cli docs +fetch --doc "<用户原始链接>" --as bot。若 Bot 没有该文档权限，应如实提示分享者将文档授权给应用/Bot，不得申请用户 UAT 绕过。
   - 以 Bot 身份创建文档：首次创建前按 lark-doc 要求读取 references/lark-doc-create.md 和 references/lark-doc-xml.md，再执行 lark-cli docs +create --content '<title>标题</title><text>正文</text>' --as bot。
   - 将新文档授权给当前群成员：首次授权前读取 lark-drive 的 references/lark-drive-member-add.md，再执行 lark-cli drive +member-add --token "<新文档 URL 或 token>" --member-id "$FEISHU_CHAT_ID" --member-type openchat --perm edit --as bot --yes，将当前群作为协作者；不得擅自授权群外用户。
   参数报错或缺少权限时直接依据错误说明，不再运行 help、能力枚举或替代探测命令。
11. 群成员是否能向你发消息、应用是否对其可见，可用范围由飞书平台的应用可用范围和事件投递决定；Gateway 不维护额外用户白名单。不要声称只服务 init 扫码者，也不要把“能收到消息”和“能访问某项飞书资源”混为一谈。
12. 默认先用 Bot 身份访问团队资源；如果 Bot 已能读取用户分享的文档，不需要额外申请用户授权。只有单聊任务确实依赖发起人的私有数据且 Bot 无权访问时，才允许触发对应的用户授权；群聊中遇到相同情况只说明 Bot 权限边界或建议转为私聊，不发授权卡片。
13. 完成后返回结果摘要和可访问的飞书链接。`,
  tools: [{ type: "agent_toolset_20260701" }],
  skills: [],
  mcp_servers: [],
  metadata: { created_via: "ark-agent-feishu-bot", scenario: "team-digital-employee", capabilities_version: "employee-group-bot-v2" }
};

type EmployeeArk = Pick<ArkClient,
  "createAgent" | "listEnvironments" | "createEnvironment" | "listVaults" | "createVault" |
  "listCredentials" | "createEnvironmentVariableCredential" | "updateEnvironmentCredential"
>;

export async function runEmployeeInit(options: {
  askSecret: Ask;
  createArk: (apiKey: string, baseUrl: string) => EmployeeArk;
  createFeishuApp: (botScopes: string[], userScopes: string[]) => Promise<{ appId: string; appSecret: string }>;
  envPath: string;
  gatewayDatabasePath: string;
}): Promise<{ agentId: string; environmentId: string; environmentCreated: boolean; envPath: string; webToken: string }> {
  const arkApiKey = (await options.askSecret("方舟 API Key")).trim();
  if (!arkApiKey) throw new Error("方舟 API Key 不能为空");
  const arkBaseUrl = DEFAULT_ARK_BASE_URL.replace(/\/$/, "");
  const ark = options.createArk(arkApiKey, arkBaseUrl);
  const agent = await ark.createAgent(EMPLOYEE_AGENT_CONFIG);
  const botScopes = resolveLarkBotScopes(DEFAULT_LARK_DOMAINS);
  const app = await options.createFeishuApp(botScopes, EMPLOYEE_CALENDAR_USER_SCOPES);

  const vaultBaseName = `ark-employee-${sanitizeName(agent.id)}-${sanitizeName(app.appId)}`;
  const vaultName = vaultBaseName.slice(0, 100);
  const vaults = await ark.listVaults();
  let vault = vaults.find(item => item.displayName === vaultName);
  if (!vault) vault = { id: await ark.createVault(vaultName), displayName: vaultName };
  else {
    const legacyCredentials = await ark.listCredentials(vault.id);
    if (legacyCredentials.some(item => item.secretName === "LARKSUITE_CLI_TENANT_ACCESS_TOKEN")) {
      // 早期版本曾把短效 TAT 写入 Vault。lark-cli 会优先使用它，从而遮蔽仍然有效的
      // App Secret，并在两小时后持续返回 Invalid access token。保留旧 Vault 供回滚，
      // 新 init 改绑到只含 App Secret 的干净 Vault。
      const cleanVaultName = `${vaultBaseName.slice(0, 86)}-app-secret-v2`;
      vault = vaults.find(item => item.displayName === cleanVaultName)
        || { id: await ark.createVault(cleanVaultName), displayName: cleanVaultName };
    }
  }
  const credentialName = "lark-cli-bot-app-secret";
  let credential = (await ark.listCredentials(vault.id)).find(item => item.displayName === credentialName && item.authType === "environment_variable" && item.secretName === "LARKSUITE_CLI_APP_SECRET");
  if (credential) await ark.updateEnvironmentCredential(vault.id, credential.id, app.appSecret);
  else credential = {
    id: await ark.createEnvironmentVariableCredential(vault.id, credentialName, "LARKSUITE_CLI_APP_SECRET", app.appSecret),
    displayName: credentialName, authType: "environment_variable"
  };

  const environmentName = `ark-employee-${sanitizeName(agent.id)}-${sanitizeName(app.appId)}`.slice(0, 60);
  let environments = await ark.listEnvironments();
  let environment = environments.find(item => item.name === environmentName);
  let environmentCreated = false;
  if (!environment) {
    try {
      environment = await ark.createEnvironment(environmentName, app.appId);
      environmentCreated = true;
    } catch (error) {
      environments = await ark.listEnvironments();
      environment = environments.find(item => item.name === environmentName);
      if (!environment) throw error;
    }
  }

  const webToken = randomBytes(24).toString("base64url");
  const content = serializeEnv({
    ARKAGENT_MODE: "employee", ARK_API_KEY: arkApiKey, ARK_AGENT_ID: agent.id,
    ARK_ENVIRONMENT_ID: environment.id, ARK_VAULT_ID: vault.id, ARK_CREDENTIAL_ID: credential.id,
    ARK_BASE_URL: arkBaseUrl, FEISHU_APP_ID: app.appId, FEISHU_APP_SECRET: app.appSecret, FEISHU_BOT_NAME: "方舟数字员工",
    GATEWAY_DB_PATH: options.gatewayDatabasePath,
    SESSION_TIMEOUT_MS: "600000", ARKAGENT_WEB_HOST: "127.0.0.1", ARKAGENT_WEB_PORT: "8787",
    ARKAGENT_WEB_TOKEN: webToken
  });
  await mkdir(dirname(options.envPath), { recursive: true, mode: 0o700 });
  await writeFile(options.envPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(options.envPath, 0o600);
  return { agentId: agent.id, environmentId: environment.id, environmentCreated, envPath: options.envPath, webToken };
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}
