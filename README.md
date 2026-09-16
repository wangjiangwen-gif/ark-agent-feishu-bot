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

`login` 会复用当前 App ID、App Secret、方舟 API Key、Vault 和 Credential，只重新执行一次用户 OAuth，并更新本地 OAuth 状态与 Vault 中的 `user_access_token`。它不会创建新的飞书 App、Agent 或 Environment。个人助手允许在登录时切换授权用户，因此登录成功后仍会主动废弃全部旧 Session 映射，避免新旧用户上下文混用；重启 Gateway 后，下一条消息会创建新 Session。

可以先试：

```text
创建一篇标题为“办公助手测试”的飞书文档，正文写“lark-cli 已可用”，完成后把链接发给我。
```

也可以在与 Bot 的单聊中直接发送 PDF、Office 文档、Markdown、TXT 或图片。Markdown/TXT 会按 UTF-8 提取原文并直接放入本次消息（单轮合计上限 256 KB）；其他文件会上传到方舟 Files，并以只读方式挂载到当前 Managed Agents Session。同名文件使用独立子目录，不会互相遮盖。未附带文字指令时默认总结文件。二进制文件单个上限为 20 MB，单轮附件总量上限为 40 MB，实际可解析格式仍以方舟 Files API 支持范围为准。某个附件失败时，其他可用附件与文字请求仍继续处理，并在回复中明确告知失败文件。

`/compact` 会调用 Managed Agents 内置能力，在当前 Session 内压缩上下文，Session ID、挂载资源和会话映射保持不变。Gateway 也会在上下文达到阈值时自动执行同样的原地压缩。`/new` 会清除当前飞书会话到方舟 Session 的映射；下一条消息将创建新 Session。

源码开发版（尚未发布 npm）增加持久化压缩检查点：只有新业务请求和新上下文样本才可能触发自动压缩，默认冷却 5 分钟，连续两次明确失败后暂停自动压缩。升级前的旧 Session 先建立统计基线，不立即用全部旧历史触发压缩。重启后的未决尝试先查询原事件，不盲目重发；运行结果仍未确定时不会继续投递业务消息。

压缩成功同时要求本轮正常结束和原生 `agent.thread_context_compacted` 事件，单独 `idle` 或模型声称“已压缩”不算完成。缺少证据时提示“结果尚未确认”，暂停自动重复压缩并保留原 Session。多 MA 线程的整体压缩确认尚未验收，不把某个子线程的完成事件当作全会话完成。

Gateway 会保存已接收的 Markdown/TXT 原文，原地压缩后在下一轮恢复近期原文（仍受单轮 256 KB 限制，超出时明确提示）。重启 Gateway 会复用数据库中的 Session 与附件记录，不会重复上传已记录的文件。**新 Session 的文件与沙箱状态迁移尚未实现**：`/new` 后不要假设旧文件仍可直接访问。沙箱长期休眠、回收后的持久性也不能由本地 Gateway 保证。

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

数字员工默认使用 Bot 身份工作。单聊任务确实需要读取用户个人数据时，Agent 调用 `lark-cli --as user`；只有工具返回结构化 `token_missing`，Gateway 才按当前消息发送者发起 OAuth，不依赖关键词猜测。例如：

```text
帮我安排明天下午 3 点到 3 点半的测试日程，先检查我的日程冲突。
```

完整流程：

1. 用户首次单聊时，Gateway 预先创建该用户独立的 Vault 和占位 Credential，并在创建 Session 时完成挂载；
2. Agent 调用用户身份工具，`lark-cli` 返回结构化 `token_missing`；Gateway 发送“授权查看你的日程”卡片；
3. 用户点击卡片，以自己的飞书账号授权日历读取与忙闲权限；
4. Gateway 校验授权账号的 `open_id` 必须等于消息发送者；
5. 用户短期 access token 更新到已挂载的 Credential，refresh token 留在本地；
6. Gateway 在同一个 Session 中自动续跑原请求，不做 Session handoff；
7. Agent 用 `--as user` 查询冲突，再用 `--as bot` 创建日程并将 `FEISHU_USER_OPEN_ID` 加为参会人。

用户不需要重新发送原消息，也不需要重新执行 `employee init`。不同用户分别授权、分别使用 Vault，不共享用户凭证。

