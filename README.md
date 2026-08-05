# 飞书 Bot × 火山方舟 Managed Agents · 集成方案集

> 一个可运行的骨架 + 一组**客户场景案例库**：把飞书对话机器人接到火山方舟 Managed Agents（MA），并沉淀客户在使用 MA 过程中遇到的典型问题与解决方案。

飞书用户 @ Bot → 本地 Gateway（Python）→ 火山方舟 MA Session →（按场景）MCP Server。每个客户场景的具体问题、方案与演示，收录在 [docs/](docs/) 案例库；本 README 只讲**通用骨架**与**怎么起步**。

主体是 Python；只有「扫码创建飞书应用」这一步没有 Python 等价物，保留为一个 Node 小岛（子进程调用）。

## 案例库

| 案例 | 涉及能力 | 文档 |
| --- | --- | --- |
| **蔚来 MA 迁移 Demo** | 身份鉴权(static_bearer) · OpenID 透传 · 岗位信息注入 · 跨 Session 记忆 | [方案与运行说明](docs/MA迁移Demo-四卡点方案与运行说明.md) · [数据流转说明](docs/MA迁移Demo-四卡点数据流转说明.md) |

> 新增客户场景：在 [docs/](docs/) 下新建案例文档，并在本表登记。通用骨架（下面几节）保持稳定，案例只描述“在骨架的哪一环加了什么”。

## 通用架构

```text
飞书用户 ──@──> Bot（长连接收消息）
                 │
                 ▼
          本地 Gateway（Python）
   去重 · Session 复用 · 指令分发（/new /role /whoami /remember …）
                 │
                 ├── 创建 Session：environment_with_overrides（注入会话级环境变量）
                 │                 vault_ids（凭据，如 static_bearer）
                 │                 resources（挂载 Memory Store → /mnt/memory/）
                 ├── 发消息：user.message ＋（按需）system.message
                 ▼
      火山方舟 Managed Agents Session
                 │  连 MCP 时按凭据注入鉴权头
                 ▼
             MCP Server（按场景，公网可达）
```

各能力点如何落到具体客户问题上，见案例文档。

## 准备

