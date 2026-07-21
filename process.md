# Process — Ark Agent Feishu Bot

## 一句话立意

一个方舟 API Key，两次飞书扫码，认领一个能以用户身份使用 `lark-cli` 的办公助手。

## 骨架

| 节 | 产出 |
|---|---|
| 一、Quickstart | 从 clone 到发出第一条办公指令 |
| 二、两次扫码 | 解释应用身份与用户身份为什么分开 |
| 三、权限与凭证 | 说清默认范围、存储位置和刷新机制 |
| 四、运行行为 | 说明消息、Session、进度和超时 |
| 五、开发与边界 | 给贡献者入口，也诚实说明单用户 MVP 范围 |

## 被砍掉的内容 + 原因

- 删除早期 PRD 式的“待确认决策”：仓库 README 服务的是立即上手，不是产品评审。
- 不把 Environment、Vault 等内部资源放在首屏：先让用户看到输入和结果，再解释实现。
- 不承诺中心化托管：当前实现是本地 Gateway，Docker 只是运行方式。

## 用户反馈与改动

- 2026-07-21 用户提出先创建子目录，调研把方舟 Managed Agents Agent 发布为飞书 Bot 的工具思路。
- 2026-07-21 用户确认采用本地优先方案；实现 CLI、本地/Docker Gateway、SQLite、飞书 WebSocket 与 Managed Agents Session 映射。
- 2026-07-21 用户要求初始化改为 CLI 引导式输入，并自动创建 Environment，不再手填 Environment ID。
- 2026-07-21 用户指出飞书 App ID/App Secret 不应手填；初始化改用飞书 Node SDK `registerApp`，通过扫码自动取得凭证。
- 2026-07-21 用户要求初始化直接创建个人级 Agent，不搜索或复用已有 Agent。
- 2026-07-21 用户要求发布到 GitHub，并将对外叙事收敛为“一个 API Key、两次扫码、认领一个能够使用 lark-cli 的办公助手”。