#### 源码开发版：凭证刷新与安全迁移（尚未发布 npm）

- 每轮单聊都会检查已授权凭证，包括复用已有 Session 的消息；群聊不执行用户刷新，未授权的普通问候不发起 OAuth。
- 凭证按 Channel、App ID、租户、OpenID 四项绑定；授权完成后核对用户与租户，防止错账号写入。一个用户 Vault 不能分配给另一个身份。
- 同一身份的并发刷新合并处理。飞书刷新成功后先加密保存新 Refresh Token 和待同步 Access Token，再更新原 MA Credential；MA 同步失败或进程重启后只重试同步，不复用旧 Refresh Token。
- 明确的授权失效会保留 Vault/Credential ID 并进入待重新授权状态；应用配置、权限错误不会伪装成用户授权失效。429 尊重退避时间。刷新结果未知时保留记录并停止自动重复刷新，不能假定旧 Refresh Token 仍可重用。
- 用户凭证使用独立 AES-256-GCM 密钥，位置为 `<GATEWAY_DB_PATH>.credential-key`，权限必须为 `0600`。**停机备份时必须同时保存数据库及对应密钥**；在线备份需使用 SQLite 一致性备份机制，不能只复制正在写入的数据库主文件。密钥丢失或不匹配时拒绝解密，不会自动生成替代密钥；修改 WebUI Token 不影响该密钥。
- 旧版 `employee_oauth` 记录先加密，只有会话挂载记录能证明唯一应用和用户归属时才迁移。跨应用/跨用户的歧义记录停止自动迁移，需管理员核查。迁移不保证清除旧备份、磁盘快照或历史 WAL 中的明文，请按敏感凭证管理这些历史文件；旧版程序不能读取新的加密格式，回退需要配套的升级前备份，且不能撤销已发生的飞书 Token 轮换。

授权恢复现已记录原消息身份、原 Session 和一次性恢复检查点：重复回调不会重复入队，重启不会清空已领取记录；执行恢复前重新检查 Session 和空闲状态。旧 Session 没有用户 Vault 时不再自动 handoff，而是保留原会话并提示选择继续 Bot 操作，或保存文件后显式 `/new`。授权期间重置/替换了 Session 时，不自动把旧请求投到新会话。

源码开发版已支持授权取消、超时与分阶段重启恢复：明确等待用户时继续原轮询，不重发卡片；交换Token或发送卡片结果未知时停止自动重试；已收到的Token先加密落盘，经身份校验后同步原Credential。凭证与同步阶段、取消与任务状态均采用事务更新。等待授权时暂停当前单聊后续业务，其他用户和群聊不受影响。仍未完成多步骤写操作的安全续跑，不能把原请求自动重发视为安全恢复，也不能把自动化测试通过等同于真实飞书端到端验收通过。

数字员工不再维护第二套用户白名单。谁可以发现和使用 Bot，完全服从飞书应用的可用范围与禁用范围；企业希望接受范围外申请时，应在飞书管理后台开启原生的“允许不在可用范围内的成员申请使用应用”。凡是飞书成功投递到 Gateway 的消息都会进入 Managed Agents，WebUI 只记录实际使用者、使用次数和审计日志。

企业管理员配置路径：`飞书管理后台 > 工作台 > 应用管理 > 方舟数字员工 > 应用可用范围`。如果企业的应用管理规则已允许成员申请没有权限的应用，可在这里勾选“允许不在可用范围内的成员申请使用应用”。该开关属于企业管理策略，当前公开 OpenAPI 与一键创建 SDK 均没有提供自动设置字段，因此 init 只做明确引导，不尝试绕过管理员配置。

Bot 的 App Secret 保存在本地安全配置，用于 WebSocket 鉴权和刷新短期 `tenant_access_token`。Gateway 把短期 Bot token 写入方舟 Vault，以 `LARKSUITE_CLI_TENANT_ACCESS_TOKEN` 注入 Session；MA Session 不需要读取 App Secret。App ID 由 Environment 提供。当前消息发送者的 `open_id` 会作为 `FEISHU_USER_OPEN_ID` 覆写到 Session；只有该 Session 同时挂载了对应用户 Vault 时，才表示这个用户已经授权。

