# Ark Agent Feishu Bot

> 一个方舟 API Key，把 Managed Agents 变成飞书个人助手或团队数字员工。

这是一个面向方舟 Managed Agents 的飞书接入插件。初始化向导会创建 Agent、Environment、Vault 和飞书应用，并启动通过 WebSocket 收消息的本地 Gateway；用户不需要手工拼接这些资源。

Gateway 默认使用飞书官方 `@larksuite/channel` 接收和归一化消息，并通过内部 Channel Adapter 接入 Managed Agents。Session、用户身份注入、OAuth、Vault 和审计仍由 arkagent 核心管理；会话与事件按 Channel 和应用实例隔离，为后续接入其他消息平台保留边界。若新版 Channel SDK 在特定网络环境下异常，可临时使用 `ARKAGENT_FEISHU_TRANSPORT=legacy arkagent`（数字员工命令同理）回退旧传输层。

当前提供两种相互隔离的运行模式：

| 模式 | 适合谁 | 飞书操作身份 | 初始化 | 启动 |
|---|---|---|---|---|
| 个人助手 | 个人使用 | 默认使用授权用户身份 | `arkagent init` | `arkagent` |
| 数字员工 | 团队或企业单实例部署 | 默认使用 Bot 身份，必要时按用户申请授权 | `arkagent employee init` | `arkagent employee` |

个人助手保存在 `~/.arkagent/`，数字员工保存在 `~/.arkagent/employee/`，两者可以在同一台机器上独立初始化和运行。

## 安装与升级

无需全局安装，直接运行最新版：

```bash
npx --yes arkagent@latest <command>
```

也可以全局安装；已经安装过时，用同一条命令升级：

```bash
npm install -g arkagent@latest
arkagent --help
```

本文后续使用较短的全局命令写法。如果不想全局安装，把每条命令中的 `arkagent` 换成 `npx --yes arkagent@latest` 即可。

## 最新命令速查

| 命令 | 作用 |
|---|---|
| `arkagent init` | 初始化个人助手并自动启动 Gateway |
| `arkagent` | 启动个人助手 Gateway |
| `arkagent login` | 复用现有资源，重新进行个人用户 OAuth |
| `arkagent doctor` | 检查个人助手配置 |
| `arkagent employee init` | 初始化数字员工并自动启动 Bot Gateway 与 WebUI |
| `arkagent employee` | 启动数字员工 Bot Gateway 与 WebUI |
| `arkagent employee doctor` | 检查数字员工配置 |
| `arkagent employee repair-environment` | 新建并切换到正确安装 `lark-cli` 的 Environment |

## 你会得到什么

运行一次 `npx --yes arkagent@latest init` 后，工具会自动完成四件事：

| 自动完成 | 结果 |
|---|---|
| 创建 Managed Agent | 新建“飞书办公助手（方舟 MA 版）”，内置 `lark-cli` 使用规则 |
| 创建飞书应用 | 配置机器人、消息事件和办公权限，不要求手填 App ID / App Secret |
| 配置用户身份 | 将短期 `user_access_token` 写入方舟 Vault Credential |
| 创建运行环境 | 安装 `lark-cli`，注入 App ID，并让新 Session 引用用户 Vault |

初始化完成后，你可以直接在飞书里让它创建文档、整理云空间内容、总结发送给 Bot 的文件，或执行其他已经授权的 `lark-cli` 办公任务。

## 个人助手 Quickstart

### 1. 准备

只需要：

- Node.js 22.13 或更高版本；
- 一个可用的火山方舟 Managed Agents API Key；
- 一个能够创建企业自建应用的飞书账号。

不需要提前准备 Agent、Environment、Vault、飞书 App ID 或 App Secret。

### 2. 一条命令初始化

```bash
npx --yes arkagent@latest init
```

向导只询问方舟 API Key，输入时以 `•` 提供反馈但不会显示原文。Base URL、`docs,drive` 权限域和 Environment 名称全部使用默认值。

随后完成两次扫码：

| 扫码 | 你确认什么 | 工具拿到什么 |
|---|---|---|
| 第一次 | 创建飞书智能体应用，并开通机器人、事件与用户权限 | App ID、App Secret、当前飞书用户 |
| 第二次 | 允许这个应用以你的用户身份调用 `lark-cli` | access token、refresh token、用户 open_id |

