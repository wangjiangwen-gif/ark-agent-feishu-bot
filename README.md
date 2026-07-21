# Ark Agent Feishu Bot

> 一个方舟 API Key，两次飞书扫码，认领一个能以你的身份使用 `lark-cli` 的办公助手。

这不是一个要求你手工配置 Agent、Environment、Vault 和飞书应用的 Bot 框架。初始化向导会直接创建一套个人专属资源，把飞书用户凭证安全地交给 Managed Agents Session，并启动一个通过 WebSocket 收消息的本地 Gateway。

## 你会得到什么

运行一次 `npx --yes arkagent@latest init` 后，工具会自动完成四件事：

| 自动完成 | 结果 |
|---|---|
| 创建 Managed Agent | 新建“飞书办公助手（方舟 MA 版）”，内置 `lark-cli` 使用规则 |
| 创建飞书应用 | 配置机器人、消息事件和办公权限，不要求手填 App ID / App Secret |
| 配置用户身份 | 将短期 `user_access_token` 写入方舟 Vault Credential |
| 创建运行环境 | 安装 `lark-cli`，注入 App ID，并让新 Session 引用用户 Vault |

初始化完成后，你可以直接在飞书里让它创建文档、整理云空间内容，或执行其他已经授权的 `lark-cli` 办公任务。

## Quickstart

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

### 3. 检查并启动

```bash
npx --yes arkagent@latest doctor
npx --yes arkagent@latest
```

如果准备长期运行，可以全局安装，之后命令更短：

```bash
npm install -g arkagent
arkagent init
arkagent
```

看到“Gateway 已启动，正在通过飞书 WebSocket 接收消息”后，在飞书中找到刚创建的应用并发送消息。

可以先试：

```text
创建一篇标题为“办公助手测试”的飞书文档，正文写“lark-cli 已可用”，完成后把链接发给我。
```

`/new` 会清除当前飞书会话到方舟 Session 的映射；下一条消息将创建新 Session。

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

配置目录权限为 `0700`，配置文件权限为 `0600`；Gateway 数据保存在 `~/.arkagent/gateway.db`。不要在 Agent prompt 或日志中打印凭证。

Gateway 会在 access token 距离过期不足 5 分钟时刷新 token，更新方舟 Credential，再原子更新本地 refresh token。

## 消息与 Session 行为

- 单聊中的文本消息会发送给绑定的 Agent。
- 群聊只处理明确 `@Bot` 的文本消息。
- 一个飞书会话复用一个 Managed Agents Session；`/new` 显式重置。
- 新建 Session 会立即回复一次“正在处理”；复用 Session 只有超过 2.5 秒仍未完成时才发送一次提示。
- Gateway 不向飞书转发 Agent 的工具执行过程，避免出现“执行进度：xxx”消息刷屏；只发送处理中提示和最终结果。
- Session 默认最多运行 10 分钟；临界超时后还会短暂回查事件历史。
- 图片、文件、富文本与交互卡片暂不处理。

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
| `src/cli.ts` | `init`、`doctor`、`run` 命令入口 |
| `src/init.ts` | 创建 Agent、Vault Credential、Environment 并写入配置 |
| `src/oauth.ts` | 飞书 Device OAuth 与 token 刷新 |
| `src/feishu.ts` | 飞书 WebSocket 事件接入与消息归一化 |
| `src/gateway.ts` | 去重、Session 复用、进度与最终回复 |
| `src/ark.ts` | Managed Agents API 与 SSE 客户端 |
| `src/store.ts` | SQLite 会话映射和事件处理记录 |

## 当前边界

这是单用户 MVP：只有初始化时授权的 `open_id` 可以驱动 Agent。它适合个人认领和本地验证，不是多租户托管服务，也不会代替企业管理员完成应用审批或可用范围配置。

## 参考资料

- [飞书文档版：一个 API Key，两次扫码，认领你的飞书办公助手](https://bytedance.larkoffice.com/docx/M2mGdkHIHoGFYVx1nLzch6TvnIb)
- [飞书：一键创建飞书智能体应用](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)
- [飞书：使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)
- [火山方舟：Managed Agents API](https://docs.volcengine.com/docs/82379/2555910?lang=zh)