数字员工会显式申请 `im:message.p2p_msg:readonly` 与 `im:message.group_at_msg:readonly`，分别用于接收用户私聊和群聊中明确 @Bot 的消息；还会申请 `im:message.group_msg`，供 Gateway 和 Session 内的 Bot 读取群聊或话题近期历史。该权限属于敏感群消息权限，可能需要管理员审核并重新发布应用。Gateway 收到请求后先在用户消息上添加 `Get` 表情，使用同一条流式消息逐步更新 Agent 回复，任务成功或失败后都会移除该表情。应用可用范围、原生申请和审批由飞书控制面统一管理，arkagent 不复制这套能力。

数字员工普通群聊按 `chat_id` 共享一个 Managed Agents Session，消息排队执行；Thread 按 `thread_id` 使用独立的共享 Session。群聊只挂载 Bot Vault，不申请或挂载任何成员 UAT，避免多人会话串身份。首次创建 Session 时会注入触发消息之前的近期上下文，之后增量注入新消息，并同步本次历史窗口内已编辑、已撤回的消息；同一个 Session 的 Bot 回复不会再作为历史重复注入。普通群读取群消息；Thread 同时读取所在群近期消息与当前话题消息，再去重、排序。上下文限制为最近 20 条、最多 8,000 字符，并以 `role="reference"` 标记为真实会话记录，仅供理解背景，不构成本轮指令、授权或操作确认。需要更早记录时，Agent 可使用 Bot 身份调用 `lark-cli im +chat-messages-list` 或 `lark-cli im +threads-messages-list`。单聊按飞书会话复用一个 Session，按顺序处理，并支持 `/new` 显式重置。

Gateway 会缓存平台实际推送的群消息（每群最多 2,000 条），未 `@Bot` 的消息不会触发执行，但会参与下次 `@Bot` 的近期上下文。历史接口不可用时使用本地缓存与审计记录，并告知 Agent 可能缺失的范围；这不能补回平台未推送、离线期间遗漏的消息。近期文件、图片及富文本中的附件可在下次 `@Bot` 时补挂载，每轮最多处理 8 个历史附件，失败后保留上传记录以便后续重试。超过条数、字符数或附件预算时会明确标记不完整。

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

新 Environment 不再在启动阶段执行 `npm install` / `npx install`。它会从 lark-cli 安装器使用的国内镜像直接下载固定版本原生二进制，并用官方发布清单中的 SHA-256 校验后安装；同时关闭更新与 Skill 通知器。这样既避免 GitHub 首连失败后的长时间回退，也避免重复下载。lark-cli 升级需随 arkagent 版本更新并同步校验值，不会在 Session 启动时自动漂移到未知版本。

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
| Bot 消息 | `im:message:send_as_bot`、`im:message:readonly`、`im:message.group_msg`、`im:message.reactions:write_only`、`im:message:update`、`cardkit:card:write`、`cardkit:card:read`、私聊与群聊 @Bot 事件 | 群历史读取属于敏感权限，可能需要管理员审核并重新发布应用 |
| Bot 日历 | `calendar:calendar`、`calendar:calendar.event:create`、`calendar:calendar.event:read` | 可能需要企业管理员审核 |
| Bot 文档/云空间 | `docs,drive` 对应权限 | 可能因企业策略需要审核 |
| 用户基础 | `offline_access`、`auth:user.id:read` | 每位用户首次使用时 OAuth |
| 用户日历读取 | `calendar:calendar:read`、`calendar:calendar.event:read`、`calendar:calendar.free_busy:read` | 按需授权，不授予写权限 |

因此，“权限能否在 init 一次申请好”的准确答案是：**应用需要哪些 scope 可以在 init 一次性声明；Bot scope 的管理员审核可以在 init 发起但未必即时完成；每位用户的数据访问同意不能由 init 代替，必须在该用户首次触发相应能力时单独 OAuth。**

### 已知的 Managed Agents 平台问题

本项目的真实联调暴露出以下 MA 平台体验问题：