> 第一次扫码的页面可能把部分宽权限显示为“不支持自动开通”。可以继续下一步；第二个用户授权页面会展示并开通常用权限包。最终是否可用，以第二次授权完成后的实际调用为准。

每次执行 `init` 都会新建一个个人办公助手 Agent，不会搜索或复用已有 Agent。配置会直接覆盖写入 `~/.arkagent/config.env`。

### 3. 开始使用

初始化完成后，CLI 会自动启动 Gateway。看到“Gateway 已启动，正在通过飞书 WebSocket 接收消息”后，在飞书中找到刚创建的应用并发送消息。

以后需要重新启动时运行 `npx --yes arkagent@latest`；需要检查配置时运行 `npx --yes arkagent@latest doctor`。

如果飞书 `refresh_token` 过期，或需要换一个用户重新授权，不要再次初始化。运行：

```bash
npx --yes arkagent@latest login
```

`login` 会复用当前 App ID、App Secret、方舟 API Key、Vault 和 Credential，只重新执行一次用户 OAuth，并更新本地 OAuth 状态与 Vault 中的 `user_access_token`。它不会创建新的飞书 App、Agent 或 Environment。由于 Credential 只在 Session 创建时注入，登录成功后会自动废弃全部旧 Session 映射；重启 Gateway 后，下一条消息会创建使用新 token 的 Session。

可以先试：

```text
创建一篇标题为“办公助手测试”的飞书文档，正文写“lark-cli 已可用”，完成后把链接发给我。
```

也可以在与 Bot 的单聊中直接发送 PDF、Office 文档、Markdown、TXT 或图片。Markdown/TXT 会按 UTF-8 提取原文并直接放入本次消息（上限 256 KB）；其他文件会上传到方舟 Files，并以只读方式挂载到当前 Managed Agents Session。未附带文字指令时默认总结文件。二进制文件上限为 20 MB，实际可解析格式仍以方舟 Files API 支持范围为准。

`/new` 会清除当前飞书会话到方舟 Session 的映射；下一条消息将创建新 Session。

## 数字员工模式

数字员工模式是同一个 npm 包内的独立运行模式：使用 Bot 身份执行飞书操作，并提供已连接身份、使用者观测、审计日志和本地管理后台。它使用 `~/.arkagent/employee/`，不会覆盖个人助手配置。

初始化只需要方舟 API Key 和一次飞书扫码：

```bash
npx --yes arkagent@latest employee init
```

这次扫码会创建数字员工应用，并一次性声明当前版本所需的应用权限：消息收发、文档与云空间能力，以及 Bot 日历读取/创建权限。同时会为后续“按用户请求授权”预声明用户日历读取与忙闲权限。飞书可能要求企业管理员审核 Bot 日历权限；init 可以提交申请，但无法跳过或代替企业审核。建议等待应用权限审核通过后再测试日程创建。

初始化完成后自动启动 Bot Gateway 和 WebUI；以后重新启动运行：

```bash
npx --yes arkagent@latest employee
```

终端会打印两类运行信息：飞书 Bot 名称和 App ID，用于确认当前连接的是哪个 Bot；以及只监听本机的 WebUI 地址。WebUI 地址包含随机访问令牌，请不要转发或写入公开日志。

检查配置：

```bash
npx --yes arkagent@latest employee doctor
```

### 在对话中申请用户授权

数字员工默认使用 Bot 身份工作。只有任务确实需要读取用户的个人数据时，Gateway 才按当前消息发送者发起 OAuth。例如：

```text
帮我安排明天下午 3 点到 3 点半的测试日程，先检查我的日程冲突。
```

完整流程：

1. Gateway 根据日程意图发送“授权查看你的日程”卡片；
2. 用户点击卡片，以自己的飞书账号授权日历读取与忙闲权限；
3. Gateway 校验授权账号的 `open_id` 必须等于消息发送者；
4. 用户短期 access token 写入该用户独立的方舟 Vault，refresh token 留在本地；
5. Gateway 废弃旧 Session，用 Bot Vault + 当前用户 Vault 创建新 Session，并自动续跑原请求；
6. Agent 用 `--as user` 查询冲突，再用 `--as bot` 创建日程并将 `FEISHU_USER_OPEN_ID` 加为参会人。

用户不需要重新发送原消息，也不需要重新执行 `employee init`。不同用户分别授权、分别使用 Vault，不共享用户凭证。

