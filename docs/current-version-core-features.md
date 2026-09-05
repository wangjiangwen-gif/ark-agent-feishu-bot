# Ark Agent Feishu Bot 0.2.5 核心功能

> 一个方舟 API Key，把 Managed Agents 变成飞书个人助手或团队数字员工。

## 1. 两种运行模式

### 个人助手

- 通过 `arkagent init` 完成引导式初始化。
- 自动创建飞书应用、Managed Agent、Environment、Vault 和 Credential。
- 默认以授权用户身份调用 `lark-cli`，处理飞书文档、云空间等个人资源。
- OAuth access token 存在方舟 Vault，refresh token 与 App Secret 保留在本地。
- 通过 `arkagent login` 可以仅重新进行用户授权，不重新创建整套资源。

### 数字员工

- 通过 `arkagent employee init` 创建团队数字员工及本地管理后台。
- 默认使用 Bot 身份执行飞书操作。
- 任务需要读取用户日程、忙闲等私人数据时，通过飞书卡片按需申请用户授权。
- Bot 负责创建日程等公开操作，用户身份只用于读取私人信息、权限判断和身份确认。
- 每位用户拥有独立 Vault，用户凭证不会共享或串用。

## 2. 飞书消息接入

当前默认使用飞书官方 `@larksuite/channel`：

- 通过 WebSocket 长连接接收飞书事件。
- 支持私聊、群聊 `@Bot` 和 Thread。
- 内部使用 Channel Adapter 解耦飞书与 Gateway，为未来接入其他消息平台保留扩展边界。
- Channel SDK 异常时，可以通过 `ARKAGENT_FEISHU_TRANSPORT=legacy` 临时回退旧版 node-sdk。

消息交互体验：

- 收到请求后在用户消息上添加 `Get` 表情。
- 使用同一张卡片逐步流式展示最终回复。
- 完成或失败后自动取消 `Get` 表情。
- 不转发工具调用、内部思考和“执行进度：xxx”等过程消息。
- 对意图不明确的请求先澄清，避免误调用大量工具。

## 3. Session 与群聊上下文

- 单聊：一个飞书会话复用一个 Managed Agents Session，保证连续对话。
- `/compact`：调用 MA 内置能力在当前 Session 内压缩上下文，不更换 Session ID，也不丢失挂载资源。
- `/new`：清除当前会话的 Session 映射，下一条消息创建新 Session。
- 普通群聊：按群共享一个 Session，消息依次排队执行；Thread 按话题共享独立 Session。
- 群聊 Session 只绑定 Bot Vault，不挂载成员 UAT，避免多人会话串身份。
- 创建群聊 Session 时自动注入触发消息之前的近期群聊上下文。
- Thread 会同时合并所在群的近期消息与 Thread 内消息。
- 注入上下文统一限制为最近 20 条、最多 8,000 字符，并以 `role="reference"` 标记为仅供理解上下文的真实会话记录，不构成本轮指令、授权或操作确认。

单聊 Session 创建前会预挂当前用户独立的 Vault 与占位 Credential。`lark-cli --as user` 返回结构化 `token_missing` 后，Gateway 才发送 OAuth 卡片；授权完成后更新同一个 Credential，并在原 Session 自动续跑。只有升级前没有 Vault 挂载元数据的遗留 Session 会执行一次兼容性 handoff。达到上下文阈值时，Gateway 在当前 Session 内执行 MA 内置 `/compact`，不会轮换 Session。

## 4. Bot 与用户双身份

每次创建 Session 时，Gateway 都会根据当前消息动态注入：

```text
FEISHU_USER_OPEN_ID
```

该值取自当前飞书消息发送者，可以继续传递给 Agent 工具或 MCP 服务。

数字员工 Session 可以同时拥有：

- Bot Vault：保存短期 tenant access token。
- 当前用户 Vault：单聊首次创建 Session 前即以占位 Credential 预挂载，OAuth 后原地更新值。
- 当前消息发送者 open_id：用于身份识别、邀请参会人和审计。

由此实现“默认使用 Bot 身份工作，必要时临时获得当前用户授权”的双身份模型。

## 5. 文件与图片处理

- Markdown、TXT：提取 UTF-8 原文并直接注入消息，上限 256 KB。
- PDF、Office 文件等：上传方舟 Files，并只读挂载到 Session 的 `/mnt/data/`。
- 图片及图文消息：同时保留文字内容和图片资源。
- 用户未附带文字指令时，默认总结文件。
- 二进制文件默认上限 20 MB，实际解析能力以方舟 Files API 为准。

## 6. 数字员工 WebUI

数字员工提供仅监听本机的管理后台，默认地址为：

```text
http://127.0.0.1:8787
```

控制台采用“数字员工列表 → 员工详情”结构，详情包括：

- **身份**：当前 Agent 拥有的飞书 Bot 身份、能力和脱敏 Credential 引用。
- **行为日志**：请求用户、会话、状态、耗时和错误。
- **访问过的用户**：实际使用过该 Bot 的用户及使用次数。

WebUI 只负责身份展示、观测和审计，不复制飞书的权限控制面。应用可用范围、禁用范围和范围外申请仍由飞书原生能力管理。

## 7. Environment 与性能优化

当前版本不再通过 npm/npx 安装 `lark-cli`，而是：

- 从国内镜像直接下载固定版本原生二进制。
- 使用 SHA-256 校验安装包。
- 关闭升级和 Skill 通知检查。
- 避免 GitHub 网络失败和重复下载。
- 并行执行群聊上下文读取与 Session 创建。

真实联调中，典型飞书 OpenAPI 请求耗时从约 23.85 秒下降至约 10.95 秒，改善约 54%。

## 8. 常用命令

```bash
# 安装或升级
npm install -g arkagent@latest

# 个人助手
arkagent init
arkagent
arkagent login
arkagent doctor

# 数字员工
arkagent employee init
arkagent employee
arkagent employee doctor
arkagent employee repair-environment
```

## 9. 当前产品边界

- Gateway 仍需运行在用户或客户可控的服务环境中，目前默认是本地进程。
- 飞书应用 scope 可以在 init 阶段一次性声明，但管理员审核无法由工具跳过。
- 每位用户的数据访问同意必须由本人完成 OAuth，不能由管理员或初始化流程代替。
- Managed Agents 能让运行中 Session 读取已挂载 Credential 的新值，但不能给运行中 Session 追加 Vault；因此用户 Vault 必须在单聊 Session 创建前预挂载。

总体而言，当前版本是一套围绕 Managed Agents 的飞书 Channel 插件：负责资源初始化、双身份、Session 生命周期、OAuth 原 Session 续跑、群聊上下文、文件挂载、流式消息和基础审计。