- **Environment 更新不等于镜像重建**：修改 `setup_script` 后，新 Session 仍可能复用旧镜像；平台缺少明确的 rebuild、版本号和构建日志。本项目因此以新建 Environment 的方式切换 lark-cli 版本。
- **初始化脚本可观测性不足**：安装失败、网络阻塞和缓存复用难以区分，用户只能从 Agent 后续执行失败反推环境状态。
- **bash 启动不稳定且错误层次模糊**：多次出现“60 秒内未拿到 execution_id”，无法判断是调度排队、容器启动、命令执行还是网络问题。
- **Vault 占位符不适合所有凭证交换**：App Secret 以占位符注入后，依赖它在请求体中换取 Bot token 的 CLI 流程不可用；最终只能由 Gateway 在本地换取短期 tenant token 再写入 Vault。
- **Session 的 Vault 集合创建后不可追加**：运行中的 Session 能读取已挂载 Credential 的新值，但不能追加新的 Vault。本项目因此在数字员工首次单聊创建 Session 前预挂用户 Vault，再在 OAuth 后更新同一 Credential；升级前没有挂载记录的遗留 Session 仅做一次兼容性交接。
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
- 个人助手和数字员工单聊均在一个飞书会话中复用 Managed Agents Session；`/compact` 在原 Session 内压缩上下文，`/new` 显式重置。数字员工 OAuth 更新已预挂载的 Credential，并校验原 Session 后恢复；源码开发版对无法确认 Vault 挂载的遗留 Session 仅提示显式选择，不再静默交接。普通群聊共享一个排队 Session，Thread 各自共享独立的排队 Session，且群聊仅使用 Bot 身份。
- 单聊新建 Session 时，Gateway 会把消息 sender 的 `open_id` 作为 `FEISHU_USER_OPEN_ID` 动态覆写到 Environment。共享群聊/Thread 不固定首位用户的 OpenID 或首条触发消息；每轮通过 `current_actor`、`current_message` 注入当前发言者与消息标识。旧 Session 的静态用户变量不能作为本轮身份依据。
- 每轮输入保留显式引用关系，优先使用近期消息和同会话缓存，必要时按消息 ID 定向查询。引用和历史共享最多20条/8000字符预算；缓存标记为未核实快照，撤回、缺失或无权限不会伪造成有效原文。当前用户请求独立保留。
- Gateway 优先使用 `Get` 表情反馈处理中状态；仅当表情添加失败且请求超过 2.5 秒仍未完成时，才发送一次“正在处理，请稍候。”兜底提示。
- Gateway 不向飞书转发 Agent 的工具执行过程，避免出现“执行进度：xxx”消息刷屏；只发送处理中提示和最终结果。
- Session 默认最多运行 10 分钟；临界超时后还会短暂回查事件历史。
- Markdown/TXT 原文内联到 Session 消息，并保存于权限为 `0600` 的本地数据库以支持压缩后恢复。其他文件上传到方舟 Files；Gateway 保存 File ID 和挂载记录，不保存二进制正文。实际沙箱路径为 `/mnt/session/uploads/mnt/data/<附件标识>/<文件名>`。
- 修改配置中的 Agent ID 后，Gateway 不会悄悄沿用绑定旧 Agent 的 Session，也不会自动迁移；会提示恢复配置或显式 `/new`。
- 相同事件重复投递会去重；未提交到 Agent 的失败请求最多允许 3 次安全领取。已提交但结果不明的请求不会自动重跑，避免重复执行业务操作。该机制不是自动任务重放服务。
- 群聊中明确 `@Bot` 的文本、文件和图片可进入 Agent；音视频和交互卡片暂不作为任务输入处理。

## 二次开发：完整 Session Create 请求

### 源码开发版：声明式配置与只读诊断

以下能力尚未作为新的npm版本发布；本地测试请先 `npm run build`，再用 `node dist/cli.js` 替代 `arkagent`。

数字员工单聊可发送 `/auth cancel` 取消正在等待的 OAuth 和本次任务续跑。该控制命令不排入业务队列，不触发模型；它不撤销飞书服务端授权，不中断已经开始的业务操作，也不能撤销已经发出的凭证更新。授权过期或被拒绝时会发送状态通知，取消/过期检查点保存在数据库中，迟到回调不会恢复这些任务。