数字员工不再维护第二套用户白名单。谁可以发现和使用 Bot，完全服从飞书应用的可用范围与禁用范围；企业希望接受范围外申请时，应在飞书管理后台开启原生的“允许不在可用范围内的成员申请使用应用”。凡是飞书成功投递到 Gateway 的消息都会进入 Managed Agents，WebUI 只记录实际使用者、使用次数和审计日志。

企业管理员配置路径：`飞书管理后台 > 工作台 > 应用管理 > 方舟数字员工 > 应用可用范围`。如果企业的应用管理规则已允许成员申请没有权限的应用，可在这里勾选“允许不在可用范围内的成员申请使用应用”。该开关属于企业管理策略，当前公开 OpenAPI 与一键创建 SDK 均没有提供自动设置字段，因此 init 只做明确引导，不尝试绕过管理员配置。

Bot 的 App Secret 保存在本地安全配置，用于 WebSocket 鉴权和刷新短期 `tenant_access_token`。Gateway 把短期 Bot token 写入方舟 Vault，以 `LARKSUITE_CLI_TENANT_ACCESS_TOKEN` 注入 Session；MA Session 不需要读取 App Secret。App ID 由 Environment 提供。当前消息发送者的 `open_id` 会作为 `FEISHU_USER_OPEN_ID` 覆写到 Session；只有该 Session 同时挂载了对应用户 Vault 时，才表示这个用户已经授权。

数字员工会显式申请 `im:message.p2p_msg:readonly` 与 `im:message.group_at_msg:readonly`，分别用于接收用户私聊和群聊中明确 @Bot 的消息；同时申请消息 Reaction、消息更新及 CardKit 权限。Gateway 收到请求后先在用户消息上添加 `Get` 表情，使用同一条流式消息逐步更新 Agent 回复，任务成功或失败后都会移除该表情。应用可用范围、原生申请和审批由飞书控制面统一管理，arkagent 不复制这套能力。

WebUI 首页是数字员工列表；点击员工后进入详情，通过「身份」「行为日志」「访问过的用户」查看该员工。身份页展示当前 Agent 已拥有的飞书 Bot 身份、认证方式、能力和授权范围；只展示方舟 Vault Credential 的脱敏引用，不会返回 App Secret 或 token。身份模型预留了 provider 和 identity type，后续可继续接入飞书用户身份及其他服务身份。「访问过的用户」只表示已经实际使用过 Bot 的用户，完整使用权限仍由飞书应用可用范围管理。

WebUI 默认只监听 `127.0.0.1:8787`，启动时会在终端打印带随机访问令牌的地址。数字员工配置和数据库分别位于：

```text
~/.arkagent/employee/config.env
~/.arkagent/employee/gateway.db
```

如果历史 Environment 的 `lark-cli` 原生二进制安装不完整，可重建环境：

```bash
arkagent employee repair-environment
```

该命令创建新 Environment 并更新本地配置；随后重新启动 `arkagent employee`。

### 最小验收流程

完成 `employee init` 且飞书权限审核通过后，建议按以下顺序验证：

1. 私聊 Bot 发送 `hi`，确认能收到最终回复且没有工具过程消息刷屏；
2. 发送“创建一篇测试飞书文档”，确认 Agent 使用 Bot 身份创建并返回链接；
3. 发送“先检查我明天下午 3 点是否有空，再创建 30 分钟日程并邀请我”；
4. 点击授权卡片完成用户日历只读授权，确认原任务无需重发即可自动继续；
5. 打开终端打印的 WebUI，检查「身份」「行为日志」「访问过的用户」三个 Tab。

### 数字员工默认权限

| 身份 | init 时声明的权限 | 是否还需后续动作 |
|---|---|---|
| Bot 消息 | `im:message:send_as_bot`、`im:message:readonly`、`im:message.reactions:write_only`、`im:message:update`、`cardkit:card:write`、`cardkit:card:read`、私聊与群聊 @Bot 事件 | 受飞书应用可用范围控制；新增权限可能需要管理员审核并重新发布应用 |
| Bot 日历 | `calendar:calendar`、`calendar:calendar.event:create`、`calendar:calendar.event:read` | 可能需要企业管理员审核 |
| Bot 文档/云空间 | `docs,drive` 对应权限 | 可能因企业策略需要审核 |
| 用户基础 | `offline_access`、`auth:user.id:read` | 每位用户首次使用时 OAuth |
| 用户日历读取 | `calendar:calendar:read`、`calendar:calendar.event:read`、`calendar:calendar.free_busy:read` | 按需授权，不授予写权限 |