- **conda**（管理 Python 环境）；
- 一个可用的**火山方舟 Managed Agents API Key**（`init` 掩码输入）；
- 一个能创建企业自建应用的**飞书账号**（用于扫码建应用）；
- 一个**内网穿透工具**（推荐 [cpolar](https://www.cpolar.com)，国内节点更稳；ngrok / frp 亦可），把本地 MCP 暴露成公网 HTTPS——方舟创建 `static_bearer` 等凭据时会**立即握手探测** MCP，不可达会直接失败。cpolar 安装（含 `brew trust` 授信、macOS Gatekeeper 信任等踩坑）见案例文档「启动 mock」一节。

## 快速开始

```bash
# 1) 环境
conda env create -f environment.yml
conda activate nio-ma-demo
pip install -e ".[dev]"          # 安装本包（arkagent / nio-mock-mcp 命令）
(cd node-helper && npm install)  # 装 Node 小岛依赖（registerApp 扫码用）
pytest -q                        # 确认环境就绪

# 2) 初始化（只扫一次码：建飞书应用 + 建 Agent/Vault/Environment，写 config）
arkagent init
arkagent doctor                  # 检查配置

# 3) 运行
arkagent run
```

各案例可能需要先起自己的 MCP（如蔚来案例的 mock）并暴露公网，再 `init`——以案例文档为准。

## `arkagent` CLI

| 命令 | 作用 |
| --- | --- |
| `arkagent init` | 首次初始化：掩码输入 API Key → 建 Agent（挂 `mcp_servers` + `mcp_toolset`）→ 扫码建飞书应用（仅 tenant 身份，无用户 OAuth）→ 建/复用 Vault + 凭据 → 建/复用 Environment → 写 `~/.arkagent/config.env`（目录 `0700`、文件 `0600`）。 |
| `arkagent doctor` | 检查配置完整性。 |
| `arkagent run` | 启动 Gateway，连飞书 WebSocket 收发消息。 |
| `arkagent update-agent` | **日常迭代**：改了 Agent 的 system prompt / 工具配置后，读 `config.env` 里现有 `ARK_AGENT_ID`，用最新配置原地更新（方舟 Agent 是版本化资源，更新生成新版本，**Agent ID 不变、飞书 Bot 不动**）。**不需要**重跑 `init` 重新扫码。 |

> 只在**首次**、或**换了 MCP 公网地址**（需把新 URL 写进 Agent 定义）时才需 `init`。仅换地址也可先改 `config.env` 的 `MCP_SERVER_URL` 再 `update-agent`。
>
> 本骨架去掉了早期 TS 项目的用户 OAuth——初始化**只扫一次码**（建应用），运行时用户 open_id 直接从飞书消息事件取。原 `lark-cli` + 用户 OAuth 能力如需可回看 git 历史。

## 配置项（`~/.arkagent/config.env`）

`init` 自动写入；也可参考 [.env.example](.env.example)。

| Key | 说明 |
| --- | --- |
| `ARK_API_KEY` | 方舟 API Key，Gateway 调用 MA API |
| `ARK_AGENT_ID` / `ARK_ENVIRONMENT_ID` / `ARK_VAULT_ID` | init 创建的资源 ID |
| `ARK_BASE_URL` | 方舟 API 基址（默认北京） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 扫码创建的飞书应用凭证（WebSocket 鉴权 + 发消息） |
| `MCP_SERVER_URL` | MCP 公网地址（含 `/mcp`） |
| `GATEWAY_DB_PATH` | SQLite 状态库（会话映射 / 事件去重 / 岗位缓存），默认 `./data/gateway.db` |
| `SESSION_TIMEOUT_MS` | 单次运行超时，默认 600000 |
| `ROLE_TTL_MS` | 岗位缓存 TTL，默认 86400000（24h） |
| `AUTHORIZED_OPEN_IDS` | 允许对话的 open_id 白名单（逗号分隔；**留空 = 不限制**） |
| `TEAM_STORE_ENABLED` | 是否为同岗位挂载团队共享 Memory Store（可选） |

配置目录 `0700`、文件 `0600`；不要在 Agent prompt 或日志中打印凭证。

## 消息与 Session 行为

- 单聊处理文本消息；群聊只处理明确 `@Bot` 的文本消息。
- 会话隔离键为 `(tenant_key, chat_id, thread_id, user_open_id)` 四元组：**不同发送者不复用 Session**（群里各人独立）；`/new` 显式重置当前会话。
- 新建 Session 会立即回复「正在处理」；复用 Session 仅在超过 ~2.5 秒未完成时提示一次。
- Gateway 不转发工具执行过程，只发处理中提示和最终结果。
- 图片、文件、富文本、交互卡片暂不处理。

## 项目结构

```text
arkagent/            # Python 主体
  cli.py             # init / doctor / run / update-agent 命令入口
  init.py            # 创建 Agent + Vault + 凭据 + Environment，写 config
  node_helper.py     # 以子进程调用 node-helper/register_app.mjs（扫码建应用）
  gateway.py         # 编排：去重 / Session 复用 / 指令分发 / 组装环境变量·凭据·记忆
  ark.py             # 火山方舟 Managed Agents httpx 客户端 + SSE
  feishu.py          # 飞书长连接接入与消息归一化、发送
  role.py            # 岗位缓存 + system.message 注入
  memory.py          # 每用户 / 团队 Memory Store
  store.py           # SQLite 状态
  config.py / paths.py / masked_input.py
mock_mcp/            # 示例 MCP Server（蔚来案例用，streamable-http）
  server.py          # 工具 + static_bearer 中间件
  data.py            # 按 open_id 分桶的演示数据
node-helper/         # 唯一保留的 Node 小岛
  register_app.mjs   # registerApp 扫码建飞书应用，把凭证写回 JSON
docs/                # 客户场景案例库
tests/               # pytest（asyncio_mode=auto）
```

## 开发

```bash
pytest -q            # 全量单测
python -m mock_mcp   # 本地起示例 mock MCP（不带 token 则不校验，仅本地调试）
```

## 参考资料

- [火山方舟：Managed Agents API](https://docs.volcengine.com/docs/82379/2555910?lang=zh)
- [飞书：一键创建飞书智能体应用](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)
- [飞书：使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)
</content>