源码开发版支持 `/auth status`：直接查询当前应用、租户、用户及会话的本地授权记录，分别展示凭证、授权流程和最近最多10条关联任务的恢复状态。授权成功不代表任务完成；凭证就绪也不代表所有资源均有权限。查询不排入业务队列，不触发模型、Token刷新、重新发卡或业务续跑；即使等待授权已暂停业务消息，也能查看状态。结果是本地检查点而非飞书服务端实时有效性校验，不返回Token、授权链接、原始请求或文件正文。群聊/话题中仅提示Bot-only，不读取个人授权。二次开发通过`GatewayOptions.authorizationStatus`接入`EmployeeAuthorizationManager.status()`；未提供回调的个人助手保持原消息路由。

持久化业务队列仍是二次开发的实验选项 `GatewayOptions.durableQueue`，CLI默认未启用。开启前须取得Store运行锁。`recoverPendingMessages()`恢复排队任务并只读核查已派发的未知任务：只有原Session/Agent/配置绑定不变、原运行已结束、此前最终回复接口已确认成功且运行结果指纹一致时，才结束原任务并放行后续消息，不重发原请求或回复。`reconcilePendingMessage()`可再次核查；仍在运行、需要授权、准备阶段副作用或回复送达不明确的任务继续保留，完整的投递核查与人工处理入口尚未完成，不能作为生产恢复承诺。检查点使用版本化加密格式，旧输入记录可读取但不会补造旧回复证明；回退到不识别新格式的代码需配套升级前数据库与密钥备份，不能直接用旧代码打开新数据库。

实验队列还会加密记录OnIt/Get发送意图、开始时间与已返回的表情ID。也可调用`recoverPendingReactions(channelType, installationId)`再次尝试，它不调用MA、不改变任务终态。当前正在使用的表情不会被当作历史表情清理；同一消息同类表情未核实清理前不重复添加，以免旧删除请求误删新表情。配置`inspectReaction`后，恢复先查询实际表情：已知ID确认不存在则结束清理，不重复DELETE；无ID的发送只在完整列表中找到当前AppID、同类表情且添加时间在本地发送开始后30秒内的唯一记录时接管清理。无ID且查不到、时钟不符、旧记录缺时间、分页不完整或权限失败均保留待核查，空列表不能证明迟到发送绝不会生效。每次查询等待最多5秒、20页，SDK底层HTTP仍依赖自身超时；正常添加/删除路径不增加查询。原生飞书接口严格检查业务code，HTTP成功不能单独作为发送/清理成功证明；没有查询能力的自定义Channel仍只处理已有ID。

实验队列新增每次回复独立的投递检查点：卡片创建、消息发送、正文更新、流式关闭分别保存意图和确认；卡片/消息ID、更新序号、最终正文与MA结果的SHA-256指纹均加密落库。占位卡片或授权提示不能作为最终回复，只有最终正文一致且接口确认完成才记录送达。若适配层已保存最终确认、Gateway尚未结束任务就退出，重启可核查原MA运行后放行，不重新执行任务。每次派发有独立标识，授权恢复即使复用Session和输入也拒绝上一轮迟到回调。二次开发的`reply`/`streamReply`第三个可选参数为`ReplyDeliveryObserver`，必须逐步await并让保存失败向上传播；旧适配器不传检查点时仍只使用原有整次调用成功确认。原生CardKit正文和settings检查业务code；SDK 0.4.1流式回退会吞掉部分更新/收尾错误，因此只记已知消息ID，不能生成最终确认，使用实验队列时会保留待核查状态。没有observer时回退保持原行为。接口已生效但响应/本地确认丢失的状态尚需远程投递核查，不能把当前检查点能力当成完整自动补偿或跨系统exactly-once保证；CLI仍未默认启用实验队列。

实验队列现支持原生单卡片的只读送达核查：原MA运行已结束、最终正文曾尝试提交且持久化了消息ID时，通过消息GET的`card_msg_content_type=user_card_content`读取卡片。只有应用/租户/会话/话题均一致、唯一正文元素与最终正文哈希一致、`streaming_mode=false`时，才保存加密核查证明并放行，不重跑MA、不修改卡片。查询等待最多5秒；核查期间绑定或检查点版本变化则丢弃结果。网络/权限错误、撤回、占位、仍在流式或正文不同均保留待核查，可再次调用`reconcilePendingMessage()`。二次开发通过`GatewayOptions.inspectReply`连接Channel的`inspectReply`。这证明查询时最终正文可读，不是用户已读回执。