因此，“权限能否在 init 一次申请好”的准确答案是：**应用需要哪些 scope 可以在 init 一次性声明；Bot scope 的管理员审核可以在 init 发起但未必即时完成；每位用户的数据访问同意不能由 init 代替，必须在该用户首次触发相应能力时单独 OAuth。**

### 已知的 Managed Agents 平台问题

本项目的真实联调暴露出以下 MA 平台体验问题：

- **Environment 更新不等于镜像重建**：修改 `setup_script` 后，新 Session 仍可能复用旧镜像；平台缺少明确的 rebuild、版本号和构建日志。
- **初始化脚本可观测性不足**：安装失败、网络阻塞和缓存复用难以区分，用户只能从 Agent 后续执行失败反推环境状态。
- **bash 启动不稳定且错误层次模糊**：多次出现“60 秒内未拿到 execution_id”，无法判断是调度排队、容器启动、命令执行还是网络问题。
- **Vault 占位符不适合所有凭证交换**：App Secret 以占位符注入后，依赖它在请求体中换取 Bot token 的 CLI 流程不可用；最终只能由 Gateway 在本地换取短期 tenant token 再写入 Vault。
- **Session 凭证是创建时快照**：OAuth 或 Credential 更新后，既有 Session 不会自动同步，只能废弃并重建。
- **运行时日期不可靠**：Agent 曾把“明天”解析成数月前日期；平台应提供可信的当前时间、时区上下文或标准时间工具。
- **事件与工具诊断接口偏底层**：排障需要手工读取大量 Session events，缺少面向开发者的 run trace、当前命令、耗时阶段和结构化失败原因。
- **长任务缺少稳定的用户反馈契约**：Session 可以运行数分钟，但 Gateway 只能自行轮询和设计超时/处理中消息，平台没有直接面向消息渠道的阶段性状态协议。

其中飞书 scope 审核、应用可用范围和逐用户 OAuth 属于飞书平台安全机制，不是 MA 缺陷；本项目通过 init 预声明、授权卡片和 Session 自动续跑来吸收这些复杂度。

## 两次扫码为什么不能合并

第一次扫码是在飞书开放平台创建并配置应用，解决“谁来接收消息”。第二次扫码是用户 OAuth，解决“Agent 代表谁操作文档和云空间”。

这两个身份不能混为一谈：Bot 身份可以收发消息，但看不到你的个人资源；用户身份可以访问你授权的办公数据，却不负责承载消息入口。

```text
飞书用户
  ├─ 扫码 1：创建应用 ──> Bot 接收消息
  └─ 扫码 2：用户授权 ──> lark-cli 操作个人资源

消息 ──> 本地 Gateway ──> Managed Agents Session
                              └─ Vault 注入 user_access_token
                                  └─ lark-cli --as user
```

## 默认权限

初始化默认选择 `docs,drive` 两个 `lark-cli` 业务域：

| 业务域 | OAuth scopes | 用途 |
|---|---|---|
| Bot 消息 | `im:message:send_as_bot`、`im:message:readonly`、`im:message.reactions:write_only`、`im:message:update`、`cardkit:card:write`、`cardkit:card:read` | 回复消息、流式更新和处理中表情 |
| 基础 | `offline_access`、`auth:user.id:read` | 刷新 token、确认授权用户 |
| docs | `docx:document`、`docx:document:create`、`docx:document:readonly`、`docx:document:write_only` | 创建、回读与更新飞书文档 |
| drive | `drive:drive`、`drive:file` | 访问云空间文件 |

当前版本只内置 `docs` 与 `drive`。如果办公助手返回 `missing_scopes`，需要扩展 `src/scopes.ts` 后重新运行初始化，以完成应用开通和用户增量授权。

## 凭证如何保存

