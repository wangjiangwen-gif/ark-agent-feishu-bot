# 蔚来 MA 迁移 Demo · 飞书 Bot → 火山方舟 Managed Agents

> 一份「喂到嘴边」的可运行 Demo：把 FDE 建议清单里的四个客户卡点，直接在飞书对话界面里演示出来。

飞书用户 @ Bot → 本地 Gateway → 火山方舟 Managed Agents Session → mock NIO MCP Server。四个卡点全程在**与 Bot 的飞书会话**中演示，无需额外前端。

主体是 Python；只有「扫码创建飞书应用」这一步没有 Python 等价物，保留为一个 Node 小岛（子进程调用）。

## 四个卡点如何落地

| 卡点                        | 客户问题                                               | 本 Demo 方案                                                                                                                            | 归属                       |
| --------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **A** 身份鉴权        | NIO 私有签名接入 MCP                                   | **安全降级**：`static_bearer` 凭据 + open_id 白名单（**不是** NIO 私有签名，仅演示鉴权链路）                              | 客户侧适配                 |
| **B** 用户身份透传    | 把对话用户（非 Bot）的 open_id 透传到 MCP 做数据权限   | **会话级环境变量**：创建 Session 时用 `environment_with_overrides` 注入 `FEISHU_USER_OPEN_ID`，Agent 把它作为工具入参传给 MCP | 客户侧适配                 |
| **C** 岗位信息注入    | 岗位信息注入 system prompt 层，缓存 1 天，Session 不变 | Gateway 维护`(open_id, roleInfo, refreshedAt)` 缓存（24h TTL）；仅首轮 / 缓存 miss 后首访挂一次 `system.message`                    | C-1 客户侧 / C-2 MA 已支持 |
| **D** 跨 Session 记忆 | 岗位调动 / 换场景后记忆延续                            | 每用户专属 Memory Store，创建 Session 时经`resources` 挂到 `/mnt/memory/`（只读）；写入用 `/remember` 显式指令由应用侧调 API 写回 | 只读挂载/API 增删改 MA 已支持；「记什么、何时写」客户侧适配；对话自动抽取属 MA 未来 Feature |

> **卡点 B 的字段来源说明**：会话级环境变量注入未在方舟官方文档正文明写，但已由 MA 平台负责人口头确认「创建 Session 接口能传环境变量」且线下跑通。本 Demo 照此实现（见 [ark.py](arkagent/ark.py) 的 `create_session`）。若平台后续改为标准字段，改回对应字段即可。
>
> **卡点 A 是安全降级，不是 NIO 私有签名**：仅用 `static_bearer` + 白名单演示鉴权链路，勿向客户表述为「已实现 NIO 私有签名」。

## 架构

```text
飞书用户 ──@──> Bot（长连接收消息）
                 │
                 ▼
          本地 Gateway（Python）
   去重 · Session 复用 · /new /role /whoami 指令
                 │
                 ├── 创建 Session：environment_with_overrides={FEISHU_USER_OPEN_ID}  ← 卡点 B
                 │                 vault_ids=[static_bearer vault]                   ← 卡点 A
                 │                 resources=[memory_store → /mnt/memory/]           ← 卡点 D
                 ├── 发消息：user.message ＋（按需）system.message 岗位声明          ← 卡点 C
                 ▼
      火山方舟 Managed Agents Session
                 │  连 MCP 时注入 static Bearer（卡点 A）
                 ▼
        mock NIO MCP Server（公网可达）
     get_my_sales_data(open_id) · get_vehicle_info(model)
```

## 准备

