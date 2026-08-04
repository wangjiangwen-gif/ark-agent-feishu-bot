# open_id 流转时序

```mermaid
sequenceDiagram
    participant F as 飞书事件<br/>平台侧
    participant G as Gateway<br/>客户侧
    participant S as Managed Agents Session<br/>平台侧
    participant A as Agent<br/>平台侧
    participant M as MCP<br/>客户侧

    F->>G: im.message.receive_v1<br/>sender.sender_id.open_id = ou_xxx
    Note over G: 读取并校验 open_id

    G->>S: POST /sessions<br/>env.FEISHU_USER_OPEN_ID = ou_xxx
    S->>A: 启动 Agent / 工具运行环境
    Note over A: 工具可读取<br/>FEISHU_USER_OPEN_ID

    G->>S: user.message
    S->>A: 执行用户请求

    A-->>M: 调用 MCP<br/>显式传递 open_id
    Note over A,M: 远程 MCP 不会自动继承 Session 环境变量；<br/>需通过工具参数或可信 Header 传递
    M-->>A: 按 open_id 执行业务并返回结果
```

## 运行位置

| 实体 | 运行位置 |
|---|---|
| 飞书事件 | 飞书平台 |
| Gateway | 客户服务层 |
| Managed Agents Session | 火山方舟云 |
| Agent | 火山方舟云 |
| MCP | 客户服务层 |

## 核心边界

`open_id` 可以从飞书事件可靠到达 Gateway，并在创建 Session 时注入为 `FEISHU_USER_OPEN_ID`。远程 MCP 无法自动继承该环境变量，需要 Agent 通过工具参数或可信 Header 显式传递。