| 凭证 | 保存位置 | 原因 |
|---|---|---|
| 方舟 API Key | `~/.arkagent/config.env` | Gateway 调用 Managed Agents API |
| App Secret | `~/.arkagent/config.env` | WebSocket 鉴权与 refresh token 刷新 |
| refresh token | `~/.arkagent/config.env` | 换取新的用户 access token |
| user access token | 方舟 Vault Credential | 仅在 Session 运行时以环境变量注入 |
| App ID | Environment 环境变量 | 供沙箱内的 `lark-cli` 使用 |
| 用户 open_id | 创建 Session 时的 Environment 覆写 | 取自当前飞书消息发送者，供 Agent 工具和 MCP 读取本次会话用户身份 |

配置目录权限为 `0700`，配置文件权限为 `0600`；Gateway 数据保存在 `~/.arkagent/gateway.db`。不要在 Agent prompt 或日志中打印凭证。

Gateway 会在 access token 距离过期不足 5 分钟时刷新 token，更新方舟 Credential，再原子更新本地 refresh token。

## 消息与 Session 行为

- 单聊中的文本、文件和图片消息会发送给绑定的 Agent。
- 群聊只处理明确 `@Bot` 的文本消息。
- 一个飞书用户在一个飞书会话中复用一个 Managed Agents Session；不同发送者不会复用 Session，`/new` 显式重置。
- 新建 Session 时，Gateway 会把当前消息 sender 的 `open_id` 作为 `FEISHU_USER_OPEN_ID` 动态覆写到 Environment；初始化时保存的授权用户 open_id 只用于 Gateway 访问控制，不作为沙箱运行时身份来源。
- 新建 Session 会立即回复一次“正在处理”；复用 Session 只有超过 2.5 秒仍未完成时才发送一次提示。
- Gateway 不向飞书转发 Agent 的工具执行过程，避免出现“执行进度：xxx”消息刷屏；只发送处理中提示和最终结果。
- Session 默认最多运行 10 分钟；临界超时后还会短暂回查事件历史。
- Markdown/TXT 原文直接内联到本次 Session 消息；其他单聊文件上传到方舟 Files，再只读挂载到 `/mnt/data/`。文件本体不写入 Gateway 数据库。
- 群聊文件、音视频、富文本与交互卡片暂不处理。

## Docker

```bash
docker build -t ark-agent-feishu-bot .
docker run --rm \
  --env-file .env \
  -v ark-feishu-data:/app/data \
  ark-agent-feishu-bot
```

必须持久化 `/app/data`。否则容器重建后会丢失会话映射和事件去重记录。

## 开发

```bash
npm install
npm test
npm run check
npm run build
npm pack --dry-run
```

| 文件 | 职责 |
|---|---|
| `src/cli.ts` | 个人助手与数字员工命令入口 |
| `src/init.ts` | 创建 Agent、Vault Credential、Environment 并写入配置 |
| `src/employee-init.ts` | 创建 Bot 身份数字员工及独立配置 |
| `src/identities.ts` | 可扩展的 Agent 已连接身份模型 |
| `src/web.ts` | 本地数字员工概览、已连接身份、实际使用者和审计 WebUI |
| `src/login.ts` | 复用现有资源重新授权，并更新本地 OAuth 状态和 Vault Credential |
| `src/oauth.ts` | 飞书 Device OAuth 与 token 刷新 |
| `src/channel.ts` | 与平台无关的 Channel 消息、资源、出站能力和适配器契约 |
| `src/lark-channel.ts` | 飞书 Channel SDK 适配器 |
| `src/feishu.ts` | 可回退的旧版飞书 WebSocket 接入 |
| `src/gateway.ts` | 跨 Channel 去重、Session 复用、身份注入与最终回复 |
| `src/ark.ts` | Managed Agents API 与 SSE 客户端 |
| `src/store.ts` | SQLite 会话、实际使用者和审计记录 |

## 当前边界

个人助手仍是单用户模式；数字员工模式使用飞书应用可用范围支持团队用户，并在本地记录实际使用者和审计日志。当前实现是单进程、单飞书应用和本地 SQLite，适合内聚插件及客户单实例部署，不是多租户托管平台，也不会代替飞书的应用权限控制面。

## 参考资料

- [飞书文档版：一个 API Key，两次扫码，认领你的飞书办公助手](https://bytedance.larkoffice.com/docx/M2mGdkHIHoGFYVx1nLzch6TvnIb)
- [飞书：一键创建飞书智能体应用](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)
- [飞书：使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)
- [火山方舟：Managed Agents API](https://docs.volcengine.com/docs/82379/2555910?lang=zh)