- **conda**（管理 Python 环境）；
- 一个可用的**火山方舟 Managed Agents API Key**（验证时你需要提供，`init` 掩码输入）；
- 一个能创建企业自建应用的**飞书账号**（用于扫码建应用）；
- 一个**内网穿透工具**（本文用 [cpolar](https://www.cpolar.com)，国内节点更稳；ngrok / frp 亦可），把本地 mock MCP 暴露成公网 HTTPS 地址——方舟创建 `static_bearer` 凭据时会**立即握手探测** MCP，不可达会直接失败。

## 一、创建环境

```bash
conda env create -f environment.yml
conda activate nio-ma-demo
pip install -e ".[dev]"          # 安装本包（arkagent / nio-mock-mcp 命令）
(cd node-helper && npm install)  # 装 Node 小岛依赖（registerApp 扫码用）
```

跑一遍测试确认环境就绪：

```bash
pytest -q
```

## 二、启动 mock NIO MCP 并暴露公网

先在一个终端起 mock MCP（自带 A/B 演示数据）：

```bash
MCP_STATIC_BEARER="demo-bearer-token" MCP_HOST=127.0.0.1 MCP_PORT=8765 nio-mock-mcp
# 或：python -m mock_mcp
```

再用内网穿透把 `http://127.0.0.1:8765` 暴露成公网 HTTPS。以 cpolar 为例（首次使用需先 `cpolar authtoken <你的token>`，在 [cpolar 后台](https://dashboard.cpolar.com/auth) 获取，只需配置一次）：

```bash
cpolar http 8765
# 输出里找 Forwarding 的 https:// 地址，形如 https://xxxx.r6.cpolar.top
```

那么 **MCP Server 地址** = `https://xxxx.r6.cpolar.top/mcp`（注意末尾 `/mcp` 路径），**static Bearer** = 上面设置的 `demo-bearer-token`。

> **避坑一 · 地址末尾不要带斜杠**：填 `…/mcp`，**不要** `…/mcp/`。带尾斜杠会触发 307 重定向，方舟握手探测不跟随重定向 → `init` 报 424 失败。
>
> **避坑二 · 421 Misdirected Request**：FastMCP 默认开启 DNS rebinding 保护，只放行本机 Host，经穿透用外部域名访问会被判非法 Host 返回 421。本 Demo 的 mock 已在 [server.py](mock_mcp/server.py) 的 `build_server()` 关闭该保护（demo 场景），无需额外配置；若你换用别的 MCP，注意这一点。

> cpolar 免费版每次重启隧道公网域名会变；换了地址需重新 `arkagent init`，或改 `~/.arkagent/config.env` 里的 `MCP_SERVER_URL` 后 `arkagent update-agent`。

## 三、初始化（只扫一次码）

```bash
arkagent init
```

`init` 会依次：

1. 掩码输入**方舟 API Key**（以 `•` 回显，不显示原文）；
2. 输入 **mock MCP 公网地址** 与 **static Bearer token**；
3. 创建「蔚来销售助手（方舟 MA 版）」Agent（挂 `mcp_servers` + `mcp_toolset` 连 mock MCP，并启用 `agent_toolset` 以读 Memory Store）；
4. **扫码创建飞书应用**（Node 小岛，仅 tenant 身份 `im:message:send_as_bot` + `im.message.receive_v1` 事件，**无用户 OAuth**）；
5. 创建 / 复用 Vault，并创建 `static_bearer` 凭据（此时方舟会握手探测 MCP，所以第二步的地址必须已公网可达）；
6. 创建 / 复用 Environment；
7. 把配置安全写入 `~/.arkagent/config.env`（目录 `0700`、文件 `0600`）。

> 本 Demo 去掉了原 TS 项目的用户 OAuth——整个初始化**只扫一次码**（建应用）。运行时用户 open_id 直接从飞书消息事件取。原 `lark-cli` + 用户 OAuth 能力如需可回看 git 历史。

检查配置：

```bash
arkagent doctor
```

### 日常迭代：只更新 Agent（不重扫码）

改了 Agent 的 system prompt 或工具配置（[init.py](arkagent/init.py) 的 `build_nio_agent_config`）后，**不需要**重跑 `init` 重新扫码建应用——那样只会堆出一个新 Bot。直接：

```bash
arkagent update-agent
```

它读 `~/.arkagent/config.env` 里现有的 `ARK_AGENT_ID`，拉当前版本号，用最新配置原地 `PUT` 更新（方舟 Agent 是版本化资源，更新生成新版本，**Agent ID 不变、飞书 Bot 不动**）。更新后直接 `arkagent run` 即用新配置。

> 只在**首次**、或**换了 MCP 公网地址**（需把新 URL 写进 Agent 定义）时才需要重跑 `init`。仅换地址也可先改 `config.env` 的 `MCP_SERVER_URL` 再 `update-agent`。

## 四、启动 Gateway 并演示

```bash
arkagent run
```

看到「正在连接飞书 WebSocket」后，在飞书中找到刚创建的 Bot，按下面脚本逐个演示四个卡点。

### 聊天指令

| 指令                                | 作用                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `/whoami`                         | 查看当前缓存的岗位信息                                   |
| `/role 销售经理/上海浦东蔚来中心` | 模拟 HR 岗位调动（`岗位[/门店]`）→ 下一轮强制重注入   |
| `/remember <内容>`                | 把内容写入你的专属 Memory Store（卡点 D 的记忆写入链路） |
| `/new`                            | 开启新 Agent Session（演示卡点 D 的跨 Session 记忆延续） |

### 演示脚本

**卡点 A（static_bearer 鉴权 + 模型直调 MCP）**——问一个**只能靠 MCP 数据**回答的业务问题，逼模型真正调用远程工具；这条「模型直调 MCP + Bearer 校验」链路本身就是 A：

```text
查一下我的销售线索和本月业绩
```

> 别用「ET9 的续航和定位是多少」这类问题验 A——模型用自带知识就答了，不会调 MCP，看不到鉴权链路。要触发工具调用，必须问它**只能从 MCP 取到**的数据（如你的销售线索）。验证成功时 mock 日志会打出 `✅ static_bearer 校验通过` 和 `CallToolRequest`。

**卡点 B（OpenID 透传，按用户隔离数据）**——Bot 会用**你的** open_id 调 `get_my_sales_data` 拿到你专属的数据桶：

```text
查一下我的销售线索和本月业绩
```

> **真机必做**：你的真实飞书 open_id 默认不在 mock 白名单里，首次会被拒（回复「不在白名单」）。此时看 `arkagent run` 或 mock 日志里打印的你的 open_id（形如 `ou_...`），把它连同一份数据加进 [mock_mcp/data.py](mock_mcp/data.py) 的 `USER_DATA`，**重启 mock**（纯本地改动，无需重跑 init）后再问，即可拿到真实数据。
>
> 要直观展示「不同人拿到不同数据」，用**两个飞书账号**分别发同一句，看到各自的线索/KPI 不同即证明隔离。mock 内置 `ou-demo-manager`（销售经理）与 `ou-demo-sales`（销售顾问）两份不同数据可作参照。

**卡点 C（岗位信息注入 system prompt）**——先看当前岗位，再模拟调动，观察回答按新岗位权限/话术变化，且 **Session 不变**：

```text
/whoami
/role 销售经理/上海浦东蔚来中心
作为我现在的岗位，我能看团队整体的销售漏斗吗？
```

**卡点 D（跨 Session 记忆延续）**——用 `/remember` 显式写入长期记忆，再 `/new` 开新 Session，验证仍能从 `/mnt/memory/` 读到：

```text
/remember 我负责的重点客户是张先生，倾向 ET9，本周要跟进试驾。
/new
我上次说的重点客户是谁？倾向什么车型？
```

> **为什么必须用 `/remember` 而不是自然语言「记住…」**：方舟不会自动抽取对话记忆，且 Agent 对 `/mnt/memory/` **只读**——写记忆只能由应用侧调 API（`POST /memory_stores/{id}/memories`）。所以直接说「记住 X」并不会真正写回 Store，`/new` 后自然读不到。本 demo 用 `/remember <内容>` 显式触发写入：Gateway 把内容写成一条 note 存进你的专属 Memory Store，下个 Session（含 `/new` 后）挂载同一 Store 即可读到。「对话中自动抽取记忆」属于 MA 未来 Feature，当前需客户侧适配决定「记什么、何时写」。

## 配置项（`~/.arkagent/config.env`）

`init` 自动写入；也可参考 [.env.example](.env.example)。

| Key                                                          | 说明                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `ARK_API_KEY`                                              | 方舟 API Key，Gateway 调用 MA API                                                   |
| `ARK_AGENT_ID` / `ARK_ENVIRONMENT_ID` / `ARK_VAULT_ID` | init 创建的资源 ID                                                                  |
| `ARK_BASE_URL`                                             | 方舟 API 基址（默认北京）                                                           |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET`                    | 扫码创建的飞书应用凭证（WebSocket 鉴权 + 发消息）                                   |
| `MCP_SERVER_URL`                                           | mock MCP 公网地址（含`/mcp`）                                                     |
| `GATEWAY_DB_PATH`                                          | SQLite 状态库（会话映射 / 事件去重 / 岗位缓存），默认`./data/gateway.db`          |
| `SESSION_TIMEOUT_MS`                                       | 单次运行超时，默认 600000                                                           |
| `ROLE_TTL_MS`                                              | 岗位缓存 TTL，默认 86400000（24h）                                                  |
| `AUTHORIZED_OPEN_IDS`                                      | 允许对话的 open_id 白名单（逗号分隔；**留空 = 不限制**，鉴权交给 MCP 白名单） |
| `TEAM_STORE_ENABLED`                                       | 是否为同岗位挂载团队共享 Memory Store（卡点 D-3，可选）                             |

配置目录 `0700`、文件 `0600`；不要在 Agent prompt 或日志中打印凭证。

## 消息与 Session 行为

- 单聊处理文本消息；群聊只处理明确 `@Bot` 的文本消息。
- 一个用户在一个飞书会话中复用一个 MA Session；不同发送者不复用；`/new` 显式重置。
- 新建 Session 会立即回复「正在处理」；复用 Session 仅在超过 ~2.5 秒未完成时提示一次。
- Gateway 不转发工具执行过程，只发处理中提示和最终结果。
- 图片、文件、富文本、交互卡片暂不处理。

## 项目结构

```text
arkagent/            # Python 主体
  cli.py             # init / doctor / run 命令入口
  init.py            # 创建 NIO 销售助手 Agent + Vault + static_bearer 凭据 + Environment，写 config
  node_helper.py     # 以子进程调用 node-helper/register_app.mjs（扫码建应用）
  gateway.py         # 编排：去重 / Session 复用 / 指令 / 组装 B·C·D
  ark.py             # 火山方舟 Managed Agents httpx 客户端 + SSE
  feishu.py          # 飞书长连接接入与消息归一化、发送
  role.py            # 卡点 C：岗位缓存 + system.message 注入
  memory.py          # 卡点 D：每用户 / 团队 Memory Store
  store.py           # SQLite 状态
  config.py / paths.py / masked_input.py
mock_mcp/            # mock NIO MCP Server（streamable-http）
  server.py          # get_my_sales_data / get_vehicle_info + static_bearer 中间件
  data.py            # 按 open_id 分桶的演示数据
node-helper/         # 唯一保留的 Node 小岛
  register_app.mjs   # registerApp 扫码建飞书应用，把凭证写回 JSON
tests/               # pytest（asyncio_mode=auto）
```

## 开发

```bash
pytest -q            # 全量单测
python -m mock_mcp   # 本地起 mock MCP（不带 token 则不校验，仅本地调试）
```

## 参考资料

- [火山方舟：Managed Agents API](https://docs.volcengine.com/docs/82379/2555910?lang=zh)
- [飞书：一键创建飞书智能体应用](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)
- [飞书：使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)