当前核查只支持原生单卡片；没有消息ID的发送、普通文本/多片消息、SDK流式回退、仍未关闭的流式卡片及准备阶段副作用尚未闭环，不能将其当成完整自动补偿。正常回复不新增远程查询，CLI仍未默认开启实验队列。实际读取已有卡片已验证返回更新后正文和关闭状态，响应丢失/重启恢复仍以模拟外部接口的故障注入测试为证，不冒充完整真实飞书E2E。

本地检查点开销可运行`node --experimental-strip-types scripts/probe-reply-checkpoints.mjs`，30组使用真实SQLite、模拟CardKit，不访问飞书/MA。它检查不增加外部写请求并报告本地P50/P95；1ms模拟渲染间隔与真实网络、默认流式节奏不同，不作为真实用户端性能验收。

源码开发版在「行为日志」中增加「待处理任务」。二次开发开启持久化队列并将Gateway作为`startEmployeeWeb({ recovery: gateway, ... })`传入后，可查看当前应用/Agent的分页任务状态，重新核查，或明确确认放弃。CLI已接入管理视图，但队列仍默认关闭，页面会说明未启用。状态列表不查询MA，不返回用户原文、模型输出或凭证；核查状态只是最近一次记录。

放弃要求持有控制台Token、当前任务版本和显式确认，并重新查询原MA运行（最多10秒）。仅原Session/Agent/配置不变、已有原请求及原生终态事件证明、无待授权结果时，才将任务标记为失败并放行该scope后续消息。任务、接收记录和管理员审计原子保存；它不重跑MA、不补发回复、不撤销已创建的外部资源，也不伪造送达证明。状态变化或重复提交返回冲突，先刷新再处理。准备阶段、无派发锚点、仍在运行、核查失败或授权未完成仍不允许放弃，完整自动恢复及这些边界的处理继续待开发。当前仅支持现有本地HTTP控制台同源管理，不新增群聊管理命令或自动重试入口。

重启时先连接Channel，再恢复当前应用的授权状态，最后投递连接期间收到的新消息；恢复失败则关闭Channel，不放行部分业务。已领取的业务恢复任务不会因重启重复投递。等待轮询保留下一次请求时间，身份校验保留原有效期；已校验身份但待同步的Token过期时，可用持久化的新Refresh Token刷新。

等待授权时，Get在本轮退出后移除，单聊后续业务暂停；授权成功优先恢复原任务，再处理后续消息。取消、拒绝或过期解除暂停。单聊`/new`可穿过授权暂停，先取消旧任务续跑，再重置Session；它不会中断已在执行的MA请求。没有授权等待时仍遵循普通FIFO顺序。重启先根据持久化授权流程恢复暂停状态，再接收新业务。

授权恢复前会核对本轮MA事件历史，保存加密的工具执行证据（调用ID、操作类型、结果、已创建资源ID，不保存命令/文件正文）。只有完整证据表明此前均为已识别的读取操作时，才在原Session发送续跑事件，不重发原始请求、不重新下载原附件。发现成功写入、未知工具、缺失结果、历史核验失败或遗留任务没有证据时，保留Session和授权，提示核对已完成部分，不自动重放；阻止原因记录在`authorization_recovery_blocked`审计中。普通请求不增加这次授权专用的历史核验。

当前开发边界：上述防重放保护不等于完整的“跳过已完成写入、自动继续剩余步骤”；部分业务写入后的受控续跑、进程退出时普通内存排队消息的持久化重投仍未完成，不能用保守阻止代替最终验收。二次开发调用方应提供授权状态通知回调，并将`onStateChange`接到`Gateway.setAuthorizationWaiting`；在持有Gateway数据库运行锁且Channel可回复后调用 `EmployeeAuthorizationManager.restore()`，在关闭数据库前调用 `close()`。取消并不撤销已发出的外部请求；未知结果不会被伪装成取消成功的外部操作。

在当前模式的 `config.env` 中可选设置：

```ini
ARK_SESSION_CONFIG_FILE="./session-config.json"
```

相对路径以 `config.env` 所在目录为基准。文件示例：

```json
{
  "schemaVersion": 1,
  "defaults": { "request": { "tags": [{ "key": "source", "value": "feishu" }] } },
  "direct": { "request": { "title": "个人协作" } },
  "group": { "request": { "title": "群聊协作" } },
  "thread": { "request": { "title": "话题协作" } },
  "vaultPurposes": {}
}
```

`request` 使用MA原生Session Create字段，包括Agent版本、Environment覆写、resources、Memory/TOS等；未知扩展字段不被插件丢弃。是否被服务端接受仍以当前MA契约为准。合并顺序是基础配置 → defaults → direct，或group → thread → 开发者hook → 必需资源与身份校验。

- 标量覆盖、对象深合并；显式空对象（例如`tos:{}`）保留清空语义，普通数组由后层替换。本轮上传文件在hook之后再次追加并去重，不因替换resources而丢失。
- 一个Bot绑定一个Agent ID，可配置同一Agent的版本/覆写，不允许配置不同Agent ID。插件不会更新控制台Agent。
- 额外群聊Vault必须在`vaultPurposes`中以Vault ID为键声明`"application"`用途；`"user"`或本地已知个人Vault不能进入共享群Session。用途声明不发送到MA。
- App ID冲突、身份冲突、不同资源使用相同挂载路径会明确报错。启动时先校验三个会话场景，不创建Session、不执行开发者hook。
- 配置只在启动时加载，只影响新Session。已存在Session不会重建；记录配置指纹，变化时提示未应用。`/new`会丢失对旧沙箱的会话绑定，不是无损升级。
- Gateway按数据库实行单实例保护；活跃进程持锁时第二个进程拒绝启动，确认原进程退出后可以恢复。它不是跨机器分布式锁，也不能防止同一Bot使用两个不同数据库启动。

```bash
arkagent --version
arkagent -v
arkagent employee doctor --json
arkagent employee doctor --session <session-id> --json
```

`doctor`默认只读控制面和本地数据库，不修改资源、不执行沙箱命令。输出软件版本、运行/配置路径、构建Commit与源码Hash、各场景配置指纹、App ID检查和Session实际Agent版本；SP只输出是否显式覆写及Hash，不输出正文或Token。老Session缺少本地证据时显示unknown，不猜测为配置一致。源码运行无构建记录时会明确标记。

### 编程扩展

`arkagent/core` 暴露 `ArkClient`、`Gateway`、Channel 契约以及对应 TypeScript 类型。`ArkClient.createSession(request)` 直接接受方舟原生 Session Create 请求，不会丢弃未知扩展字段、显式空数组或 `tos: {}` 等 wire 语义：

```ts
import { ArkClient, Gateway, type SessionCreateRequest } from "arkagent/core";

const ark = new ArkClient(process.env.ARK_API_KEY!, "https://ark.cn-beijing.volces.com/api/v3");

const request: SessionCreateRequest = {
  agent: { id: "agent-xxx", type: "agent", version: 3 },
  environment: {
    id: "env-xxx",
    type: "environment_with_overrides",
    config: {
      type: "cloud",
      tos: { bucket: "employee-output", prefix: "tenant-a/" }
    }
  },
  resources: [
    { type: "memory_store", memory_store_id: "mem-xxx", access: "read_write" },
    {
      type: "tos",
      tos_bucket: "employee-input",
      tos_key: "seed/context/",
      tos_region: "cn-beijing",
      mount_path: "/mnt/data/context"
    }
  ],
  vault_ids: ["vlt-xxx"],
  title: "飞书任务",
  tags: [{ key: "channel", value: "lark" }]
};

const sessionId = await ark.createSession(request);
```

Gateway 的 `buildSessionRequest(message, draft)` 可在每次真正创建新 Session 前调整完整请求。默认 Agent、Environment、飞书上下文环境变量和身份隔离策略已经写入 `draft`；回调应在此基础上合并业务所需的 Agent 版本、Memory Store、TOS、title、tags 或未来新增字段。新 Session 收到的非文本附件会先上传到 Ark Files，并合并进同一次创建请求的 `resources`；已有 Session 则通过通用会话资源接口追加。

当前线上 TOS resource 按目录挂载：`tos_key` 必须是已存在且以 `/` 结尾的前缀，`mount_path` 是沙箱内的只读目录；Bucket 必须与 Managed Agents 服务同地域。Environment 的产物 TOS 同样要求 Bucket、Prefix 已存在且方舟服务角色拥有读写权限。

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
