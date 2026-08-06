# 火山方舟 · Managed Agents 文档合集

> 来源：`docs.volcengine.com/docs/82379/{2553713..2553730}?lang=zh`
> 由页面自带的「复制 Markdown」原文拼接而成，未做二次改写。

## 目录

- [概述](#doc-2553713) · `2553713`
- [快速入门（代码）](#doc-2553714) · `2553714`
- [快速入门（控制台）](#doc-2553715) · `2553715`
- [Agent](#doc-2553716) · `2553716`
- [Skills](#doc-2553717) · `2553717`
- [MCP](#doc-2553718) · `2553718`
- [Tools](#doc-2553719) · `2553719`
- [工具权限策略](#doc-2553720) · `2553720`
- [配置云环境](#doc-2553721) · `2553721`
- [云沙箱参考](#doc-2553722) · `2553722`
- [启动 Session](#doc-2553723) · `2553723`
- [管理 Session](#doc-2553724) · `2553724`
- [Session 事件流](#doc-2553725) · `2553725`
- [使用 Vaults 认证](#doc-2553726) · `2553726`
- [上传与挂载文件](#doc-2553727) · `2553727`
- [持久化记忆](#doc-2553728) · `2553728`
- [Advisor](#doc-2553729) · `2553729`
- [Multi Agent](#doc-2553730) · `2553730`

<a id="doc-2553713"></a>

---

## 概述

> 来源：[https://docs.volcengine.com/docs/82379/2553713?lang=zh](https://docs.volcengine.com/docs/82379/2553713?lang=zh)

方舟 Managed Agents 是火山方舟提供的 **预构建、可配置的智能体框架** ，运行在方舟托管的基础设施之上，最适合承载 **长时间运行、多轮工具调用、有状态的异步任务** 。

基于模型 API 构建一个可用的 Agent，需自行实现 AgentLoop、工具调用、上下文管理、沙箱调度、断点续跑与权限隔离等通用组件——建设周期通常需要 4 至 8 周，且需随模型迭代持续适配。方舟 Managed Agents 将 Agent 层的一整套基础设施完整交付，开发者仅需定义 Agent 行为、发送用户事件并订阅结果流，底层复杂度全部由平台承担。

> 方舟目前提供两种基于豆包大模型的构建方式：需对 Agent 循环进行细粒度控制时，选用 **模型 API** ；需将完整 Agent 交由平台托管、聚焦业务逻辑时，选用 **Managed Agents** 。两者的详细差异参见下文 [与模型 API 对比](https://www.volcengine.com/docs/82379/2553713#vs_model_api)。

<columns>
<columnsItem zoneid="vqqMaQXq6J">

<card mode="container" href="/docs/82379/2553714" >

**快速入门**

4 步跑通你的第一个方舟托管 Agent：创建 Agent、创建环境、开启会话、发送消息并接收流式响应。

</card>

</columnsItem>
<columnsItem zoneid="tOifahuL7T">

<card mode="container" href="/docs/82379/2553723" >

**启动 Session**

基于 Agent 与 Environment 创建 Session，发送用户事件，让 Agent 开始执行任务。

</card>

</columnsItem>
</columns>

<span id="core_concepts"></span>

# 基本概念

方舟 Managed Agents 围绕以下四个概念构建：

| 概念                  | 描述                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**       | 可版本化、可复用的智能体配置资产，定义了一个智能体的角色、能力、行为边界和运行规则，是所有任务运行的模板和基准。创建一次，通过`agent_id` 在多个 Session 中复用 |
| **Environment** | Session 运行的环境配置，包含网络、预装依赖包与环境变量。通过`environment_id` 引用                                                                              |
| **Session**     | 在 Environment 中运行的 Agent 实例，用于执行一次具体任务。上下文、文件、状态相互隔离，同一 Agent 可发起多个并行 Session                                          |
| **Events**      | 应用与 Agent 之间交换的原子消息，涵盖用户消息、思考、工具调用、工具结果与状态更新。以只增不删的方式在服务端持久化，支持实时订阅或事后回放                        |

<span id="advantages"></span>

# 核心优势

<span id="vs_model_api"></span>

## 与模型 API 对比

**模型 API** 是访问模型能力的最原子接口——需自行实现循环、解析工具调用、维护上下文，适用于需要 **细粒度控制** 的场景。 **方舟 Managed Agents** 则是访问 Agent 能力的封装接口——将 Agent 层原本需自建的通用能力统一收敛至平台内部。

<span id="no_longer_needed"></span>

### 不再需要自行实现的部分

| 之前（模型 API + 自建循环）                                                                    | 之后（方舟 Managed Agents）                                                   |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 维护对话历史数组，每一轮将完整历史传回模型                                                     | Session 由服务端持久化历史，仅需发送 / 订阅事件                               |
| 手动循环调用：模型返回 → 解析`tool_use` → 执行工具 → 追加 `tool_result` → 再次调用模型 | 平台内置 AgentLoop 自动驱动整个循环；Agent 结束时发出`session.status_idle`  |
| 自建沙箱以执行 Agent 生成的代码，机器、容器、扩缩容与清理均需自行管理                          | Session 自带沙箱，代码执行、文件读写、Bash 命令由平台代为承载，任务结束即释放 |
| 自研上下文压缩策略以避免超出上下文窗口                                                         | 上下文自动压缩，Event API 全量留存，不丢失内容                                |
| 自研长程任务的 Checkpoint 与恢复机制                                                           | 自动生成快照，长程任务原生支持断点续跑                                        |
| 自研 IAM、密钥注入与执行环境隔离                                                               | 基于火山 IAM + 零信任凭证隔离，密钥不会进入沙箱进程                           |

<span id="still_controlled"></span>

### 仍由用户掌控的部分

* **模型与系统提示词** ：字段保持不变，仅位置调整至 Agent 定义中。
* **自定义工具** ：仍以 JSON Schema 声明 `input_schema`；执行方式调整为——由用户客户端订阅 `agent.custom_tool_use` 事件，执行后将结果作为 `user.custom_tool_result` 回传。
* **上下文注入** ：仍可通过系统提示词、Skills、上传文件等方式注入。
* **中断与引导** ：可随时向 Session 发送额外用户事件以调整方向，或直接中断本轮执行。

<span id="when_to_use_model_api"></span>

### 何时仍应选择模型 API

若目标 **恰在于自定义 Agent 循环本身** ——例如探索新的推理策略、构建自研 Agent 框架、或需对每一步 `tool_use` 进行特殊改写——则模型 API 更为合适。Managed Agents 面向的是「直接获取可运行的 Agent」，而非「构建 Agent 引擎」。

<span id="vs_open_source_agent"></span>

## 与开源 Agent 对比

主流开源 Agent Runtime（LangChain、OpenCode 等）解决了「能够运行」的问题，但要实现「稳定、高效、具备业务价值」的运行仍需大量投入。方舟并非「在开源框架之上叠加一层豆包适配」，而是 **自底向上自研 AgentLoop 调度内核，并与豆包大模型的原生能力进行深度双向优化** ——相当于为模型配备一套量身定制的操作系统，而非在通用硬件上粗放运行。

| 对比维度               | 方舟 Managed Agents（原生 AgentLoop）        | 开源 Agent Runtime                           |
| ---------------------- | -------------------------------------------- | -------------------------------------------- |
| **模型适配方式** | 与豆包全系列原生双向优化                     | 通用 prompt 模板适配所有模型                 |
| **推理完成率**   | 思维链原生拆解、断点续跑、上下文自动压缩     | 长任务易偏离预期、中断后无法续跑、上下文丢失 |
| **工具调用**     | 协议级对齐，自动校验 / 重试 / 并行           | 通用 JSON 解析                               |
| **长程任务**     | 原生支持长程任务运行，自动生成快照、按需拉起 | 固定模板适配所有场景，需自建沙箱调度         |
| **接入成本**     | 开箱即用，零适配成本                         | 需 4–8 周自研适配，踩坑周期较长             |

<span id="use_cases"></span>

# 适用场景

方舟 Managed Agents 最适合具备以下特征的工作负载：

* **长时间运行** ：单次任务需运行数分钟至数小时，涉及多次工具调用与迭代思考。
* **有状态** ：跨多轮交互持久保存文件系统、对话历史与执行状态，支持断点续跑。
* **异步执行** ：任务发起后由 Agent 自主推进，客户端仅需订阅事件流即可获取结果。
* **最少的基础设施** ：无需自建 Agent 循环、沙箱与工具执行层。
* **弹性调用** ：调用量波峰波谷显著，期望按用量计费而非常驻资源。

在上述特征之上，以下为已验证 PMF 的典型业务场景：

| 场景                         | 重复度 | 风险 | 说明                                       |
| ---------------------------- | ------ | ---- | ------------------------------------------ |
| **IT 工单处理**        | 高     | 低   | 结构化强、模板化程度高，Agent 处理准确率高 |
| **报表自动生成**       | 高     | 低   | 数据抓取与汇总逻辑固定，易于 Agent 化      |
| **供应商邮件处理**     | 中     | 低   | 分类与回复流程明确，适合规则化自动化       |
| **代码 Review 与文档** | 高     | 低   | 研发团队收益直观，ROI 显著                 |
| **销售线索初筛**       | 中     | 低   | CRM 录入自动化，释放销售人力               |

正在使用开源 Agent 自建业务、或通过脚本拼接 Agent 能力的团队，均可考虑迁移至方舟 Managed Agents 进行试点验证。

<span id="workflow"></span>

# 工作流程

方舟 Managed Agents 从创建到接入业务，通常经历以下 5 个步骤：

1. **创建 Agent** ：在控制台或通过 API 定义模型、系统提示词与 Skills / Tools / MCPs，获得稳定的 `agent_id`，可在多个 Session 中通过 ID 复用。
2. **创建 Environment** ：定义沙箱运行环境（预装包、环境变量），获得稳定的 `environment_id`。
3. **启动 Session** ：基于 `agent_id` 与 `environment_id` 创建一次会话（Session）。
4. **发送事件并流式接收响应** ：将用户消息作为事件发送至 Session，Agent 自主执行工具并通过 SSE（server\-sent events）流式返回结果，事件历史由服务端持久化保存，支持完整获取。
5. **引导或中断** ：Agent 执行过程中，可随时发送额外用户事件以引导其调整方向，或直接中断本轮执行。

上手方式提供以下两种路径：

* 如需以 **可视化方式** 快速完成原型验证，参见 [快速入门（控制台）](https://www.volcengine.com/docs/82379/2553715)。
* 如需直接以 **代码 / API** 完成端到端接入，参见 [快速入门（代码）](https://www.volcengine.com/docs/82379/2553714)。

<span id="pricing"></span>

# 计费说明

Managed Agents 按照 Agent 运行过程中实际消耗的 Tokens、Agent 运行时时长和工具调用次数三项累加计费。详情参见 [Managed Agents 计费](https://www.volcengine.com/docs/82379/1544106#ma_billing)。

<a id="doc-2553714"></a>

---

## 快速入门（代码）

> 来源：[https://docs.volcengine.com/docs/82379/2553714?lang=zh](https://docs.volcengine.com/docs/82379/2553714?lang=zh)

4 步跑通你的第一个方舟托管 Agent：创建 Agent、创建环境、开启会话、发送消息并接收流式响应。

<span id="prerequisites"></span>

# 准备工作

<span id="get_api_key"></span>

## 1. 获取并配置 API Key

1. 获取 API Key：访问 [API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)，创建你的 API Key。
2. 配置环境变量：在终端中运行下面命令（替换 `your_api_key_here` 为你的方舟 API Key），配置 API Key 到环境变量。

配置持久化环境变量方法参见 [环境变量配置指南](https://www.volcengine.com/docs/82379/1820161)。

<Tabs>
<Tab zoneid="CesaXIjFeG" title="macOS">
<TabTitle>macOS</TabTitle>

```Bash
export ARK_API_KEY="your_api_key_here"
```

</Tab>
<Tab zoneid="EkycLxFUfp" title="Linux">
<TabTitle>Linux</TabTitle>

```Bash
export ARK_API_KEY="your_api_key_here"
```

</Tab>
<Tab zoneid="OGLPOj2e3C" title="Windows_CMD">
<TabTitle>Windows_CMD</TabTitle>

```Bash
setx ARK_API_KEY "your_api_key_here"
```

</Tab>
<Tab zoneid="XKXhipXxKE" title="Windows_PowerShell">
<TabTitle>Windows_PowerShell</TabTitle>

```PowerShell
$env:ARK_API_KEY = "your_api_key_here"
```

</Tab>
</Tabs>

<span id="enable_managed_agent"></span>

## 2. 开通 Managed Agents 服务

访问 [开通管理页面](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement)，切换到 **Managed Agents** 页签开通服务。

<span id="enable_model_service"></span>

## 3. 开通模型服务

访问 [开通管理页面](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement) 开通模型服务。

<span id="create_agent"></span>

# 1. 创建 Agent

创建一个Agent，定义其模型、系统提示和可用工具。

```Bash
agent=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/agents" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<'EOF'
{
  "name": "Quick Start Agent",
  "model": {"id": "doubao-seed-2-1-pro-260628"},
  "system": "你是一个高效的编程助手，擅长代码编写和问题排查。",
  "tools": [
    {"type": "agent_toolset_20260701"}
  ]
}
EOF
)

AGENT_ID=$(jq -er '.id' <<<"$agent")

echo "Agent ID: $AGENT_ID"
```

<span id="create_environment"></span>

# 2. 创建环境

环境定义了Agent运行所在的沙箱。

> `name` 在当前 project 内必须唯一，重名会报错 400。

```Bash
environment=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/environments" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<'EOF'
{
  "name": "demo-env",
  "config": {
    "type": "cloud",
    "networking": {"type": "unrestricted"}
  }
}
EOF
)

ENVIRONMENT_ID=$(jq -er '.id' <<<"$environment")

echo "Environment ID: $ENVIRONMENT_ID"
```

<span id="create_session"></span>

# 3. 开启会话

创建一个引用您的Agent和环境的会话。

```Bash
session=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/sessions" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "agent": "$AGENT_ID",
  "environment_id": "$ENVIRONMENT_ID",
  "title": "Quickstart session"
}
EOF
)

SESSION_ID=$(jq -er '.id' <<<"$session")

echo "Session ID: $SESSION_ID"
```

<span id="send_message_stream"></span>

# 4. 发送消息并流式传输响应

向会话发送一条用户消息，并通过 SSE 流式接收 Agent 的响应。

```Bash
# Send the user message first; the API buffers events until the stream attaches
curl -sS --fail-with-body \
  "https://ark.cn-beijing.volces.com/api/v3/sessions/$SESSION_ID/events" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- >/dev/null <<'EOF'
{
  "events": [
    {
      "type": "user.message",
      "content": [
        {"type": "text", "text": "用 Python 编写一个脚本，生成前 20 个斐波那契数，并将其保存到 fibonacci.txt。"}
      ]
    }
  ]
}
EOF

# Open the SSE stream and process events as they arrive
while IFS= read -r line; do
  [[ $line == data:* ]] || continue
  json=${line#data: }
  case $(jq -r '.type' <<<"$json") in
    agent.message)
      jq -j '.content[] | select(.type == "text") | .text' <<<"$json"
      ;;
    agent.tool_use)
      printf '\n[Using tool: %s]\n' "$(jq -r '.name' <<<"$json")"
      ;;
    session.status_idle)
      printf '\n\nAgent finished.\n'
      break
      ;;
  esac
done < <(
  curl -sS -N --fail-with-body \
    "https://ark.cn-beijing.volces.com/api/v3/sessions/$SESSION_ID/events/stream" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Accept: text/event-stream" 2>/dev/null
)
```

**示例输出：**

```Plain
[Using tool: write]

[Using tool: bash]

[Using tool: read]
已完成任务：
1. 编写了 Python 脚本 /workspace/generate_fibonacci.py，用于生成斐波那契数列
2. 成功运行脚本，生成的前 20 个斐波那契数为：[0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597, 2584, 4181]
3. 结果已保存到 /workspace/fibonacci.txt 文件中，文件内按序号清晰列出了每一个斐波那契数，内容验证正确。

Agent finished.
```

<span id="full_script"></span>

# 完整脚本

将上面 4 步合并为一个可直接运行的脚本，开头加 `set -euo pipefail`，任一步失败立即终止。

**用法：**

1. 将下面代码保存为 `quickstart.sh`。
2. 确保已按「准备工作」配置好 `ARK_API_KEY` 环境变量，并已安装 `curl` 与 `jq`。
3. 执行：

   ```Bash
   bash quickstart.sh
   ```

```Bash
#!/usr/bin/env bash
set -euo pipefail

export ARK_API_KEY="${ARK_API_KEY:?请先 export ARK_API_KEY}"
ARK_BASE_URL="https://ark.cn-beijing.volces.com"

# Step 1: Create Agent
agent=$(
  curl -sS --fail-with-body "$ARK_BASE_URL/api/v3/agents" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<'EOF'
{
  "name": "Quick Start Agent",
  "model": {"id": "doubao-seed-2-1-pro-260628"},
  "system": "你是一个高效的编程助手，擅长代码编写和问题排查。",
  "tools": [
    {"type": "agent_toolset_20260701"}
  ]
}
EOF
)
AGENT_ID=$(jq -er '.id' <<<"$agent")
echo "Agent ID: $AGENT_ID"

# Step 2: Create Environment
environment=$(
  curl -sS --fail-with-body "$ARK_BASE_URL/api/v3/environments" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<'EOF'
{
  "name": "demo-env",
  "config": {
    "type": "cloud",
    "networking": {"type": "unrestricted"}
  }
}
EOF
)
ENVIRONMENT_ID=$(jq -er '.id' <<<"$environment")
echo "Environment ID: $ENVIRONMENT_ID"

# Step 3: Create Session
session=$(
  curl -sS --fail-with-body "$ARK_BASE_URL/api/v3/sessions" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "agent": "$AGENT_ID",
  "environment_id": "$ENVIRONMENT_ID",
  "title": "Quickstart session"
}
EOF
)
SESSION_ID=$(jq -er '.id' <<<"$session")
echo "Session ID: $SESSION_ID"

# Step 4: Send message and stream response
curl -sS --fail-with-body \
  "$ARK_BASE_URL/api/v3/sessions/$SESSION_ID/events" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- >/dev/null <<'EOF'
{
  "events": [
    {
      "type": "user.message",
      "content": [
        {"type": "text", "text": "用 Python 编写一个脚本，生成前 20 个斐波那契数，并将其保存到 fibonacci.txt。"}
      ]
    }
  ]
}
EOF

while IFS= read -r line; do
  [[ $line == data:* ]] || continue
  json=${line#data: }
  case $(jq -r '.type' <<<"$json") in
    agent.message)
      jq -j '.content[] | select(.type == "text") | .text' <<<"$json"
      ;;
    agent.tool_use)
      printf '\n[Using tool: %s]\n' "$(jq -r '.name' <<<"$json")"
      ;;
    session.status_idle)
      printf '\n\nAgent finished.\n'
      break
      ;;
  esac
done < <(
  curl -sS -N --fail-with-body \
    "$ARK_BASE_URL/api/v3/sessions/$SESSION_ID/events/stream" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Accept: text/event-stream" 2>/dev/null
)
```

<span id="runtime_notes"></span>

# 运行说明

当您发送用户事件时，方舟托管 Agent 会：

1. **配置沙箱** ：您的环境配置决定了沙箱的构建方式。
2. **运行Agent循环** ：方舟根据您的消息确定要使用哪些工具。
3. **执行工具** ：启动沙箱，在沙箱内运行文件写入、bash 命令和其他工具调用。
4. **流式传输事件** ：您会在Agent工作时收到实时更新。
5. **进入空闲状态** ：当Agent没有更多任务要执行时，会发出 `session.status_idle` 事件。

<span id="next_steps"></span>

# 后续步骤

<columns>
<columnsItem zoneid="AE0NTJT4sw">

<card mode="container" href="/docs/82379/2553716" >

**定义 Agent**

定义 Agent 的模型、系统提示词、工具集与运行行为。

</card>

<card mode="container" href="/docs/82379/2553721" >

**配置环境**

配置 Agent 运行所在的云端沙箱环境，包含网络、预装依赖包与环境变量。

</card>

</columnsItem>
<columnsItem zoneid="TbT5iEFdqM">

<card mode="container" href="/docs/82379/2553719" >

**Agent tools**

配置 Agent 在 Session 中可主动调用的工具集合。

</card>

<card mode="container" href="/docs/82379/2553725" >

**Session 事件流**

通过 SSE 事件流实时接收 Agent 的消息、工具调用与状态更新。

</card>

</columnsItem>
</columns>

<a id="doc-2553715"></a>

---

## 快速入门（控制台）

> 来源：[https://docs.volcengine.com/docs/82379/2553715?lang=zh](https://docs.volcengine.com/docs/82379/2553715?lang=zh)

方舟 Managed Agents 控制台提供可视化界面，让你无需编写 API 代码即可创建、配置并测试 Agent。你可以在控制台里交互式地打磨 Agent 配置，验证行为符合预期后，再拿到对应的 ID 接入到自己的业务代码中。

> 首次访问需登录 [火山方舟控制台](https://console.volcengine.com/ark/region:ark+cn-beijing/ark/region:cn-beijing/managed-agents/agents?projectName=default)，进入 **Managed Agents** 模块。

<span id="prerequisites"></span>

# 准备工作

<span id="get_api_key"></span>

## 1. 获取 API Key

访问 [API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)，单击 **创建 API Key** ，作为后续接入业务代码的访问密钥。

<span id="enable_managed_agent"></span>

## 2. 开通 Managed Agents 服务

访问 [开通管理页面](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement)，切换到 **Managed Agents** 页签开通服务。

<span id="enable_model_service"></span>

## 3. 开通模型服务

访问 [开通管理页面](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement) 开通模型服务。

<span id="build_agent"></span>

# 构建 Agent

<span id="create_agent"></span>

## 1. 创建 Agent

Agent 是可版本化、可复用的智能体配置资产，定义角色、能力、行为边界和运行规则，是所有任务运行的模板和基准。

访问 [火山方舟控制台](https://console.volcengine.com/ark/region:ark+cn-beijing/ark/region:cn-beijing/managed-agents/agents?projectName=default)，进入 **Managed Agents** 模块。在 **Agents** 页面单击 **创建 Agent** ，跟随界面引导填写：

* **模型和系统提示词** ：选择一个 **模型** ，并编写 **系统提示词** ，为 Agent 设定角色、做事风格与工作原则。
* **Skills** ：从 **火山 SkillHub** 中挂载预置 **Skill** ，或本地上传自定义 **Skill** ，扩展 Agent 的领域能力。
* **Tools** ：勾选内置的 **Agent Toolset** （如 `bash`、`edit`、`read`、`write` 等基础工具），让 Agent 能够读写文件、执行命令。
* **MCPs** ：以 URL 形式接入远程 **MCP Server** ，把外部系统能力接入 Agent。
* **Multi Agents** ：将多个 Agent 组合成协同工作流，一个 Agent 可以调用另一个 Agent 完成子任务。

保存后，控制台会为该 Agent 生成一个稳定的 `agent_id`。每次修改配置都会自动生成新版本，支持版本对比、回滚和灰度发布。

<span id="create_environment"></span>

## 2. 创建 Environment

定义 Agent 的运行环境模板，预置依赖、环境变量等。Agent 创建时绑定，确保代码在一致环境中执行。

在 [Environments 页面](https://console.volcengine.com/ark/region:ark+cn-beijing/ark/region:cn-beijing/managed-agents/environments?projectName=default) 单击 **创建 Environment** ，跟随界面引导填写：

* **类型** ：当前仅支持 **云托管** ——沙箱由方舟按需拉起、自动休眠。
* **预装包** ：按需添加 `pip`、`apt` 依赖（如 `numpy`、`pandas`），沙箱首次启动时安装。
* **环境变量** ：以键值对形式注入到沙箱进程，沙箱启动时自动加载，供 Agent 执行的代码和命令直接读取。常用于配置业务侧的非敏感参数，例如设置时区 `TZ=Asia/Shanghai`。

保存后得到一个稳定的 `environment_id`。

<span id="debug_agent"></span>

# 调试 Agent

在控制台里以交互方式测试 Agent。每次调试创建一个 Session，展示事件流、工具调用、输入输出完整记录，可随时回放。

Session 是一次独立的 Agent 任务运行会话，包含从发起、执行到结束的完整生命周期：

1. 在 [Sessions 页面](https://console.volcengine.com/ark/region:ark+cn-beijing/ark/region:cn-beijing/managed-agents/sessions?projectName=default) 单击 **创建 Session** ，选择要绑定的 **Agent** 和 **Environment** 。
2. 在 **Session 详情** 页面调试会话：

   * **发起** ：在 **会话面板** 输入自然语言指令，或上传附件（表格、文档、代码、图片等）作为任务输入。
   * **观察** ： **事件时间轴（Trace）**  实时呈现 Agent 的思考过程、工具调用、代码执行、错误重试等全链路节点。
   * **验证** ：Session 结束后可查看 **最终交付产物** 、 **总耗时** 、 **Token 消耗** 、 **工具调用次数** 等运行统计，判断 Agent 行为是否符合预期。

反复调整 **系统提示词** 、 **Tools** 、 **Skills** ，直到 Session 试跑结果符合预期。

<span id="prototype_to_code"></span>

# 从原型到代码

Agent 配置验证通过后，把它接入到业务代码中只需两步。

<span id="copy_ids_from_console"></span>

## 1. 从控制台复制 ID

* 从 **Agent 详情页** 复制 `agent_id`。
* 从 **Environment 详情页** 复制 `environment_id`。
* 前往 [API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey) 单击 **创建 API Key** ，作为访问密钥。

<span id="create_session_in_code"></span>

## 2. 在代码中引用它们创建 Session

将 `agent_id`、`environment_id` 和 API Key 填入下面的请求，创建一个绑定该 Agent 与环境的 Session：

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "agent-xxxxxxxxxxxxxx-xxxxx",
    "environment_id": "env-xxxxxxxxxxxxxx-xxxxx",
    "title": "My first session"
  }'
```

拿到返回的 `session_id` 后，即可通过 Events API 向 Session 发送消息、通过 SSE 流式接收 Agent 的响应事件。详见 [发送消息并流式传输响应](https://www.volcengine.com/docs/82379/2553725)。

<a id="doc-2553716"></a>

---

## Agent

> 来源：[https://docs.volcengine.com/docs/82379/2553716?lang=zh](https://docs.volcengine.com/docs/82379/2553716?lang=zh)

方舟 Managed Agents 是火山方舟平台推出的全托管 Agent 服务，给您带来开箱即用的 Agent 体验。Agent 是方舟 Managed Agents 的基础元件，是一套包含基本信息、System Prompt、扩展能力（Skills、Tools、MCP 等）的配置模板，可以被任意 Session 复用，并支持版本化管理。本文介绍如何定义一个 Agent。

<span id=".YWdlbnQt5a6a5LmJ5a2X5q61"></span>

# Agent 定义字段

---

**name** `string` `必填`

Agent 名称，仅支持大写英文字母、小写英文字母、汉字、数字。长度限制：1 至 64 个字符。

---

**description** `string` `选填`

Agent 的补充说明，便于后续检索和维护。长度限制：不超过 300 个字符。

---

**model** `object` `必填`

Agent 使用的模型配置。

属性

---

model. **id** `string` `必填`

模型 ID。请填写你已开通的模型 ID。示例值：`doubao-seed-2-1-pro-260628`。

---

model. **speed** `string` `选填`

模型速度，可选值如下：

* `standard`：标准速度配置。
* `fast`：更快的速度配置。

---

**system** `string` `选填`

System Prompt，用于定义 Agent 的角色、行为边界和工作方式。你可以用这个字段说明 Agent 应该如何思考、如何回复，以及需要遵守哪些规则。

---

**skills** `object[]` `选填`

Agent 可自动调用的 Skills 列表。支持从 SkillHub 选择预置 Skills，也支持先上传自定义 Skills 再引用。详见 [Skills](https://www.volcengine.com/docs/82379/2553717)。

属性

---

skills. **type** `string` `必填`

Skill 来源类型，可选值如下：

* `skill_hub`：引用 SkillHub 中的预置 Skill。
* `custom`：引用通过 `CreateSkill` 上传的自定义 Skill。

---

skills. **skill_id** `string` `选填`

Skill 唯一标识符。

预置 Skill 的 ID 可前往 [SkillHub 页面](https://console.volcengine.com/skillhub) 查看；自定义 Skill 的 ID 可从 `CreateSkill` 返回的 `id` 中获取。

---

skills. **version** `string` `选填`

Skill 版本。需要指定某个自定义 Skill 版本时显式传入。

---

**tools** `object[]` `选填`

Agent 可调用的工具集合。当前支持内置 `agent_toolset_20260701`、`evolution` 与 `mcp_toolset`。详见 [Tools](https://www.volcengine.com/docs/82379/2553719)。

---

**multiagent** `object` `选填`

协调 Agent 的子 Agent 编排配置，用于委派任务。详见 [Multi Agent](https://www.volcengine.com/docs/82379/2553730)。

---

**mcp_servers** `object[]` `选填`

Agent 声明要接入的 MCP Server 列表。详见 [MCP](https://www.volcengine.com/docs/82379/2553718)。

---

**metadata** `map<string,string>` `选填`

业务侧自定义键值对，适合保存外部系统标识或标签。

<span id=".5YeG5aSH5bel5L2c"></span>

# 准备工作

1. 获取 API Key。API Key 是调用方舟平台模型和服务的鉴权信息。

   访问 [API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)页面，创建你的 API Key。
2. （推荐）配置环境变量。API Key 是敏感信息，一旦意外泄露，可能会造成资金损失或安全风险，因此强烈建议你不要在代码中明文写入 API Key，而应该将其配置到环境变量中。

   将以下命令中的 `your_api_key_here` 替换为你的 API Key，并在终端中运行命令，即可将 API Key 配置到环境变量中。详见 [环境变量配置指南](https://www.volcengine.com/docs/82379/1820161)。

   <Tabs>
   <Tab zoneid="vjejXIBWcz" title="macOS">
   <TabTitle>macOS</TabTitle>

   ```Bash
   export ARK_API_KEY="your_api_key_here"
   ```

   </Tab>
   <Tab zoneid="AHrmkyLjqu" title="Linux">
   <TabTitle>Linux</TabTitle>

   ```Bash
   export ARK_API_KEY="your_api_key_here"
   ```

   </Tab>
   <Tab zoneid="wJQm6B3X5v" title="Windows_CMD">
   <TabTitle>Windows_CMD</TabTitle>

   ```Bash
   setx ARK_API_KEY "your_api_key_here"
   ```

   </Tab>
   <Tab zoneid="hQvbTYznpE" title="Windows_PowerShell">
   <TabTitle>Windows_PowerShell</TabTitle>

   ```PowerShell
   $env:ARK_API_KEY = "your_api_key_here"
   ```

   </Tab>
   </Tabs>
3. 开通模型服务。

   访问[开通管理](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement) 页面，开通模型服务。

<span id=".5Yib5bu6LWFnZW50"></span>

# 创建 Agent

创建 Agent 后，接口会返回一个稳定的 Agent ID 和初始版本号 `1`。后续创建 Session 时，可以直接引用这个 Agent ID。

下面的示例创建了一个带内置工具集和预置 Skill 的热点新闻 Agent：

<Tabs>
<Tab zoneid="wmlYNd2Kdt" title="cURL">
<TabTitle>cURL</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "NewsAgent01",
    "model": {
      "id": "doubao-seed-2-1-pro-260628",
      "speed": "standard"
    },
    "description": "将热点新闻总结为图片的小助手。",
    "system": "你是一名热点新闻查询总结小助手，可将每天的前 10 条热点新闻以摘要图片的方式总结出来。",
    "skills": [
      {
        "type": "skill_hub",
        "skill_id": "s-yepozmp9tsf2adftt1hx"
      }
    ],
    "tools": [
      {
        "type": "agent_toolset_20260701"
      }
    ]
  }'
```

</Tab>
</Tabs>

其中 `s-yepozmp9tsf2adftt1hx` 表示你从 [SkillHub 页面](https://console.volcengine.com/skillhub) 查到的 Skill ID。

示例响应如下：

```json
{
  "id": "agent-2026070207****-*****",
  "type": "agent",
  "name": "NewsAgent01",
  "description": "将热点新闻总结为图片的小助手。",
  "version": 1,
  "model": {
    "id": "doubao-seed-2-1-pro-260628",
    "speed": "standard"
  },
  "system": "你是一名热点新闻查询总结小助手，可将每天的前 10 条热点新闻以摘要图片的方式总结出来。",
  "tools": [
    {
      "type": "agent_toolset_20260701",
      "default_config": {
        "enabled": true
      }
    }
  ],
  "skills": [
    {
      "type": "skill_hub",
      "skill_id": "s-yepozmp9tsf2adftt1hx"
    }
  ],
  "created_at": "2026-07-02T07:03:55Z",
  "updated_at": "2026-07-02T07:03:55Z"
}
```

<span id=".5pu05pawLWFnZW50LeS4jueJiOacrA=="></span>

# 更新 Agent 与版本

Agent 是版本化资源。每次更新配置时，都需要显式传入当前版本号；如果版本号不匹配，更新会失败。更新成功后，系统会生成一个新版本。

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip">将以下示例代码中的 <code>{agent_id}</code> 替换为待更新的 Agent ID。</div>

<Tabs>
<Tab zoneid="PdMCAjQCh5" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents/{agent_id} \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "version": 1,
    "system": "你是一名热点新闻查询总结小助手，可将每天的前 10 条热点新闻以摘要图片和音频播报的方式总结出来。",
    "skills": [
      {
        "type": "skill_hub",
        "skill_id": "s-yepozmp9tsf2adftt1hx"
      },
      {
        "type": "skill_hub",
        "skill_id": "s-yej50m054wyzaxeq073n"
      }
    ]
  }'
```

</Tab>
</Tabs>

示例响应如下：

```json
{
  "id": "agent-2026070207****-*****",
  "type": "agent",
  "name": "NewsAgent02",
  "description": "将热点新闻总结为图片的小助手。",
  "version": 2,
  "model": {
    "id": "doubao-seed-2-1-pro-260628",
    "speed": "standard"
  },
  "system": "你是一名热点新闻查询总结小助手，可将每天的前 10 条热点新闻以摘要图片和音频播报的方式总结出来。",
  "tools": [
    {
      "type": "agent_toolset_20260701",
      "default_config": {
        "enabled": true
      }
    }
  ],
  "skills": [
    {
      "type": "skill_hub",
      "skill_id": "s-yepozmp9tsf2adftt1hx"
    },
    {
      "type": "skill_hub",
      "skill_id": "s-yej50m054wyzaxeq073n"
    }
  ],
  "created_at": "2026-07-02T07:03:55Z",
  "updated_at": "2026-07-02T07:56:33Z"
}
```

更新 Agent 时，建议关注以下规则：

* 更新请求必须带当前 `version`。
* 修改配置后会生成新的 Agent 版本。
* 如果某些字段保持不变，可以只传需要修改的字段；例如只更新 `system` 时，不需要重复传 `tools`。
* `skills` 使用覆盖逻辑。请求体一旦传入 `skills`，系统会用该数组整体覆盖 Agent 当前的 `skills` 配置，不会在原有基础上追加。
* 如果你只想新增或调整某个 Skill，需要先读取当前 Agent 的 `skills`，再把“需要保留的 Skills + 新的 Skills”一起写回请求体。

<span id=".6K6-6K6h5bu66K6u"></span>

# 设计建议

* 把稳定能力放进 Agent，把一次性任务放进 Session 事件。
* `system` 只定义角色、约束和长期规则，不要把当前任务直接写进 `system`。
* 需要外部系统能力时，优先使用 MCP。
* 需要复用领域知识或执行规范时，优先挂载 Skills，而不是把大段操作手册直接塞进 `system`。

<span id=".55u45YWz5paH5qGj"></span>

# 相关文档

<columns>
<columnsItem zoneid="VXcNgNawyC">

<card mode="container" href="/docs/82379/2553717" >

**Skills**

Skills 用于给 Agent 补充领域知识、操作流程和最佳实践。

</card>

<card mode="container" href="/docs/82379/2553718" >

**MCP**

MCP（Model Context Protocol）用于把第三方系统的工具与数据源接入 Agent。

</card>

</columnsItem>
<columnsItem zoneid="USNnTwXS6d">

<card mode="container" href="/docs/82379/2553719" >

**Tools**

Tools 决定 Agent 在 Session 中能主动调用哪些执行能力。

</card>

<card mode="container" href="/docs/82379/2553720" >

**工具权限策略**

工具权限策略用于控制 Agent 发起工具调用时，是自动执行，还是暂停等待确认。

</card>

</columnsItem>
</columns>

<a id="doc-2553717"></a>

---

## Skills

> 来源：[https://docs.volcengine.com/docs/82379/2553717?lang=zh](https://docs.volcengine.com/docs/82379/2553717?lang=zh)

Skills 是可复用的能力包，用于给 Agent 补充领域知识、操作流程和最佳实践。与直接把大量规则写进 `system` 不同，Skills 更适合承载可复用、可维护的专业能力。

<span id=".6I635Y-WLXNraWxscw=="></span>

# 获取 Skills

方舟 Managed Agents 支持两类 Skills 来源：

* 预置 Skills：从 SkillHub 选择。
* 自定义 Skills：通过 `CreateSkill` 接口上传本地 Skills。

<span id=".5pa55byPLTHvvJrku44tc2tpbGxodWIt6YCJ5oup6aKE572uLXNraWxscw=="></span>

## 方式 1：从 SkillHub 选择预置 Skills

如果你使用的是平台预置 Skills，可以直接在 Agent 的 `skills` 配置中引用对应 Skill。预置 Skills 适合通用场景，例如文档处理、结构化内容生成或固定工作流编排。

由于预置 Skills 由平台统一维护，你不需要自己上传文件，也不需要关心版本包结构。选择完成后，把对应 Skill ID 写入 Agent 的 `skills` 数组即可。

如果你需要查询预置 Skill 的 ID，请前往 [SkillHub 页面](https://console.volcengine.com/skillhub) 查看。

<span id=".5pa55byPLTLvvJrkuIrkvKDoh6rlrprkuYktc2tpbGxz"></span>

## 方式 2：上传自定义 Skills

如果预置 Skills 无法覆盖你的场景，可以先通过 `CreateSkill` 接口上传本地 Skills，再在 Agent 中引用返回的 `skill_id`。

当前支持两种上传方式：

* Multipart：按文件逐个上传。
* Zip：直接上传本地压缩包。

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip">接口当前 <strong>不做文件格式校验</strong> 。但为了让 Skill 能被正确解析和执行，仍建议遵循约定的目录结构。</div>

<span id=".5LiK5Lyg6ZmQ5Yi25LiO55uu5b2V5bu66K6u"></span>

### 上传限制与目录建议

虽然接口当前不做文件格式校验，但仍建议按以下约束组织自定义 Skills：

* zip 文件大小不超过 **50 MB**
* 单个版本最多 **500** 个文件
* 解压后单个文件不超过 **25 MB**
* 仅包含 **1 个** `SKILL.md`

Zip 包推荐使用统一顶层目录，`SKILL.md` 放在顶层目录的直接子级：

```text
frontend-design.zip
└── frontend-design/
    ├── SKILL.md
    └── meta.json
```

<span id=".bXVsdGlwYXJ0LeS4iuS8oA=="></span>

### Multipart 上传

Multipart 方式适合在构建流程中按文件组织上传内容。`display_title` 是可选字段，`files[]` 用于承载多个文件。

<Tabs>
<Tab zoneid="Ma8GPCUyc7" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/skills \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -F "display_title=Web Artifacts Builder" \
  -F "files[]=@./basic_math/SKILL.md;filename=basic_math/SKILL.md;type=text/markdown" \
  -F "files[]=@./basic_math/scripts/init.sh;filename=basic_math/scripts/init.sh;type=text/plain"
```

</Tab>
</Tabs>

其中：

* `files[]` 是上传字段名。
* `@` 后面是本地真实路径。
* `filename=` 指定服务端识别到的相对路径。
* `type=` 是 MIME 类型，可以省略。

<span id=".emlwLeS4iuS8oA=="></span>

### Zip 上传

Zip 方式更适合把整个 Skill 目录一次性打包上传：

<Tabs>
<Tab zoneid="V7p24jjOrC" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/skills \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -F "files=@./basic_math.zip;type=application/zip"
```

</Tab>
</Tabs>

成功上传后，接口会返回 Skill 记录，重点关注 `id` 和 `latest_version`：

```json
{
  "id": "skill-20260702082507-x6vpp",
  "object": "skill",
  "created_at": 1782980707,
  "description": "A minimal local skill bundle for CreateSkill API testing.",
  "latest_version": "1",
  "name": "minimal-news-skill"
}
```

其中 `id` 就是后续挂载到 Agent 时要引用的 `skill_id`。

<span id=".5ZyoLWFnZW50LeS4iuW8leeUqC1za2lsbHM="></span>

# 在 Agent 上引用 Skills

获取 Skills 后，你需要在 `CreateAgent` 或 `UpdateAgent` 的 `skills` 字段中引用 Skill。

* 预置 Skills：从 SkillHub 选择后，把对应 Skill ID 写入 `skills`。
* 自定义 Skills：先调用 `CreateSkill` 上传，拿到 `skill_id` 后再写入 `skills`。如果需要指定自定义 Skill 的版本，请显式传入 `version`，否则通常使用默认版本。

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip">单个 Agent 最多可配置 20 个 Skills。</div>

<span id=".c2tpbGxzLeWtl-autee7k-aehA=="></span>

## `skills` 字段结构

在 `CreateAgent` 或 `UpdateAgent` 请求中，每个 Skill 条目都通过 `skills` 数组声明。常用字段及其含义如下：

---

**skills** `object[]` `选填`

Agent 可自动调用的 Skills 列表。支持从 SkillHub 选择预置 Skills，也支持先上传自定义 Skills 再引用。详见 [Skills](https://www.volcengine.com/docs/82379/2553717)。

属性

---

skills. **type** `string` `必填`

Skill 来源类型，可选值如下：

* `skill_hub`：引用 SkillHub 中的预置 Skill。
* `custom`：引用通过 `CreateSkill` 上传的自定义 Skill。

---

skills. **skill_id** `string` `选填`

Skill 唯一标识符。

预置 Skill 的 ID 可前往 [SkillHub 页面](https://console.volcengine.com/skillhub) 查看；自定义 Skill 的 ID 可从 `CreateSkill` 返回的 `id` 中获取。

---

skills. **version** `string` `选填`

Skill 版本。需要固定某个 Skill 版本时显式传入。

---

<span id=".56S65L6L5Luj56CB"></span>

## 示例代码

示例如下：

<Tabs>
<Tab zoneid="inILCIfkUl" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "数据处理 Agent",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "skills": [
      {
        "type": "skill_hub",
        "skill_id": "s-yepozmp9tsf2adftt1hx"
      },
      {
        "type": "custom",
        "skill_id": "skill-20260702082507-x6vpp",
        "version": "1"
      }
    ]
  }'
```

</Tab>
</Tabs>

其中：

* `s-yepozmp9tsf2adftt1hx` 表示你从 [SkillHub 页面](https://console.volcengine.com/skillhub) 查到的预置 Skill ID。
* `skill-20260702082507-x6vpp` 表示 `CreateSkill` 返回的自定义 Skill ID。

<span id=".5L2_55So5bu66K6u"></span>

# 使用建议

* 对稳定、通用的能力，优先选择 SkillHub 中的预置 Skills。
* 对团队私有流程、内部规范或自定义操作手册，使用自定义 Skills。
* 不要把一次性任务描述写进 Skill；Skill 负责定义能力，具体任务应通过 Session 事件传入。
* 上传前建议在本地先确认 `SKILL.md`、脚本和依赖文件路径关系，避免上传后引用失败。

<span id=".55u45YWz5paH5qGj"></span>

# 相关文档

<columns>
<columnsItem zoneid="NBSbiD4BOD">

<card mode="container" href="/docs/82379/2553716" >

**Agent**

Agent 是包含基本信息、System Prompt、扩展能力的配置模板。

</card>

<card mode="container" href="/docs/82379/2553718" >

**MCP**

MCP（Model Context Protocol）用于把第三方系统的工具与数据源接入 Agent。

</card>

</columnsItem>
<columnsItem zoneid="bd7XdvAa34">

<card mode="container" href="/docs/82379/2553719" >

**Tools**

Tools 决定 Agent 在 Session 中能主动调用哪些执行能力。

</card>

<card mode="container" href="/docs/82379/2553720" >

**工具权限策略**

工具权限策略用于控制 Agent 发起工具调用时，是自动执行，还是暂停等待确认。

</card>

</columnsItem>
</columns>

<a id="doc-2553718"></a>

---

## MCP

> 来源：[https://docs.volcengine.com/docs/82379/2553718?lang=zh](https://docs.volcengine.com/docs/82379/2553718?lang=zh)

MCP（Model Context Protocol）用于把第三方系统的工具与数据源接入 Agent。通过 MCP，Agent 可以访问外部服务暴露出来的标准化工具，例如代码托管、项目协作、知识库或内部业务系统。

在方舟 Managed Agents 中，MCP 配置分成两层：

* Agent 定义层：声明要连接哪些 MCP Server。
* Session 运行层：通过 Vaults 注入对应凭据，完成鉴权。

这种拆分让 Agent 定义保持可复用，同时避免把终端用户密钥固定地写在 Agent 资源里。

<span id=".5ZyoLWFnZW50LeS4iuWjsOaYji1tY3Atc2VydmVy"></span>

# 在 Agent 上声明 MCP Server

创建 Agent 时，通过 `mcp_servers` 数组声明 MCP Server。每个 Server 需要三个字段：

<span aceTableMode="list" aceTableWidth="1,3"></span>
|字段 |说明 |
|---|---|
|`type` |MCP Server 的声明方式。当前统一使用 URL 方式声明，值为 `url`。 |
|`name` |MCP Server 名称，需在当前 Agent 内唯一。后续 `mcp_toolset` 通过该字段引用。 |
|`url` |MCP Server 的访问地址。 |

每个 `mcp_servers` 条目，都必须有一个同名的 `mcp_toolset` 条目与之对应；反过来，每个 `mcp_toolset` 也必须引用一个已声明的 MCP Server。

下面的示例把一个 GitHub MCP Server 挂到 Agent：

<Tabs>
<Tab zoneid="PGACOZAOeR" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "GitHub 助理",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "mcp_servers": [
      {
        "type": "url",
        "name": "github",
        "url": "https://mcp.example.com/github"
      }
    ],
    "tools": [
      {
        "type": "agent_toolset_20260701"
      },
      {
        "type": "mcp_toolset",
        "mcp_server_name": "github"
      }
    ]
  }'
```

</Tab>
</Tabs>

<span id=".5o6n5Yi25ZOq5LqbLW1jcC3lt6Xlhbflj6_nlKg="></span>

# 控制哪些 MCP 工具可用

`mcp_toolset` 的配置方式与内置工具集一致，也支持 `default_config` 和 `configs`。

如果某个 MCP Server 暴露的工具很多，建议先整体关闭，再按白名单开启：

<Tabs>
<Tab zoneid="apj2ZXYgLH" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "精简 GitHub 助理",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "mcp_servers": [
      {
        "type": "url",
        "name": "github",
        "url": "https://mcp.example.com/github"
      }
    ],
    "tools": [
      {
        "type": "mcp_toolset",
        "mcp_server_name": "github",
        "default_config": {
          "enabled": false
        },
        "configs": [
          {
            "name": "list_issues",
            "enabled": true
          },
          {
            "name": "get_issue",
            "enabled": true
          },
          {
            "name": "add_issue_comment",
            "enabled": true
          }
        ]
      }
    ]
  }'
```

</Tab>
</Tabs>

如果你只想关闭少量 MCP 工具，也可以省略 `default_config`，直接在 `configs` 里把对应工具设为 `enabled: false`。

<span id=".5ZyoLXNlc3Npb24t5Lit5rOo5YWlLW1jcC3lh63mja4="></span>

# 在 Session 中注入 MCP 凭据

MCP Server 的认证不在 Agent 定义阶段传入，而是在创建 Session 时通过 `vault_ids` 引用 Vaults 中的凭据。这样你可以让同一个 Agent 在不同 Session 中代表不同终端用户访问外部系统。

最简示例如下：

<Tabs>
<Tab zoneid="dSPOXLl6Lf" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "agt_xxxxxx",
    "environment_id": "env_xxxxxx",
    "vault_ids": ["vlt_xxxxxx"]
  }'
```

</Tab>
</Tabs>

Vaults 的创建方法、`mcp_oauth` / `static_bearer` 等凭据类型，以及多 Vaults 匹配规则，详情请参见 [使用 Vaults 认证](https://www.volcengine.com/docs/82379/2553726)。

<span id=".57qm5p2f5LiO5bu66K6u"></span>

# 约束与建议

* 同一个 Agent 中，`mcp_servers.name` 必须唯一。
* `mcp_servers` 与 `mcp_toolset` 必须一一对应，不能只声明其一。
* 不要把终端用户 token 直接写进 Agent 定义；应通过 Vaults 在 Session 级注入。
* 对高风险 MCP 工具，建议配合 [工具权限策略](https://www.volcengine.com/docs/82379/2553720) 使用 `always_ask`。

<span id=".55u45YWz5paH5qGj"></span>

# 相关文档

<columns>
<columnsItem zoneid="cItNPNcmUS">

<card mode="container" href="/docs/82379/2553716" >

**Agent**

Agent 是包含基本信息、System Prompt、扩展能力的配置模板。

</card>

<card mode="container" href="/docs/82379/2553717" >

**Skills**

Skills 用于给 Agent 补充领域知识、操作流程和最佳实践。

</card>

</columnsItem>
<columnsItem zoneid="xC0mIydAfY">

<card mode="container" href="/docs/82379/2553719" >

**Tools**

Tools 决定 Agent 在 Session 中能主动调用哪些执行能力。

</card>

<card mode="container" href="/docs/82379/2553720" >

**工具权限策略**

工具权限策略用于控制 Agent 发起工具调用时，是自动执行，还是暂停等待确认。

</card>

</columnsItem>
</columns>

<a id="doc-2553719"></a>

---

## Tools

> 来源：[https://docs.volcengine.com/docs/82379/2553719?lang=zh](https://docs.volcengine.com/docs/82379/2553719?lang=zh)

Tools 决定 Agent 在 Session 中能主动调用哪些执行能力。当前方舟 Managed Agents 支持以下工具类型：

* 内置工具集：`agent_toolset_20260701`
* 演进工具：`evolution`
* MCP 工具集：`mcp_toolset`

  <div data-tips="true" data-tips-type="tip" data-tips-is-title="true" data-wrapper-indent="1">说明   </div>

  <div data-tips="true" data-tips-type="tip" data-wrapper-indent="1">当前 <strong>不支持自定义工具</strong> 。如果你需要让 Agent 调用外部系统能力，请通过 <a href="https://www.volcengine.com/docs/82379/2553718">MCP</a> 接入。   </div>

<span id=".5pSv5oyB55qE5bel5YW3"></span>

# 支持的工具

<span id=".5YaF572u5bel5YW35YiX6KGo"></span>

## 内置工具列表

内置工具集包含以下工具。把 `agent_toolset_20260701` 加到 Agent 后，这些工具默认全部启用。

<span aceTableMode="list" aceTableWidth="1,1,3"></span>
|工具 |配置名 |说明 |
|---|---|---|
|Bash |`bash` |在沙箱中执行 Bash 命令。 |
|Read |`read` |读取沙箱内文件。 |
|Write |`write` |写入或覆盖沙箱内文件。 |
|Edit |`edit` |对文件执行字符串替换。 |
|Glob |`glob` |按名称查找文件。 |
|Grep |`grep` |按正则搜索文本内容。 |
|Web Fetch |`web_fetch` |抓取指定 URL 内容。 |
|Web Search |`web_search` |发起联网搜索。<br><br><div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div><br><br><br><div data-tips="true" data-tips-type="warning">按实际调用次数计费。</div><br> |

<span id=".ZXZvbHV0aW9uLeW3peWFtw=="></span>

## Evolution 工具

`evolution` 是一个特殊工具类型，用于承载 Agent 的演进能力配置。当前 `evolution` 下仅包含一个工具：`advisor`。

`evolution` 主要支持以下配置结构：

* `configs[].name`
* `configs[].enabled`

其中，控制台中的 Advisor 开关对应 `configs[].enabled`。`evolution` / `advisor` 不支持手动配置 `permission_policy`。

当前推荐把 `advisor` 作为显式配置项写入 `configs`，便于后续按工具粒度扩展。

示例如下：

<Tabs>
<Tab zoneid="H9Fe1NEGuF" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "自演进 Agent",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "tools": [
      {
        "type": "agent_toolset_20260701"
      },
      {
        "type": "evolution",
        "configs": [
          {
            "name": "advisor",
            "enabled": true
          }
        ]
      }
    ]
  }'
```

</Tab>
</Tabs>

如果你当前只需要开启默认演进能力，可以只保留 `type: "evolution"`；如果你需要对 `advisor` 做显式开关控制，使用 `configs[].enabled` 即可。

<span id=".6YWN572u5bel5YW36ZuG"></span>

# 配置工具集

<span id=".5ZCv55So5YaF572u5bel5YW36ZuG"></span>

## 启用内置工具集

如果你希望 Agent 默认具备基础执行能力，最简单的做法是在创建 Agent 时直接挂载 `agent_toolset_20260701`：

<Tabs>
<Tab zoneid="pSpGyOXLVW" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "代码助理",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "tools": [
      {
        "type": "agent_toolset_20260701"
      }
    ]
  }'
```

</Tab>
</Tabs>

<span id=".56aB55So6YOo5YiG5bel5YW3"></span>

## 禁用部分工具

如果你不希望 Agent 具备某些能力，可以在 `configs` 中按工具名关闭：

<Tabs>
<Tab zoneid="FadDX18wEY" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "离线文档助理",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "tools": [
      {
        "type": "agent_toolset_20260701",
        "configs": [
          {
            "name": "web_fetch",
            "enabled": false
          },
          {
            "name": "web_search",
            "enabled": false
          }
        ]
      }
    ]
  }'
```

</Tab>
</Tabs>

这种方式适合对联网能力有明确限制的场景。

<span id=".5Y-q5byA5ZCv5bCR6YeP5bel5YW3"></span>

## 只开启少量工具

如果你只想开放最小工具集，可以先把工具集整体关闭，再显式打开需要的工具：

<Tabs>
<Tab zoneid="agvCKlOH98" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "只读审查 Agent",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "tools": [
      {
        "type": "agent_toolset_20260701",
        "default_config": {
          "enabled": false
        },
        "configs": [
          {
            "name": "read",
            "enabled": true
          },
          {
            "name": "glob",
            "enabled": true
          },
          {
            "name": "grep",
            "enabled": true
          }
        ]
      }
    ]
  }'
```

</Tab>
</Tabs>

这种配置适合代码审查、资料检索等只读场景。

<span id=".5LiOLW1jcC3lt6XlhbfphY3lkIjkvb_nlKg="></span>

# 与 MCP 工具配合使用

内置工具解决的是沙箱内执行和通用联网能力，`evolution` 用于配置 Agent 演进能力，MCP 工具解决的是第三方系统能力。一个 Agent 可以同时挂载三者，例如：

* 用 `agent_toolset_20260701` 读取文件、执行命令、抓取网页。
* 用 `evolution` 打开 `advisor` 等演进相关能力。
* 用 `mcp_toolset` 调 GitHub、Linear、Slack 等外部系统。

MCP 的声明方法与鉴权方式详见 [MCP](https://www.volcengine.com/docs/82379/2553718)。

<span id=".5bel5YW35p2D6ZmQ562W55Wl"></span>

# 工具权限策略

工具是否自动执行由权限策略控制。常见做法是：

* 对内置工具使用默认自动放行。
* 对 `evolution` 按工具粒度配置 `advisor` 的启停。
* 对 MCP 工具使用默认人工确认，或只对白名单工具自动放行。

详见[工具权限策略](https://www.volcengine.com/docs/82379/2553720)。

<span id=".55u45YWz5paH5qGj"></span>

# 相关文档

<columns>
<columnsItem zoneid="TuC5rgxu3U">

<card mode="container" href="/docs/82379/2553716" >

**Agent**

Agent 是包含基本信息、System Prompt、扩展能力的配置模板。

</card>

<card mode="container" href="/docs/82379/2553717" >

**Skills**

Skills 用于给 Agent 补充领域知识、操作流程和最佳实践。

</card>

</columnsItem>
<columnsItem zoneid="Jo62aAfsuV">

<card mode="container" href="/docs/82379/2553718" >

**MCP**

MCP（Model Context Protocol）用于把第三方系统的工具与数据源接入 Agent。

</card>

<card mode="container" href="/docs/82379/2553720" >

**工具权限策略**

工具权限策略用于控制 Agent 发起工具调用时，是自动执行，还是暂停等待确认。

</card>

</columnsItem>
</columns>

<a id="doc-2553720"></a>

---

## 工具权限策略

> 来源：[https://docs.volcengine.com/docs/82379/2553720?lang=zh](https://docs.volcengine.com/docs/82379/2553720?lang=zh)

工具权限策略用于控制 Agent 发起工具调用时，是自动执行，还是暂停等待确认。

当前权限策略只作用于服务端执行的工具：

* 内置工具集 `agent_toolset_20260701`
* MCP 工具集 `mcp_toolset`

<span id=".5p2D6ZmQ562W55Wl57G75Z6L"></span>

# 权限策略类型

<span aceTableMode="list" aceTableWidth="1,3"></span>
|策略 |说明 |
|---|---|
|`always_allow` |工具调用自动执行，不需要人工确认。 |
|`always_ask` |工具调用前暂停，等待确认后再继续。 |

默认行为如下：

* `agent_toolset_20260701` 默认使用 `always_allow`。
* `mcp_toolset` 默认使用 `always_ask`。

这套默认值适合大多数场景：内置工具风险相对可控，MCP 工具则更适合先收紧再按需放开。

<span id=".5Li65pW05Liq5bel5YW36ZuG6K6-572u5p2D6ZmQ562W55Wl"></span>

# 为整个工具集设置权限策略

你可以在 `default_config.permission_policy` 中为整个工具集配置统一策略。

下面的示例把内置工具集的默认策略改成 `always_ask`：

<Tabs>
<Tab zoneid="pJiZ0XhRxh" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "谨慎执行 Agent",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "tools": [
      {
        "type": "agent_toolset_20260701",
        "default_config": {
          "permission_policy": {
            "type": "always_ask"
          }
        }
      }
    ]
  }'
```

</Tab>
</Tabs>

如果你省略 `default_config.permission_policy`，系统会回退到该工具集的默认策略。

<span id=".5Li65Y2V5Liq5bel5YW36KaG55uW5p2D6ZmQ562W55Wl"></span>

# 为单个工具覆盖权限策略

除了为整个工具集设置默认策略外，你还可以在 `configs` 中对单个工具做更细粒度的覆盖。

下面的示例保留内置工具集默认自动执行，但要求 `bash` 每次执行前都先确认：

<Tabs>
<Tab zoneid="enqaXr2vzN" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "命令审慎 Agent",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "tools": [
      {
        "type": "agent_toolset_20260701",
        "configs": [
          {
            "name": "bash",
            "permission_policy": {
              "type": "always_ask"
            }
          }
        ]
      }
    ]
  }'
```

</Tab>
</Tabs>

这种覆盖关系适合把大部分低风险工具保持自动执行，只对高风险工具额外加一道确认。

<span id=".ZXZvbHV0aW9uLeivtOaYjg=="></span>

# Evolution 说明

`evolution` / `advisor` 不支持 `permission_policy` 配置。你可以通过 `configs[].enabled` 控制 Advisor 开关，但不应在请求体中手动传入：

* `default_config.permission_policy`
* `configs[].permission_policy`

如果你需要控制 Advisor 的启停，详情请参见 [Tools](https://www.volcengine.com/docs/82379/2553719)。

<span id=".5Li6LW1jcC3lt6Xlhbfpm4borr7nva7mnYPpmZDnrZbnlaU="></span>

# 为 MCP 工具集设置权限策略

`mcp_toolset` 默认是 `always_ask`。如果你信任某个 MCP Server，也可以显式改成 `always_allow`：

<Tabs>
<Tab zoneid="MJuJAUqfG9" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "GitHub 协作 Agent",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "mcp_servers": [
      {
        "type": "url",
        "name": "github",
        "url": "https://mcp.example.com/github"
      }
    ],
    "tools": [
      {
        "type": "agent_toolset_20260701"
      },
      {
        "type": "mcp_toolset",
        "mcp_server_name": "github",
        "default_config": {
          "permission_policy": {
            "type": "always_allow"
          }
        }
      }
    ]
  }'
```

</Tab>
</Tabs>

<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>

<div data-tips="true" data-tips-type="warning">只有在你确认该 MCP Server 及其暴露工具都可信时，才建议使用 <code>always_allow</code>。如果 MCP Server 未来新增了工具，自动放行也会一并生效。</div>

<span id=".5L2_55So5bu66K6u"></span>

# 使用建议

* 对只读工具，可以优先考虑 `always_allow`。
* 对会修改文件、执行命令或访问外部系统的工具，建议优先考虑 `always_ask`。
* 对 MCP 工具，建议先按最小权限原则收敛 `configs`，再决定是否自动放行。

如果你还没有配置工具集本身，详情请参见 [Tools](https://www.volcengine.com/docs/82379/2553719)。如果你要管理 MCP Server 及其工具，详情请参见 [MCP](https://www.volcengine.com/docs/82379/2553718)。

<span id=".55u45YWz5paH5qGj"></span>

# 相关文档

<columns>
<columnsItem zoneid="LK2XQsiwuc">

<card mode="container" href="/docs/82379/2553716" >

**Agent**

Agent 是包含基本信息、System Prompt、扩展能力的配置模板。

</card>

<card mode="container" href="/docs/82379/2553717" >

**Skills**

Skills 用于给 Agent 补充领域知识、操作流程和最佳实践。

</card>

</columnsItem>
<columnsItem zoneid="VUrV2XCWF7">

<card mode="container" href="/docs/82379/2553718" >

**MCP**

MCP（Model Context Protocol）用于把第三方系统的工具与数据源接入 Agent。

</card>

<card mode="container" href="/docs/82379/2553719" >

**Tools**

Tools 决定 Agent 在 Session 中能主动调用哪些执行能力。

</card>

</columnsItem>
</columns>

<a id="doc-2553721"></a>

---

## 配置云环境

> 来源：[https://docs.volcengine.com/docs/82379/2553721?lang=zh](https://docs.volcengine.com/docs/82379/2553721?lang=zh)

本文介绍如何为方舟 Managed Agents 创建云端沙箱环境。

您需要创建环境（Environment）描述 Agent 运行时使用的配置。在创建 Session 时，可通过环境 ID 引用其需要使用的环境。

一个环境配置可被多个 Session 复用，但每个 Session 会启动独立的沙箱实例，文件系统状态彼此隔离。

<span id=".5Yib5bu6546v5aKD"></span>

## 创建环境

在控制台的 [Environments](https://ark.volcengine.com/region:cn-beijing/managed-agents/environments) 页面或使用编程语言创建环境。

> 创建环境时建议使用清晰且唯一的名称，便于后续在组织或工作区内区分不同用途的环境。

参考以下示例代码，使用 API 创建环境：

```bash
environment=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/environments" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<'EOF'
{
  "name": "<ENVIRONMENT_NAME>",
  "config": {
    "type": "cloud",
    "networking": {
      "type": "unrestricted"
      },
    "packages": {
      "pip": ["pandas"],
      "apt": ["curl"]
    },
    "env": {
      "MY_KEY_0": "value_0",
      "MY_KEY_1": "value_1"
    }
  }
}
EOF
)

ENVIRONMENT_ID=$(jq -er '.id' <<<"$environment")

echo "Environment ID: $ENVIRONMENT_ID"
```

配置项：

* `name`: 值需要唯一。
* `description`: 对该环境的说明信息。
* `config.type`： 当前支持云端环境，值为 cloud。
* `config.networking.type`：沙箱的出站网络访问设置，值为 unrestricted，允许完整出站网络访问，但仍会受到通用安全拦截列表限制。
* `config.packages`：指定启动时预安装的依赖包，依赖会在使用同一环境的 Session 之间缓存。若同时配置多个包管理器，会按包管理器名称的字母序执行：`apt`、`cargo`、`gem`、`go`、`npm`、`pip`。依赖版本可以显式锁定；未指定版本时默认安装最新版本。支持的包管理器如下。| 字段      | 包管理器           | 示例                                          |
  | --------- | ------------------ | --------------------------------------------- |
  | `apt`   | 系统包（apt\-get） | `"ffmpeg"`                                  |
  | `cargo` | Rust（cargo）      | `"ripgrep@14.0.0"`                          |
  | `gem`   | Ruby（gem）        | `"rails:7.1.0"`                             |
  | `go`    | Go modules         | `"golang.org/x/tools/cmd/goimports@latest"` |
  | `npm`   | Node.js（npm）     | `"express@4.18.0"`                          |
  | `pip`   | Python（pip）      | `"pandas==2.2.0"`                           |
* 在 config.env 中指定需要注入环境变量。

<span id=".5ZyoLXNlc3Npb24t5Lit5L2_55So546v5aKD"></span>

## 在 Session 中使用环境

创建环境后，在创建 Session 时指定环境 ID。环境定义运行沙箱模板；Session 为一次 Agent 运行。

```bash
session=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/sessions" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "agent": "$AGENT_ID",
  "environment_id": "$ENVIRONMENT_ID",
  "title": "Quickstart session"
}
EOF
)

SESSION_ID=$(jq -er '.id' <<<"$session")

echo "Session ID: $SESSION_ID"
```

<span id=".546v5aKD55Sf5ZG95ZGo5pyf"></span>

## 环境生命周期

* 多个 Session 可以引用同一个环境，但每个 Session 都会获得独立的沙箱实例。
* Session 之间不共享文件系统状态。
* 环境本身不做版本化管理。如果你频繁更新环境配置，建议在业务侧记录变更，以便追溯某个 Session 使用的是哪一版环境。

<span id=".566h55CG546v5aKD"></span>

## 管理环境

你可以列出、查看或删除环境。

```bash
# List environments
environments=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/environments" \
    -H "Authorization: Bearer $ARK_API_KEY"
)

# Retrieve a specific environment
environment=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/environments/$ENVIRONMENT_ID" \
    -H "Authorization: Bearer $ARK_API_KEY"
)

# Update environment description
environment=$(
  curl -sS --fail-with-body -X POST "https://ark.cn-beijing.volces.com/api/v3/environments/$ENVIRONMENT_ID" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<'EOF'
{
  "description": "<UPDATED_ENVIRONMENT_DESC>"
}
EOF
)

# Delete an environment (only if no sessions reference it)
curl -sS --fail-with-body -X DELETE \
  "https://ark.cn-beijing.volces.com/api/v3/environments/$ENVIRONMENT_ID" \
  -H "Authorization: Bearer $ARK_API_KEY"
```

<span id=".6aKE572u6L-Q6KGM5pe2"></span>

## 预置运行时

云沙箱默认包含常见语言运行时、数据库和工具。需要确认具体内置版本或完整清单时，请参考[云沙箱参考](https://www.volcengine.com/docs/82379/2553722)。

<a id="doc-2553722"></a>

---

## 云沙箱参考

> 来源：[https://docs.volcengine.com/docs/82379/2553722?lang=zh](https://docs.volcengine.com/docs/82379/2553722?lang=zh)

本文介绍 Managed Agents 云端沙箱预安装的编程语言、数据库、常用工具（Utilities）和基础资源规格，便于在配置环境或评估任务依赖时快速参考。

云端沙箱运行在方舟提供的隔离 Linux 容器中。运行时、数据库客户端和常用命令行工具已预安装，Agent 可以直接使用。

> 本文中规格描述适用于 `cloud` 类型的 Environments。

<span id=".57yW56iL6K-t6KiA"></span>

## 编程语言

预装常见编程语言及其对应的包管理工具，可直接用于脚本执行、项目构建和依赖安装。

| 编程语言 | 版本    | 包管理工具      |
| -------- | ------- | --------------- |
| Python   | 3.12+   | pip, uv         |
| Node.js  | 20+     | npm, yarn, pnpm |
| Go       | 1.25+   | go modules      |
| Rust     | 1.77+   | cargo           |
| Java     | 21+     | maven, gradle   |
| Ruby     | 3.3+    | bundler, gem    |
| PHP      | 8.3+    | composer        |
| C/C++    | GCC 13+ | make, cmake     |

<span id=".5pWw5o2u5bqT"></span>

## 数据库

默认提供轻量数据库和数据库客户端，适合本地数据处理，或连接外部数据库/实例。

| 数据库            | 描述                                     |
| ----------------- | ---------------------------------------- |
| SQLite            | 已预安装，可立即使用                     |
| PostgreSQL 客户端 | 用于连接外部数据库的`psql` 客户端。    |
| Redis 客户端      | 用于连接外部 Redis 实例的`redis-cli`。 |

* SQLite 可在本地使用。
* 数据库服务器，例如 PostgreSQL 和 Redis，默认不在沙箱环境中运行。沙箱提供用于连接的客户端工具。

<span id=".dXRpbGl0aWVzLeW3peWFtw=="></span>

## Utilities 工具

内置多类常用工具，覆盖系统操作、开发构建、文件搜索、进程查看和文本处理等场景。

<span id=".57O757uf5bel5YW3"></span>

### 系统工具

| 工具                        | 描述                                     |
| --------------------------- | ---------------------------------------- |
| `git`                     | 版本控制。                               |
| `curl`, `wget`          | HTTP 客户端。                            |
| `jq`                      | JSON 处理。                              |
| `tar`, `zip`, `unzip` | 归档、压缩与解压工具。                   |
| `ssh`, `scp`            | 远程访问与文件传输工具（需要启用网络）。 |
| `tmux`, `screen`        | 终端多路复用工具。                       |

<span id=".5byA5Y-R5bel5YW3"></span>

### 开发工具

| 工具                 | 描述             |
| -------------------- | ---------------- |
| `make`, `cmake`  | 构建系统。       |
| `ripgrep` (`rg`) | 快速文件搜索。   |
| `tree`             | 目录结构可视化。 |
| `htop`             | 进程监控。       |

<span id=".5paH5pys5aSE55CG"></span>

### 文本处理

| 工具                       | 描述                 |
| -------------------------- | -------------------- |
| `sed`, `awk`, `grep` | 流式文本处理工具。   |
| `vim`, `nano`          | 文本编辑器。         |
| `diff`, `patch`        | 文件比较与补丁工具。 |

<span id=".5rKZ566x6KeE5qC8"></span>

## 沙箱规格

以下为云端沙箱的基础资源规格，可用于评估运行时资源和网络能力。

| 属性     | 具体配置         |
| -------- | ---------------- |
| 操作系统 | Ubuntu 22.04 LTS |
| 架构     | x86_64 (amd64)   |
| 内存     | 4 GB             |
| 磁盘空间 | 10 GB            |
| 网络     | 默认开启         |

<span id=".5YWz6ZSu55uu5b2V5Y-KLWFnZW50Leadg-mZkA=="></span>

## 关键目录及 Agent 权限

云端沙箱的文件系统按用途划分为 **工作区** 、 **挂载目录** 和 **临时目录** 三类。挂载目录 `/mnt` 下进一步区分只读的知识与资源（Memory、Skills、上传文件）和读写的产出与存储（Outputs、Storage）。Agent 通过标准文件工具访问这些目录，权限由平台强制约束。

<span id=".55uu5b2V5biD5bGA"></span>

### 目录布局

```text
/
├── workspace/                # 工作区，读写，Agent 的主要工作目录
│   └── AGENTS.md             # System Prompt，只读
├── mnt/                      # 挂载目录
│   ├── memory/               # Agent Memory，只读，见 persistent-memory
│   ├── skills/               # Agent Skills，只读，见 skills
│   └── session/
│       ├── uploads/          # 用户上传文件挂载目录，只读，见 upload-and-mount-files
│       ├── outputs/          # Agent 产出目录，读写，通过 Files API 回传给用户
│       └── storage/          # 用户 TOS 挂载目录，读写
└── tmp/                      # 临时目录，读写
```

<span id=".55uu5b2V5p2D6ZmQ"></span>

### 目录权限

| 目录                     | 用途                                                                                                       | Agent 读权限 | Agent 写权限 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------ | ------------ |
| `$HOME`                | 用户 Home                                                                                                  | ✓           | ✓           |
| `/workspace`           | 工作区，Agent 的主要工作目录**注意** ：`/workspace/AGENTS.md`（System Prompt）为 read\-only 权限。 | ✓           | ✓           |
| `/mnt`                 | 挂载目录                                                                                                   | ✓           | ✓           |
| `/mnt/memory`          | Agent Memory 目录，参见[Memory](https://www.volcengine.com/docs/82379/2553728)                              | ✓           | ✗           |
| `/mnt/skills`          | Agent Skills 目录，参见[Skills](https://www.volcengine.com/docs/82379/2553717)                              | ✓           | ✗           |
| `/mnt/session/uploads` | Files API 上传文件挂载目录，参见[上传并挂载文件](https://www.volcengine.com/docs/82379/2553727)             | ✓           | ✗           |
| `/mnt/session/outputs` | Agent 产出目录，写入这里的文件可通过 Files API 回传给用户                                                  | ✓           | ✓           |
| `/mnt/session/storage` | 用户 TOS 挂载目录                                                                                          | ✓           | ✓           |
| `/tmp`                 | 临时目录                                                                                                   | ✓           | ✓           |
| 其它任意路径             | \-                                                                                                         | ✗           | ✗           |

<span id=".5L2_55So6KeE5YiZ"></span>

### 使用规则

Agent 在沙箱中读写文件时应遵循以下规则，避免误改只读资源或将中间产物遗留到用户可见目录：

* **主要工作目录** ：使用 `/workspace` 存放项目文件、中间构建产物、脚本执行结果等 Agent 的主要工作内容。
* **读取用户输入** ：从 `/mnt/session/uploads` 读取用户通过 Files API 上传的文件；该目录只读，如需修改，请在 `/workspace` 或 `/mnt/session/outputs` 下创建派生文件。
* **写入最终产物** ：将需要回传给用户的最终交付物写入 `/mnt/session/outputs`；写入此目录的文件可通过 Files API 下载。
* **持久化用户数据** ：仅在任务明确要求跨 Session 共享用户数据时，才使用 `/mnt/session/storage`（挂载到用户自有的 TOS）。
* **临时文件** ：使用 `/tmp` 存放临时缓存和命令中间结果；生命周期随 Session。
* **只读挂载** ：不要修改 `/mnt/memory`、`/mnt/skills`、`/mnt/session/uploads`；这些目录承载 Agent 的记忆、能力和用户输入资源。
* **产物路径回报** ：如生成了最终交付文件，在最终响应中告知用户对应的文件路径。

<a id="doc-2553723"></a>

---

## 启动 Session

> 来源：[https://docs.volcengine.com/docs/82379/2553723?lang=zh](https://docs.volcengine.com/docs/82379/2553723?lang=zh)

Session 是托管 Agent 在某个 Environment 中跑某个 Agent 的一次实例。一个 Session 在多次交互中维护对话历史、保留沙箱状态，允许 Agent 跨轮次记住之前做过的事情。

启动一个 Session 分两步：

1. 创建 Session：配置沙箱、绑定 Agent 与 Environment，此时 Agent **不** 开始任何工作。
2. 发送首个事件：通过 `user.message` 事件把任务交给 Agent，Session 进入 `running` 状态开始执行。

<span id=".5YeG5aSH5bel5L2c"></span>

## 准备工作

开始前你需要：

* 已创建的 API Key：配置为环境变量 `ARK_API_KEY`，详情请参见 [API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)。
* 已创建的 Agent：详情请参见 [定义 Agent](https://www.volcengine.com/docs/82379/2553716)。
* 已创建的 Environment：详情请参见 [配置云环境](https://www.volcengine.com/docs/82379/2553721)。

本章节示例的 Base URL 与鉴权方式详情请参见 [Base URL 及鉴权](https://www.volcengine.com/docs/82379/1298459)。

<span id=".5Yib5bu6LXNlc3Npb24="></span>

## 创建 Session

创建 Session 必需两个上游资源 ID：

* Agent ID：由 [定义 Agent](https://www.volcengine.com/docs/82379/2553716) 创建后获得，形如 `agent-20260701120000-abcde`。
* Environment ID：由 [配置云环境](https://www.volcengine.com/docs/82379/2553721) 创建后获得，形如 `env-20260701120000-fghij`。

<span id=".5L2_55SoLWFnZW50LeacgOaWsOeJiOacrO-8iOaOqOiNkOWFpemXqO-8iQ=="></span>

### 使用 Agent 最新版本（推荐入门）

Agent 是带版本的资源，以字符串形式传入 `agent` ID 时，Session 会用该 Agent 的 **最新版本** 启动。

<Tabs>
<Tab zoneid="WA3iWbHCRy" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "agent-20260701120000-abcde",
    "environment_id": "env-20260701120000-fghij"
  }'
```

</Tab>
</Tabs>

响应返回完整的 Session 记录，其中 `id` 字段（形如 `sesn-20260701120100-klmno`）是后续所有操作的入口：

```JSON
{
  "id": "sesn-20260701120100-klmno",
  "type": "session",
  "status": "idle",
  "environment_id": "env-20260701120000-fghij",
  "agent": {
    "id": "agent-20260701120000-abcde",
    "type": "agent",
    "version": 3
  },
  "created_at": "2026-06-29T10:00:00Z",
  "updated_at": "2026-06-29T10:00:00Z",
  "resources": [],
  "vault_ids": null
}
```

响应中 `status` 为 `idle`，表示 Session 已就绪等待首个事件。Session 会经历 `idle` → `running` → `idle`/`terminated` 等状态迁移；进入 `idle` 时沙箱会创建检查点保留完整状态，便于后续恢复。状态机与检查点保留期详情请参见 [管理 Session](https://www.volcengine.com/docs/82379/2553724)。

<span id=".5Zu65a6aLWFnZW50LeeJiOacrO-8iOeBsOW6puWPkeW4g-WcuuaZr--8iQ=="></span>

### 固定 Agent 版本（灰度发布场景）

当你需要把 Session 锁定到 Agent 的某个具体版本（用于回滚、灰度对比、产品定版）时，以对象形式传入 `agent`，显式指定 `version`：

<Tabs>
<Tab zoneid="DF2CAjPlTq" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": {"type": "agent", "id": "agent-20260701120000-abcde", "version": 1},
    "environment_id": "env-20260701120000-fghij"
  }'
```

</Tab>
</Tabs>

固定版本后，即使该 Agent 后续发布了新版本，本 Session 仍按 `version: 1` 的行为运行。这让你可以分阶段灰度推出新版本，而不影响存量 Session 的行为一致性。

<span id=".6YCa6L-HLXZhdWx0cy3ms6jlhaXnu4jnq6_nlKjmiLflh63mja7vvIjlj6_pgInvvIk="></span>

## 通过 Vaults 注入终端用户凭据（可选）

如果 Agent 配置了需要鉴权的 MCP 工具（详情请参见 [使用 Vaults 认证](https://www.volcengine.com/docs/82379/2553726)），创建 Session 时通过 `vault_ids` 引用预存凭据。方舟会自动管理 token 刷新与注入。

最简示例，把 Vaults（凭据保管库）挂到 Session：

<Tabs>
<Tab zoneid="UFib6aKHeo" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "agent-20260701120000-abcde",
    "environment_id": "env-20260701120000-fghij",
    "vault_ids": ["vlt-20260701120000-pqrst"]
  }'
```

</Tab>
</Tabs>

多个 Vaults 匹配规则、无匹配时的运行时行为、轮换与诊断，详情请参见 [使用 Vaults 认证](https://www.volcengine.com/docs/82379/2553726)。

<span id=".5ZCv5YqoLXNlc3Npb27vvJrlj5HpgIHnrKzkuIDkuKrkuovku7Y="></span>

## 启动 Session：发送第一个事件

<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>

<div data-tips="true" data-tips-type="warning"><strong>创建 Session 仅完成沙箱配置，不会启动任何工作。</strong> 必须发送 <code>user.message</code> 事件，Agent 才会开始执行。</div>

这种解耦设计让客户端可以先注入 Vaults 凭据、检查沙箱环境，再发送首个事件启动 Agent。

向 Session 的事件入口 `POST /sessions/{session_id}/events` 提交一条 `user.message` 事件，Session 状态会从 `idle` 切换到 `running`，Agent 进入工作。

<Tabs>
<Tab zoneid="a8gAIJFaJO" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {
        "type": "user.message",
        "content": [
          {"type": "text", "text": "List the files in the working directory."}
        ]
      }
    ]
  }'
```

</Tab>
</Tabs>

<span id=".5ZON5bqU5qih5Z6L5LiO5LiL5LiA5q2l"></span>

### 响应模型与下一步

发送事件后，Session 进入 `running` 状态。要实时看到 Agent 的进度（消息、工具调用、思考过程），请配合 [Session 事件流](https://www.volcengine.com/docs/82379/2553725) 打开 SSE 流接收 `agent.*` 事件；若仅需轮询状态，可周期性 GET Session 详情，详情请参见 [管理 Session](https://www.volcengine.com/docs/82379/2553724)。

<a id="doc-2553724"></a>

---

## 管理 Session

> 来源：[https://docs.volcengine.com/docs/82379/2553724?lang=zh](https://docs.volcengine.com/docs/82379/2553724?lang=zh)

Session 创建后，客户端可以对它做生命周期治理：查状态、列历史、永久删除。本文档介绍 Session 的状态机以及检索、列出、删除三类操作。

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip">创建 Session 与发送首个事件的方法，详情请参见 <a href="https://www.volcengine.com/docs/82379/2553723">启动 Session</a>。</div>

<span id=".5YeG5aSH5bel5L2c"></span>

## 准备工作

开始前你需要：

* 已创建的 API Key：配置为环境变量 `ARK_API_KEY`，详情请参见 [API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)。
* 已创建的 Agent：详情请参见 [定义 Agent](https://www.volcengine.com/docs/82379/2553716)。
* 已创建的 Environment：详情请参见 [配置云环境](https://www.volcengine.com/docs/82379/2553721)。

本章节示例的 Base URL 与鉴权方式详情请参见 [Base URL 及鉴权](https://www.volcengine.com/docs/82379/1298459)。

<span id=".c2Vzc2lvbi3nirbmgIHmnLo="></span>

## Session 状态机

<span aceTableMode="list" aceTableWidth="1,2"></span>
|状态 |说明 |
|---|---|
|`idle` |Agent 在等待输入（用户消息或工具确认）。Session 以 `idle` 状态启动 |
|`running` |Agent 正在主动执行 |
|`rescheduled` |发生了暂时性错误，系统正在自动重试 |
|`terminated` |Session 因不可恢复的错误结束 |

状态迁移规律：

* `idle` → `running`：收到 `user.message` 或 `user.tool_confirmation` 等用户事件。
* `running` → `idle`：Agent 一轮工作结束（`end_turn`）或需要等用户输入（`requires_action`，详情请参见 [Session 事件流](https://www.volcengine.com/docs/82379/2553725)）。
* 任意状态 → `terminated`：不可恢复错误。终止后 Session 不再接收事件，但记录与事件历史保留。
* `running` → `rescheduled` → `running`：框架自动重试，客户端无需介入。

:::note

**本期不支持** 在 Session 运行时修改任何 Session 字段（包括名称、Agent 配置、`tools`、`mcp_servers`、工具权限策略等）。如需调整 Agent 能力，请发布 Agent 新版本并新建 Session。

:::

<span id=".5qOA57SiLXNlc3Npb24="></span>

## 检索 Session

通过 `GET /sessions/{session_id}` 拿到 Session 的最新状态、用量统计、配置快照：

<Tabs>
<Tab zoneid="yeEIpwgL3S" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno \
  -H "Authorization: Bearer $ARK_API_KEY" \
```

</Tab>
</Tabs>

响应主要字段：

* `id`：Session ID。
* `status`：当前状态（见上表）。
* `usage`：累计 token 用量（详情请参见 [Session 事件流 § 跟踪用量](https://www.volcengine.com/docs/82379/2553725)）。
* `agent`：绑定的 Agent 对象，内含 `id`、`version` 等字段。
* `environment_id`：绑定的云环境。

如果 Session 配过结果评估，响应中还会出现 `outcome_evaluations` 字段；该字段的解读详情请参见 [定义结果](https://www.volcengine.com/docs/82379/2553731)，本文不展开。

<span id=".5YiX5Ye6LXNlc3Npb24="></span>

## 列出 Session

`GET /sessions` 支持按 `agent_id` 过滤、按创建时间倒序分页，响应以 `data` 数组形式返回 Session 列表：

<Tabs>
<Tab zoneid="CnKfM37x6R" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl "https://ark.cn-beijing.volces.com/api/v3/sessions?agent_id=agent-20260701120000-abcde&limit=20" \
  -H "Authorization: Bearer $ARK_API_KEY" \
```

</Tab>
</Tabs>

<span id=".5Yig6ZmkLXNlc3Npb24="></span>

## 删除 Session

<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>

<div data-tips="true" data-tips-type="warning"><strong>不可逆。</strong> 删除会永久移除 Session 记录、所有事件、关联沙箱。<code>running</code> 状态不能删除，需先发送 <a href="https://www.volcengine.com/docs/82379/2553725">中断事件</a> 让 Session 回到 <code>idle</code>。</div>

<Tabs>
<Tab zoneid="oPcQjWMXUX" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno \
  -X DELETE \
  -H "Authorization: Bearer $ARK_API_KEY" \
```

</Tab>
</Tabs>

文件、Memory、Vaults、技能、Environment、Agent 是独立资源，不受 Session 删除影响。

<span id=".5qOA5p-l54K55LiO5rKZ566x5L-d55WZ5pyf"></span>

## 检查点与沙箱保留期

Session 进入 `idle` 时，沙箱会被创建检查点，保留完整的：

* 文件系统状态。
* 已安装的软件包。
* Agent 在沙箱中创建的产物文件。

这让客户端能从非活动状态干净恢复，给 Session 发新的 `user.message` 就能继续之前的工作（详情请参见 [Session 事件流 § 恢复空闲 Session](https://www.volcengine.com/docs/82379/2553725)）。

:::note

**保留期差异** ：

* Session 历史：除非显式删除， **永久保留** 。
* 沙箱检查点：最后活动时间起 **30 天** 过期。

  :::

如果工作流需要沙箱状态保留超过 30 天，在检查点过期前周期性发送 `user.message`（哪怕是空操作）重置非活动计时。

<a id="doc-2553725"></a>

---

## Session 事件流

> 来源：[https://docs.volcengine.com/docs/82379/2553725?lang=zh](https://docs.volcengine.com/docs/82379/2553725?lang=zh)

与托管 Agent 的通信基于事件。本文档介绍事件类型、用户消息发送、中断 Session、SSE 流式接收、调用工具、恢复 Session 以及用量统计。

<span id=".5YeG5aSH5bel5L2c"></span>

## 准备工作

开始前你需要：

* 已创建的 API Key：配置为环境变量 `ARK_API_KEY`，详情请参见 [API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)。
* 已创建的 Agent：详情请参见 [定义 Agent](https://www.volcengine.com/docs/82379/2553716)。
* 已创建的 Environment：详情请参见 [配置云环境](https://www.volcengine.com/docs/82379/2553721)。

本章节示例的 Base URL 与鉴权方式详情请参见 [Base URL 及鉴权](https://www.volcengine.com/docs/82379/1298459)。

<span id=".5LqL5Lu25qih5Z6L"></span>

## 事件模型

事件类型字符串遵循 `{domain}.{action}` 命名约定：

* `user.*`：客户端发给 Agent 的用户侧事件，包括用户消息、动态系统提示词、中断、回传工具确认、定义结果。
* `agent.*`：Agent 发给客户端的事件，包括消息、思考进度、工具调用、多 Agent 消息。
* `session.*`：Session 生命周期与状态事件，包括运行、空闲、重排、终止、创建、更新、删除。
* `span.*`：执行跨度事件，包括模型请求开始、结束、结果评估。

> `system.message` 虽以 `system.` 为前缀，但属于客户端上行事件（方向与 `user.*` 一致，必须随 `user.message` 同请求发送），因此放在 User 域。

每个事件携带 `id`、`type`、`processed_at` 字段。`processed_at` 为 `null` 表示事件已排入框架队列，会在前序事件处理完后才被处理。

单次 `POST /events` 请求的 `events` 数组规则：

* 绝大多数场景只能包含 **一个** 事件（如单独发 `user.message`、`user.interrupt`、`user.tool_confirmation`）。
* 唯一例外：发送 `user.message` 时，可在其 **后面** 追加 **一个** `system.message`（运行时动态系统提示词），且 `system.message` 必须是数组最后一个元素。详见 [动态系统提示词](https://www.volcengine.com/docs/82379/2553725#dynamic-system-prompt)。

按事件域分组列出本章节涉及的事件类型（完整事件类型与字段以 API 参考为准）：

<Tabs>
<Tab zoneid="XyCzrR76Ei" title="User 域">
<TabTitle>User 域</TabTitle>

* `user.message`：客户端发送给 Agent 的用户消息，`content` 块数组可混合纯文本、图片、文档，送入 Session 历史并触发 Agent 处理。
* `system.message`：客户端发送给 Agent 的动态系统提示词。必须与 `user.message` 同请求发送（紧跟在 `user.message` 后面、数组最后一个），每轮对话可动态替换或追加，与 Agent 定义时的固定系统提示词拼接后一起送入模型。
* `user.interrupt`：客户端发送的中断指令，停止当前 Agent 执行；未指定 `session_thread_id` 时打断所有活跃线程。
* `user.tool_confirmation`：客户端对受权限策略保护的工具调用回传 `allow` 或 `deny` 决策，通过 `tool_use_id` 关联待确认事件；`deny` 时可选传 `deny_message` 把拒绝原因回传给 Agent。
* `user.define_outcome`：客户端为本次任务定义产出标准与评分量规，触发后续的结果评估循环。详情请参见 [定义结果](https://www.volcengine.com/docs/82379/2553731)。

</Tab>
<Tab zoneid="vnHcH0PSM6" title="Agent 域">
<TabTitle>Agent 域</TabTitle>

* `agent.message`：Agent 推送给客户端的文本回复，用于展示对话内容。
* `agent.thinking`：Agent 处于深度思考阶段时发出的进度信号，**不携带实际思考内容**，仅用于客户端展示「思考中」状态。
* `agent.tool_use`：Agent 发起的内置工具调用事件，内置工具范围：`bash`、`edit`、`read`、`write`、`glob`、`grep`、`web_fetch`、`web_search`。
* `agent.tool_result`：框架发给客户端的内置工具执行结果回执，通过 `tool_use_id` 字段关联到对应的 `agent.tool_use` 事件。
* `agent.mcp_tool_use`：Agent 发起的 MCP 工具调用事件，具体工具集由 Agent 配置的 MCP 服务器决定。
* `agent.mcp_tool_result`：框架发给客户端的 MCP 工具执行结果回执，通过 `tool_use_id` 字段关联到对应的 `agent.mcp_tool_use` 事件。
* `agent.thread_message_sent`：多 Agent 协作场景下，主线程向子线程发送的消息事件。
* `agent.thread_message_received`：多 Agent 协作场景下，子线程从主线程接收到的消息事件。
* `agent.thread_context_compacted`：上下文长度超出阈值时，系统自动触发的上下文压缩或摘要事件。

</Tab>
<Tab zoneid="WPWBm8ALwJ" title="Session 域">
<TabTitle>Session 域</TabTitle>

* `session.status_running`：Session 状态切换到 `running`，表示 Agent 正在主动执行。
* `session.status_idle`：Session 状态切换到 `idle`，表示 Agent 暂停并等待用户输入。事件携带 `stop_reason` 字段说明暂停原因（如 `end_turn`、`requires_action`）。
* `session.status_rescheduled`：Session 从瞬时错误中恢复并重新排队执行，客户端无需介入。
* `session.status_terminated`：Session 因正常完成或不可恢复错误结束。该状态下客户端无法再向 Session 发送请求。
* `session.error`：Session 运行过程中的错误信号事件（包括可恢复的瞬时错误和不可恢复错误）。收到该事件后 Session 可能自动重排继续执行（可恢复错误，比如模型限流），也可能随后转为 `terminated` 状态（不可恢复错误，比如 MCP 连接配置错误）。常见错误类型：`model_overloaded_error`、`model_rate_limited_error`、`model_request_failed_error`、`mcp_connection_failed_error`。
* `session.deleted`：Session 被显式删除，事件流终止，所有后续事件不再下发。
* `session.updated`：Session 的名称在运行时被修改。
* `session.thread_created`：多 Agent 协作场景下，新的子线程被创建。
* `session.thread_status_running`：子线程状态切换到 `running`，开始执行。
* `session.thread_status_idle`：子线程状态切换到 `idle`，暂停等待外部输入。
* `session.thread_status_rescheduled`：子线程从瞬时错误中恢复并重新排队。
* `session.thread_status_terminated`：子线程终止，不再接受新输入。

</Tab>
<Tab zoneid="LRb9wvpIkC" title="Span 域">
<TabTitle>Span 域</TabTitle>

* `span.model_request_start`：模型请求开始，标记本次 LLM 调用的起点。
* `span.model_request_end`：模型请求结束，会返回 `model_usage` 字段，包含本次请求的用量信息：输入 token、输出 token、提示缓存命中 token 等。
* `span.outcome_evaluation_start`：结果评估流程开始，框架为本次 `user.define_outcome` 的产物启动一次评估。详情请参见 [定义结果](https://www.volcengine.com/docs/82379/2553731)。
* `span.outcome_evaluation_ongoing`：结果评估进行中的心跳事件，客户端用于展示「评估中」状态。
* `span.outcome_evaluation_end`：结果评估周期结束，事件携带 `status` 字段，可能值：`satisfied`（满意）、`needs_revision`（需修订，后续会触发新一轮 `_start`）、`max_iterations_reached`（达到迭代上限，框架还会再跑一次 Agent）、`failed`（失败）、`interrupted`（被中断）。

</Tab>
</Tabs>

<span id=".6ZuG5oiQ5LqL5Lu2"></span>

## 集成事件

<span id=".5Y-R6YCB5L-h5oGv"></span>

### 发送信息

客户端通过 `POST /sessions/{id}/events` 向 Session 发送 `user.message` 事件，`content` 是一个块数组，可混合文本（`text`）、图片（`image`）、文档（`document`）三类块。

* 图片 `image` 的 `source.type` 支持三种：`base64`（内联 base64，需带 `media_type`）、`url`（公网可访问 URL）、`file`（已上传文件 ID，字段为 `file_id`）。
* 文档 `document` 的 `source.type` 支持四种：`file`（已上传文件 ID）、`url`（公网可访问 URL）、`base64`（内联 base64，需带 `media_type`）、`text`（直接内联纯文本，`media_type: text/plain` + `data` 字段）；可选 `title` 与 `context` 字段为文档附加标题与背景说明。
* 同一请求的 `content` 数组可混合多个图片/文档块（多附件场景）。
* 如需为当前轮次动态追加系统提示词，可在 `events` 数组里 `user.message` 后面紧跟一个 `system.message`（详见 [动态系统提示词](https://www.volcengine.com/docs/82379/2553725#dynamic-system-prompt)）。

<span id=".5bi46KeB5YaF5a6557uE5ZCI56S65L6L"></span>

#### 常见内容组合示例

<Tabs>
<Tab zoneid="vCpttBfcjr" title="纯文本">
<TabTitle>纯文本</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [{"type": "text", "text": "帮我分析这份销售数据，找出 Q2 异常"}]
    }]
  }'
```

</Tab>
<Tab zoneid="z8QwV6boLE" title="文本 + 图片（URL）">
<TabTitle>文本 + 图片（URL）</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [
        {"type": "text", "text": "看下这张趋势图哪里不对"},
        {"type": "image", "source": {"type": "url", "url": "https://cdn.example.com/q2-trend.png"}}
      ]
    }]
  }'
```

</Tab>
<Tab zoneid="G3glyaT1ma" title="文本 + 图片（base64）">
<TabTitle>文本 + 图片（base64）</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [
        {"type": "text", "text": "看下这张趋势图哪里不对"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgoAAAANSUhEUgAA..."}}
      ]
    }]
  }'
```

</Tab>
<Tab zoneid="ceeO5XOSXv" title="文本 + 图片（file_id）">
<TabTitle>文本 + 图片（file_id）</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [
        {"type": "text", "text": "看下这张趋势图哪里不对"},
        {"type": "image", "source": {"type": "file", "file_id": "file_img_abc123"}}
      ]
    }]
  }'
```

</Tab>
<Tab zoneid="E9KCf0ECIK" title="文本 + 文档（file_id）">
<TabTitle>文本 + 文档（file_id）</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [
        {"type": "text", "text": "总结这份审计报告的关键风险"},
        {"type": "document", "title": "Q2 审计报告.pdf", "context": "Big4 出具的内部审计稿件", "source": {"type": "file", "file_id": "file_pdf_xxx"}}
      ]
    }]
  }'
```

</Tab>
<Tab zoneid="oXS7bmaTNd" title="文本 + 文档（内联纯文本）">
<TabTitle>文本 + 文档（内联纯文本）</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [
        {"type": "text", "text": "帮我重写下面这段说明，更技术化一点"},
        {"type": "document", "title": "原稿", "source": {"type": "text", "media_type": "text/plain", "data": "本系统提供数据分析能力，包括但不限于报表生成、异常检测..."}}
      ]
    }]
  }'
```

</Tab>
<Tab zoneid="Kojjri4iFS" title="文本 + 文档（base64 PDF）">
<TabTitle>文本 + 文档（base64 PDF）</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [
        {"type": "text", "text": "提取这份合同里的关键条款"},
        {"type": "document", "title": "framework-agreement.pdf", "source": {"type": "base64", "media_type": "application/pdf", "data": "JVBERi0xLjQKJaqr..."}}
      ]
    }]
  }'
```

</Tab>
<Tab zoneid="p2gQpHids0" title="文本 + 文档（URL）">
<TabTitle>文本 + 文档（URL）</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [
        {"type": "text", "text": "把这份文档总结成 5 点"},
        {"type": "document", "title": "公司年报", "source": {"type": "url", "url": "https://investor.example.com/annual-2025.pdf"}}
      ]
    }]
  }'
```

</Tab>
<Tab zoneid="HZOlzN1gEX" title="文本 + 多附件混合">
<TabTitle>文本 + 多附件混合</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [
        {"type": "text", "text": "结合这份文字稿和两张图给我一份完整分析"},
        {"type": "document", "source": {"type": "file", "file_id": "file_doc_01"}},
        {"type": "image", "source": {"type": "file", "file_id": "file_img_01"}},
        {"type": "image", "source": {"type": "file", "file_id": "file_img_02"}}
      ]
    }]
  }'
```

</Tab>
</Tabs>

请求体的 `events` 字段是事件数组，服务端按入队顺序串行处理。

<span id="dynamic-system-prompt"></span>

#### 动态系统提示词

除了在 [定义 Agent](https://www.volcengine.com/docs/82379/2553716) 时配置的固定系统提示词，客户端还可以在发送 `user.message` 的同一请求里追加一个 `system.message`，为当前轮次动态注入额外指令；固定系统提示词、运行时 `system.message` 与用户消息拼接后一起送入模型。

<span aceTableMode="list" aceTableWidth="1,2,2"></span>
|对比项 |Agent 定义的系统提示词 |运行时 `system.message` 事件 |
|---|---|---|
|位置 |创建 Agent 时设置 |发 Events 时传入 |
|生效 |创建 Session 时拼入，整个 Session 生命周期内固定 |每轮对话可动态替换或追加 |
|拼接顺序（首轮） |`[Agent 系统提示词] [system.message] [user.message]` |同左 |
|拼接顺序（次轮） |`[Agent 系统提示词] [system.message] [system.message] [user.message]`（每轮的 system.message 累积） |同左 |

**约束：**

* `system.message` 不能单独发送，必须与 `user.message` 在同一个请求中。
* `system.message` 必须紧跟在 `user.message` 后面，且是 `events` 数组的最后一个元素。
* 违反位置约束会返回 HTTP 400。

<Tabs>
<Tab zoneid="YRMpLhbv4t" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {"type": "user.message", "content": [{"type": "text", "text": "我的订单 #1234 到哪了？"}]},
      {"type": "system.message", "content": [{"type": "text", "text": "你是 ACME 的客服助手，必须使用可用工具查询订单；绝对不能泄露内部客户 ID。"}]}
    ]
  }'
```

</Tab>
</Tabs>

请求成功返回 HTTP 200，响应 `data` 数组按入参顺序包含两个事件对象（均带服务端分配的 `id`）。位置错误时返回 HTTP 400，例如把 `system.message` 放在 `user.message` 之前：

```JSON
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Invalid \`system.message\` event at events[0]: \`system.message\` must immediately follow a \`user.message\` event in the same request"
  },
  "request_id": "req_01xxxYFT3zKjnUJ"
}
```

<span id=".5Lit5patLXNlc3Npb24="></span>

### 中断 Session

客户端发送 `user.interrupt` 事件可中断 Agent 当前执行，等 Session 回到 `idle` 状态后再发送 `user.message` 把 Agent 重定向到新任务（两次独立请求）：

<Tabs>
<Tab zoneid="aDWRUXZDTW" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
# 第一步：发送中断事件
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"events": [{"type": "user.interrupt"}]}'

# 第二步：等 Session 回到 idle 后（收到 session.status_idle 事件），发送新消息
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [{"type": "text", "text": "Instead, focus on fixing the bug in line 42."}]
    }]
  }'
```

</Tab>
</Tabs>

<span id=".5rWB5byP5o6l5pS25LqL5Lu277yIc3Nl77yJ"></span>

### 流式接收事件（SSE）

客户端通过 `GET /sessions/{session_id}/events/stream` 打开 SSE 流，在 Agent 工作过程中实时接收最新事件。

<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>

<div data-tips="true" data-tips-type="warning"><strong>必须先打开 SSE 流，再发送用户事件。</strong> SSE 流只会推送其打开 <strong>之后</strong> 产生的事件，顺序颠倒会导致事件丢失。</div>

<Tabs>
<Tab zoneid="IxvOoEIXlw" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
# Open the stream first
curl -N https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events/stream \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Accept: text/event-stream" &
STREAM_PID=$!

# Then send the user message
curl https://ark.cn-beijing.volces.com/api/v3/sessions/sesn-20260701120100-klmno/events \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{"type": "user.message", "content": [{"type": "text", "text": "Summarize the repo README"}]}]
  }'

wait $STREAM_PID
```

</Tab>
</Tabs>

<span id=".6YeN6L-eLXNlc3Npb24="></span>

### 重连 Session

要重新连接现有 Session 而不漏事件，三步：

1. 打开新的事件流。
2. 拉一次完整事件历史，把所有 `event.id` 放进「已见集合」。
3. 跟实时流，跳过已见 ID。

<span id=".5YW25LuW5Zy65pmv"></span>

## 其他场景

<span id=".56Gu6K6k5bel5YW36LCD55So"></span>

### 确认工具调用

当 Agent 配置了 [工具权限策略](https://www.volcengine.com/docs/82379/2553720) 要求工具执行前确认时，工作流如下：

1. Session 发出 `agent.tool_use` 或 `agent.mcp_tool_use` 事件。
2. Session 进入 `idle`，发出 `session.status_idle`，携带 `stop_reason.type = "requires_action"`，阻塞事件 ID 列在 `stop_reason.event_ids` 数组中。
3. 对每个阻塞事件，你发 `user.tool_confirmation` 事件，把事件 ID 传入 `tool_use_id`，把决策结果设为 `"allow"` 或 `"deny"`（可选传 `deny_message` 解释拒绝原因）。
4. 所有阻塞事件解决后，Session 切回 `running`。

<span id=".5ouS57ud5bel5YW36LCD55So"></span>

### 拒绝工具调用

客户端把 `user.tool_confirmation` 事件的 `result` 字段设为 `"deny"`，可选附 `deny_message` 字段把拒绝原因回传给 Agent。Agent 收到拒绝原因后会据此调整策略，例如改用其他工具、降级方案、或向用户复述拒绝原因。

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip">在权限审批、合规拦截场景中，显式 <code>deny</code> 配合清晰的 <code>deny_message</code> 比无声允许更安全，Agent 能感知到边界，而不会误以为操作已经成功。</div>

<span id=".5oGi5aSN56m66ZeyLXNlc3Npb24="></span>

### 恢复空闲 Session

Session 在交互之间持续存在。当 Session 进入 `idle` 时，沙箱会被创建检查点，保留完整状态（文件系统、已装软件包、产物文件），检查点保留期 30 天（详情请参见 [管理 Session § 检查点与沙箱保留期](https://www.volcengine.com/docs/82379/2553724)）。

恢复 Session 不需要特殊接口，按 [发送用户消息](https://www.volcengine.com/docs/82379/2553725#.5Y-R6YCB55So5oi35raI5oGv) 流程发 `user.message` 即可，Session 状态会从 `idle` 切回 `running` 并继续后续工作。

<span id=".6Lef6Liq55So6YeP"></span>

### 跟踪用量

客户端通过 `span.model_request_end` 事件获取本次模型请求的 token 用量。事件携带 `model_usage` 字段，记录本次请求的用量明细；该字段是 token 计费的数据来源：

```JSON
{
  "id": "sevt_mre_01",
  "type": "span.model_request_end",
  "processed_at": "2026-05-31T16:00:02.100Z",
  "model_request_start_id": "sevt_mrs_01",
  "is_error": false,
  "model_usage": {
    "input_tokens": 1820,
    "output_tokens": 42,
    "cache_creation_input_tokens": 1500,
    "cache_read_input_tokens": 0,
    "speed": "standard"
  }
}
```

字段含义：

* `input_tokens`：未缓存输入 token。
* `output_tokens`：全部输出 token。
* `cache_creation_input_tokens`、`cache_read_input_tokens`：提示缓存活动（5 分钟 TTL，连续轮次可复用缓存读取以降低单 token 成本）。
* `speed`：本次请求速度档位。

要做 Session 级累计，客户端需要聚合 `span.model_request_end` 事件的 `model_usage`。控制台「追踪视图」会自动展示聚合后的用量。

<span id=".5o6n5Yi25Y-w5Y-v6KeC5rWL5oCn"></span>

## 控制台可观测性

控制台 [Managed Agents](https://console.volcengine.com/ark/region:ark+cn-beijing/managedAgents) 提供 Session 的可视化时间线视图：

* Session 列表：全部 Session 及其状态、创建时间、模型。
* 追踪视图：Session 内事件（内容、时间戳、token 用量） 按时间排序展示， **仅对开发者与管理员可见** 。
* 工具执行：每次工具调用及其结果的详细信息。

<span id=".6LCD6K-V5oqA5ben"></span>

## 调试技巧

* 关注 `session.error`：不可恢复的错误通过该事件传递。
* 看工具结果：失败的工具调用通常解释了 Agent 异常行为的原因。
* 跟踪 token 用量：监控消耗以优化提示并降低成本。

<a id="doc-2553726"></a>

---

## 使用 Vaults 认证

> 来源：[https://docs.volcengine.com/docs/82379/2553726?lang=zh](https://docs.volcengine.com/docs/82379/2553726?lang=zh)

Vaults（凭据保管库）与凭据（Credential） 是托管 Agent 的认证原语：让你一次性注册每个终端用户的第三方凭据，创建 Session 时按 Vault ID 引用，免去自建密钥存储、无需每次调用都传 token、清晰区分 Agent 代表哪个终端用户操作。

Vaults 在 **Session 级** 引用，你可以在 Agent 资源粒度上管理产品，在 Session 资源粒度上管理用户。

<span id=".5YeG5aSH5bel5L2c"></span>

## 准备工作

开始前你需要：

* 已创建的 API Key：配置为环境变量 `ARK_API_KEY`，详情请参见 [API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)。
* 已创建的 Agent：详情请参见 [定义 Agent](https://www.volcengine.com/docs/82379/2553716)。
* 已创建的 Environment：详情请参见 [配置云环境](https://www.volcengine.com/docs/82379/2553721)。

本章节示例的 Base URL 与鉴权方式详情请参见 [Base URL 及鉴权](https://www.volcengine.com/docs/82379/1298459)。

<span id=".5Yib5bu6LXZhdWx0cw=="></span>

## 创建 Vaults

<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>

<div data-tips="true" data-tips-type="warning"><strong>作用域。</strong> Vaults 与凭据按工作空间隔离，同工作空间的 API Key 都能引用。要撤销访问，删除对应 Vaults 或凭据。</div>

Vaults 是绑定到某个终端用户的凭据集合。给它一个 `display_name`，可选用 `metadata` 标记以便映射回你自己的用户记录：

<Tabs>
<Tab zoneid="rGxWGnONIU" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/vaults \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Alice",
    "metadata": {"external_user_id": "usr_abc123"}
  }'
```

</Tab>
</Tabs>

响应是完整的 Vaults 记录：

```JSON
{
  "type": "vault",
  "id": "vlt-20260701120000-pqrst",
  "display_name": "Alice",
  "metadata": {"external_user_id": "usr_abc123"},
  "created_at": "2026-06-29T10:00:00Z",
  "updated_at": "2026-06-29T10:00:00Z"
}
```

<span id=".5re75Yqg5Yet5o2u4oCU4oCU5LiJ56eN57G75Z6L"></span>

## 添加凭据——三种类型

<span aceTableMode="list" aceTableWidth="1,2,2"></span>
|类型 |适用场景 |注入方式 |
|---|---|---|
|`mcp_oauth` |MCP 服务器用 OAuth 2.0 |平台代刷 token，Session 连接 MCP URL 时自动注入 |
|`static_bearer` |MCP 用固定 Bearer token（API Key、个人访问令牌） |无刷新流程，直接注入 |
|`environment_variable` |通过环境变量鉴权的命令行、SDK、直接 API 调用 |沙箱内是不透明占位符， **出口处** 替换为真实值，Agent 永远看不到密钥 |

你提供的实际密钥（`token`、`access_token`、`refresh_token`、`client_secret`、`secret_value`） 被视为敏感的 **只写** 字段， **永远不会** 在 API 响应中返回。

<span id=".bWNwLW9hdXRoLeWHreaNrg=="></span>

### MCP OAuth 凭据

当 MCP 服务器使用 OAuth 2.0 时，用 `mcp_oauth`。提供 `refresh` 块后，平台会在 access token 过期时代你刷新。

`refresh.token_endpoint_auth.type` 三选一：

* `none`：公共客户端。
* `client_secret_basic`：使用 `client_secret` 的 HTTP Basic 鉴权。
* `client_secret_post`：把 `client_secret` 放在 POST 请求体里。

<Tabs>
<Tab zoneid="rLVmHDV9TV" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/vaults/vlt-20260701120000-pqrst/credentials \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Alice Slack",
    "auth": {
      "type": "mcp_oauth",
      "mcp_server_url": "https://mcp.slack.com/mcp",
      "access_token": "xoxp-...",
      "expires_at": "2099-12-31T23:59:59Z",
      "refresh": {
        "token_endpoint": "https://slack.com/api/oauth.v2.access",
        "client_id": "1234567890.0987654321",
        "scope": "channels:read chat:write",
        "refresh_token": "xoxe-1-...",
        "token_endpoint_auth": {
          "type": "client_secret_post",
          "client_secret": "abc123..."
        }
      }
    }
  }'
```

</Tab>
</Tabs>

<span id=".bWNwLemdmeaAgS1iZWFyZXIt5Yet5o2u"></span>

### MCP 静态 Bearer 凭据

当 MCP 服务器接受固定 Bearer token（API Key、个人访问令牌） 时，用 `static_bearer`。无需刷新流程：

<Tabs>
<Tab zoneid="k1ucYkxYjO" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/vaults/vlt-20260701120000-pqrst/credentials \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Linear API key",
    "auth": {
      "type": "static_bearer",
      "mcp_server_url": "https://mcp.linear.app/mcp",
      "token": "lin_api_your_linear_key"
    }
  }'
```

</Tab>
</Tabs>

<span id=".546v5aKD5Y-Y6YeP5Yet5o2u"></span>

### 环境变量凭据

用 `environment_variable` 通过环境变量对外部服务鉴权，适用于命令行、SDK 或直接 API 调用。

`networking.allowed_hosts` 控制密钥可以被替换到哪些出站主机：

* `"type": "limited"` + 显式主机列表（ **推荐** ）。
* `"type": "unrestricted"`（仅当调用方访问的域名无法提前枚举时使用）。

<Tabs>
<Tab zoneid="mA99Z4c40S" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/vaults/vlt-20260701120000-pqrst/credentials \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Notion API key for sandbox",
    "auth": {
      "type": "environment_variable",
      "secret_name": "NOTION_API_KEY",
      "secret_value": "sk-your-secret-here",
      "networking": {
        "type": "limited",
        "allowed_hosts": ["api.notion.com"]
      }
    }
  }'
```

</Tab>
</Tabs>

<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>

* <div data-tips="true" data-tips-type="warning"><strong>替换发生在沙箱出口处，不在沙箱内。</strong> 沙箱里的进程看到的是不透明占位符，而不是真实值。两点影响：</div>

  * <div data-tips="true" data-tips-type="warning">启动时校验凭据格式的客户端可能拒绝占位符。</div>
  * <div data-tips="true" data-tips-type="warning">用密钥做请求签名的客户端（例如 AWS SigV4） 会生成无效签名。</div>

  <div data-tips="true" data-tips-type="warning">环境变量凭据 <strong>只适合「把密钥值原样塞进出站请求头」的客户端</strong> 。   </div>
* <div data-tips="true" data-tips-type="warning"><code>networking.allowed_hosts</code> 控制密钥能替换到哪些出站主机， <strong>强烈建议</strong> 用 <code>type: limited</code> + 显式主机列表，避免密钥被发到未授权主机。此外，该域名还必须在 <a href="https://www.volcengine.com/docs/82379/2553721">Environment 网络白名单</a> 中允许， <strong>两层都包含</strong> 才能成功。</div>

:::note

**替换仅出站方向。**  如果客户端使用存储的密钥来交换 session token（例如 OAuth 客户端凭据授权），返回的 token 会以未脱敏形式到达沙箱。对于基于交换的流程，请自行执行交换，把交换后的 token 存进 Vaults 。

:::

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip"><strong>最小权限原则。</strong> 把 API Key 的权限范围限定为 Agent 所需的最小集合。Agent 可以执行该 Key 允许的任何操作，过权 Key 会在 Agent 异常时扩大事故影响范围。</div>

<span id=".5Yet5o2u57qm5p2f"></span>

### 凭据约束

* **每 Vaults 内 key 必须唯一。**  `mcp_server_url`（MCP 凭据） 和 `secret_name`（环境变量凭据） 在 Vaults 的活跃凭据中必须唯一。创建重复返回 409。
* **key 不可变。**  要改 `mcp_server_url`、`secret_name`，删除旧凭据再创建新的。
* **每 Vaults 最多 20 个凭据** 。

MCP 类型凭据（`mcp_oauth`、`static_bearer`）在创建时会立即连接目标 MCP 服务器探测握手，无效凭据会直接返回 4xx 错误、创建失败；`environment_variable` 类型凭据不在创建时校验，无效密钥会在 Session 运行期间访问对应主机时以鉴权错误或下游错误的形式出现，该错误会被发出，但不会阻止 Session 继续。

<span id=".5Zyo5Yib5bu6LXNlc3Npb24t5pe25byV55SoLXZhdWx0cw=="></span>

## 在创建 Session 时引用 Vaults

创建 Session 时传 `vault_ids` 数组，把一个或多个 Vaults 挂到 Session：

<Tabs>
<Tab zoneid="l4N3r2k3Yu" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/sessions \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "agent-20260701120000-abcde",
    "environment_id": "env-20260701120000-fghij",
    "vault_ids": ["vlt-20260701120000-pqrst"],
    "title": "Alice Slack digest"
  }'
```

</Tab>
</Tabs>

**运行时行为** ：

* 当 Agent 连接到某 MCP URL 时， **没有任何凭据匹配** `mcp_server_url` → 尝试匿名连接；若服务器要求鉴权则报错。
* **多个 Vaults 都包含匹配凭据** → **第一个匹配的 Vaults 优先** 。
* 在 [多 Agent](https://www.volcengine.com/docs/82379/2553730) 中，Vaults 凭据 **按线程** 生效；若某 Agent 自身定义里声明了匹配的 MCP 服务器，该 Agent 用这些凭据鉴权。

<span id=".6L2u5o2i5Yet5o2u"></span>

## 轮换凭据

密钥值和 `display_name` 可以更新。结构性字段（`mcp_server_url`、`secret_name`、`token_endpoint`、`client_id`） 在创建后即被锁定。要修改结构性字段，删除旧凭据再创建新的：

<Tabs>
<Tab zoneid="qHnQFrWjkT" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/vaults/vlt-20260701120000-pqrst/credentials/vcrd-20260701120500-uvwxy \
  -X POST \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "auth": {
      "type": "mcp_oauth",
      "access_token": "xoxp-new-...",
      "expires_at": "2099-12-31T23:59:59Z",
      "refresh": {"refresh_token": "xoxe-1-new-..."}
    }
  }'
```

</Tab>
</Tabs>

<span id=".5Yet5o2u55Sf5ZG95ZGo5pyf"></span>

## 凭据生命周期

凭据会在 Session 期间与 Vaults 生命周期内 **周期性重新解析** 。这确保凭据的轮换、删除、刷新失败都能传播到正在运行的 Session，无需重启。

对于 `mcp_oauth` 凭据，重新解析还会在 access token 过期时刷新它。如果刷新失败，系统会记录失败事件。未来版本将支持通过 Webhook 订阅 `vault.* / vault_credential.*` 事件，届时可在本节订阅这些生命周期事件。

<span aceTableMode="list" aceTableWidth="1,2"></span>
|事件 |触发 |
|---|---|
|`vault.deleted` |Vaults 被删除（级联触发底层凭据 `vault_credential.deleted`） |
|`vault_credential.deleted` |凭据被删除（直接删除或因 Vaults 删除） |
|`vault_credential.refresh_failed` |`mcp_oauth` 凭据刷新失败（refresh token 无效，或 OAuth 服务器返回不可恢复错误） |

<span id=".6K-K5patLW9hdXRoLeWIt-aWsOWksei0pQ=="></span>

### 诊断 OAuth 刷新失败

调用 `POST /vaults/{vault_id}/credentials/{credential_id}/mcp_oauth_validate` 诊断刷新失败的原因。响应 `status` 字段告诉你下一步该做什么：

<span aceTableMode="list" aceTableWidth="1,2,2"></span>
|`status` |含义 |下一步 |
|---|---|---|
|`valid` |token 有效 |无需操作 |
|`invalid` |授权已失效，或 OAuth 服务器以 4xx 拒绝刷新 |提示终端用户重新授权 |
|`unknown` |临时性错误（5xx、429 或网络故障） |等待后重试 |

<Tabs>
<Tab zoneid="HNFYGIaN4N" title="Curl">
<TabTitle>Curl</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/vaults/vlt-20260701120000-pqrst/credentials/vcrd-20260701120500-uvwxy/mcp_oauth_validate \
  -X POST \
  -H "Authorization: Bearer $ARK_API_KEY" \
```

</Tab>
</Tabs>

响应是一个 `vault_credential_validation` 对象，`mcp_probe` 包含失败的 MCP 握手步骤，`refresh` 包含刷新尝试的结果：

```JSON
{
  "type": "vault_credential_validation",
  "credential_id": "vcrd-20260701120500-uvwxy",
  "vault_id": "vlt-20260701120000-pqrst",
  "validated_at": "2026-06-29T17:12:00Z",
  "has_refresh_token": false,
  "status": "invalid",
  "mcp_probe": {
    "method": "initialize",
    "http_response": {
      "status_code": 401,
      "content_type": "application/json",
      "body": "{\"error\":\"invalid_token\"}",
      "body_truncated": false
    }
  },
  "refresh": {
    "status": "no_refresh_token",
    "http_response": null
  }
}
```

<span id=".5YW25LuW5pON5L2c"></span>

## 其他操作

* 列出 Vaults 、凭据：`GET /vaults` 或 `GET /vaults/{id}/credentials`；分页返回，按最新优先排序。
* 删除 Vaults 、凭据：硬删除，所有相关记录与密钥一并清除，不可恢复。

<a id="doc-2553727"></a>

---

## 上传与挂载文件

> 来源：[https://docs.volcengine.com/docs/82379/2553727?lang=zh](https://docs.volcengine.com/docs/82379/2553727?lang=zh)

本文介绍如何在方舟 Managed Agents 中上传文件，将文件挂载到云沙箱，以及在 Session 运行时增、删文件资源。

Managed Agents 支持挂载通过 [Files API](https://www.volcengine.com/docs/82379/1885708) 或 [TOS 对象存储](https://www.volcengine.com/docs/6349/74820?lang=zh) 上传的文件，再将文件作为 Session 资源挂载到沙箱环境目录中。Agent 可读取这些文件并基于文件内容执行任务。

<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>

<div data-tips="true" data-tips-type="warning">挂载 TOS 文件前，需要确保 TOS 和 Managed Agents 在同一火山账号中。</div>

<span id=".5LiK5Lyg5paH5Lu2"></span>

## 上传文件

您可使用 Files API 或 TOS 上传需要被 Agent 读取的文件。

* 使用 Files API：

先将本地文件上传到 Files API。上传成功后，平台会返回 `file_id`，后续创建 Session 或向运行中的 Session 追加文件资源时都需要使用该 ID。

> 需要设置 `purpose=agent`, 指定该文件为 Agent 使用

```Bash
file=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/files" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -F 'purpose=agent' \
    -F 'file=@path/of/your/file'
)

FILE_ID=$(jq -er '.id' <<<"$file")

echo "File ID: $FILE_ID"
```

* 使用 TOS 上传：

以下示例使用 TOS Python SDK 上传本地文件，更多使用方式，请参考 [TOS 官方文档](https://www.volcengine.com/docs/6349/74820?lang=zh)。

```python
import os
import tos

ak = os.getenv("TOS_ACCESS_KEY")
sk = os.getenv("TOS_SECRET_KEY")

endpoint = "tos-cn-beijing.volces.com"
region = "cn-beijing"

bucket_name = "<BUCKET_NAME>"
object_key = "<OBJECT_KEY>"   # The path of the uploaded file. For example: agent-files/skill.md
file_name = "/path/of/your/file"  # Local file path

try:
    client = tos.TosClientV2(ak, sk, endpoint, region)

    result = client.put_object_from_file(
        bucket_name,
        object_key,
        file_name,
    )

    print("upload success")
    print("request_id:", result.request_id)
    print("etag:", result.etag)

except tos.exceptions.TosClientError as e:
    print("client error:", e.message)
    print("cause:", e.cause)

except tos.exceptions.TosServerError as e:
    print("server error code:", e.code)
    print("request_id:", e.request_id)
    print("message:", e.message)
    print("status_code:", e.status_code)
    print("request_url:", e.request_url)

except Exception as e:
    print("unknown error:", str(e))
```

<span id=".5Zyo5Yib5bu6LXNlc3Npb24t5pe25oyC6L295paH5Lu2"></span>

## 在创建 Session 时挂载文件

创建 Session 时，在 `resources` 数组中声明需要挂载的文件。

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip">您也可以在 <a href="https://ark.volcengine.com/region:cn-beijing/managed-agents/sessions">控制台</a> 创建 Session。</div>

* 通过 Files ID 挂载：

每个文件资源至少需要包含 `type` 和 `file_id`。

`mount_path` 可选。建议设置 `mount_path`，让 Agent 可以从稳定、可读的路径访问文件。如果不显式指定路径，请确保上传文件名足够清晰，便于 Agent 识别文件用途。

```bash
session=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/sessions" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "agent": "$AGENT_ID",
  "environment_id": "$ENVIRONMENT_ID",
  "resources": [
    {
      "type": "file",
      "file_id": "$FILE_ID",
      "mount_path": "target/mounting/path/of/the/file"
    }
  ]
}
EOF
)

SESSION_ID=$(jq -er '.id' <<<"$session")

echo "Session ID: $SESSION_ID"
```

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip"><code>mount_path</code> 为云端沙箱中的目标挂载路径，通过 <code>file_id</code> 传入的文件将按照您指定的路径，挂载到 <code>/mnt/session/uploads/</code> 目录中。</div>

<div data-tips="true" data-tips-type="tip">挂载时如指定 <code>my-skills/skill-1.md</code> 路径，挂载文件路径为 <code>/mnt/session/uploads/my-skills/skill-1.md</code>。</div>

挂载后，平台会为该 Session 内的文件实例生成新的 `file_id`。这些 Session 内副本不计入用户的文件存储额度。

* 从 TOS 挂载：

```bash
session=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/sessions" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "agent": "$AGENT_ID",
  "environment_id": "$ENVIRONMENT_ID",
  "resources": [
    {
      "type": "tos",
      "tos_bucket": "<BUCKET_NAME>",
      "tos_key": "path/of/the/tos/directory/"
    }
  ]
}
EOF
)

SESSION_ID=$(jq -er '.id' <<<"$session")

echo "Session ID: $SESSION_ID"
```

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

* <div data-tips="true" data-tips-type="tip"><code>tos_key</code> 需为 TOS 桶中的一个目录，且必须以 <code>/</code> 结尾。例如 <code>project-resources/</code>。</div>
* <div data-tips="true" data-tips-type="tip">文件将被挂载至云端沙箱的 <code>/mnt/session/storage/</code> 目录中。</div>

<span id=".5oyC6L295aSa5Liq5paH5Lu2"></span>

## 挂载多个文件

如果一次任务需要多个输入文件，可以在 `resources` 中添加多个条目。单个 Session 最多支持挂载 100 个文件。

以 Files ID 为例：

```json
"resources": [
  { "type": "file", "file_id": "<FILE_ID_1>" },
  { "type": "file", "file_id": "<FILE_ID_2>" },
  { "type": "file", "file_id": "<FILE_ID_3>" }
]
```

<span id=".5ZyoLXNlc3Npb24t6L-Q6KGM5pe2566h55CG5paH5Lu2"></span>

## 在 Session 运行时管理文件

Session 创建后，也可以通过 Session Resources API 动态添加或移除文件。添加资源或查询资源列表时，接口会返回资源 ID；删除资源时需要使用该资源 ID。

<span id=".5re75Yqg5paH5Lu26LWE5rqQ"></span>

### 添加文件资源

```bash
resource=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/sessions/$SESSION_ID/resources" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "type": "file",
  "file_id": "$FILE_ID"
}
EOF
)

RESOURCE_ID=$(jq -er '.id' <<<"$resource")

echo "Resource ID: $RESOURCE_ID"
```

<span id=".5p-l6K-i5ZKM5Yig6Zmk5paH5Lu26LWE5rqQ"></span>

### 查询和删除文件资源

```Bash
# 查询 Session 资源
curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/sessions/$SESSION_ID/resources" \
  -H "Authorization: Bearer $ARK_API_KEY"

# 删除指定资源
curl -sS --fail-with-body -X DELETE \
  "https://ark.cn-beijing.volces.com/api/v3/sessions/$SESSION_ID/resources/$RESOURCE_ID" \
  -H "Authorization: Bearer $ARK_API_KEY"
```

<span id=".5p-l6K-iLXNlc3Npb24t5Lit55Sf5oiQ55qE5paH5Lu2"></span>

## 查询 Session 中生成的文件

Agent 在 Session 中生成的文件可以通过 Files API 查询。可按 `scope_id` 指定 Session ID，列出与该 Session 关联的文件。

```Bash
# 查询 Session 关联文件
curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/files?scope_id=$SESSION_ID" \
  -H "Authorization: Bearer $ARK_API_KEY"
```

<span id=".5pSv5oyB55qE5paH5Lu257G75Z6L"></span>

## 支持的文件类型

Agent 可以处理多种文件类型。常见类型包括：

* 源代码文件，例如 `.py`、`.js`、`.ts`、`.go`、`.rs` 等。
* 数据文件，例如 `.csv`、`.json`、`.xml`、`.yaml`。
* 文本文档，例如 `.txt`、`.md`。
* 归档文件，例如 `.zip`、`.tar.gz`；Agent 可以在沙箱中使用 bash 解压后处理。
* 二进制文件；是否能正确处理取决于沙箱内是否具备相应工具。

<span id=".5L2_55So5bu66K6u"></span>

## 使用建议

* 挂载到沙箱中的文件是只读副本。Agent 可以读取这些文件，但不能直接修改原始上传文件。
* 如果任务需要产出修改后的版本，应将结果写入沙箱中的新路径。
* 需要长期保存或回传的输出文件，应在任务说明中要求 Agent 写入约定目录。
* 如果运行中的 Session 不再需要某个大文件，及时移除对应资源，减少后续工具调用的上下文干扰。

<a id="doc-2553728"></a>

---

## 持久化记忆

> 来源：[https://docs.volcengine.com/docs/82379/2553728?lang=zh](https://docs.volcengine.com/docs/82379/2553728?lang=zh)

本文介绍如何在方舟 Managed Agents 中使用记忆存储（Memory Store），为 Agent 提供可跨 Session 保留的长期记忆。

默认情况下，每个 Session 都从新的上下文开始。Session 结束后，Agent 在本次运行中积累的偏好、约定、排障经验或业务背景不会自动带到下一次任务中。Memory Store 用于保存这些可复用信息，并在后续 Session 中重新挂载给 Agent 使用。

<span id=".5Z-65pys5qaC5b-1"></span>

## 基本概念

将 Memory Store 挂载到 Session 后，它会以目录形式出现在沙箱内，Agent 可以访问记忆内容。

> Agent 仅可读取记忆内容，不具备对记忆的写权限。

每条 Memory 都有独立路径，您可以通过 API 或控制台直接读取、创建、更新和删除。

使用 Memory Store 时，需要在创建 Agent 时启用 Agent Toolset。Agent 通过标准文件工具读取挂载目录，系统会自动为 Agent 提供说明，告知该记忆目录的位置和用途。

<span id=".5Yib5bu6LW1lbW9yeS1zdG9yZQ=="></span>

## 创建 Memory Store

创建 Memory Store 时需要提供 `name` 和 `description`。其中 `description` 会展示给 Agent，用于说明这个 Store 中保存的内容和使用场景。

```bash
store=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/memory_stores" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "<MEMORY_STORE_NAME>",
      "description": "<MEMORY_STORE_DESCRIPTION>"
    }'
)

STORE_ID=$(jq -er '.id' <<<"$store")

echo "Memory Store ID: $STORE_ID"
```

返回的 Memory Store ID 通常形如 `memstore_...`。创建 Session 并挂载记忆时，需要传入该 ID。

<span id=".6aKE572uLW1lbW9yeS3lhoXlrrk="></span>

## 预置 Memory 内容

在 Agent 开始运行前，可以先向 Store 中写入参考资料，例如项目规范、用户偏好、输出格式、术语表等。

```Bash
curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/memory_stores/$STORE_ID/memories" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/<MEMORY_1>.md",
    "content": "<CONTENT_OF_THE_MEMORY>"
  }'
```

单条 Memory 的内容上限为 100 KB，约 25k tokens。单个 Store 最多保存 2,000 条 Memory。建议将记忆拆成多个小而聚焦的文件，避免使用长文档。

<span id=".5oyC6L29LW1lbW9yeS1zdG9yZS3liLAtc2Vzc2lvbg=="></span>

## 挂载 Memory Store 到 Session

Memory Store 需要在创建 Session 时通过 `resources` 数组挂载。与文件和代码仓库资源不同，Memory Store 只能在 Session 创建时挂载，不支持在运行中的 Session 中追加或移除。

可以通过 `instructions` 为本次 Session 提供额外使用说明，例如要求 Agent 在开始任务前先读取偏好文件。`instructions` 会连同 Store 的名称和描述一起展示给 Agent，长度上限为 4,096 字符。

```bash
session=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/sessions" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "agent": "$AGENT_ID",
  "environment_id": "$ENVIRONMENT_ID",
  "resources": [
    {
      "type": "memory_store",
      "memory_store_id": "$STORE_ID",
      "instructions": "<SPECIFIC_INSTRUCTIONS>"
    }
  ]
}
EOF
)

printf '%s\n' "$session"

SESSION_ID=$(jq -er '.id' <<<"$session")
```

单个 Session 最多挂载 10 个 Memory Store。可以按不同使用场景拆分 Store，例如用户偏好、项目上下文、团队共享规范分别管理，并为每个 Store 设置独立访问权限和生命周期。

<span id=".YWdlbnQt5aaC5L2V6K6_6ZeuLW1lbW9yeQ=="></span>

## Agent 如何访问 Memory

* 挂载后的 Memory Store 会出现在沙箱的 `/mnt/memory/` 目录下。Agent 使用标准文件工具读取其中的文件。
* Agent 对 Memory 有只读权限，即可以读取 Memory，但不能写入或修改。
* Agent 对 Memory 的读写会作为普通工具调用出现在 Session 事件流中，例如 `agent.tool_use` 和 `agent.tool_result`。

<span id=".5p-l55yL5ZKM57yW6L6RLW1lbW9yeQ=="></span>

## 查看和编辑 Memory

您可以通过 API 管理 Memory，用于人工审核、纠正错误记忆、导入初始化资料或导出内容。

<span id=".5p-l6K-iLW1lbW9yeS3liJfooag="></span>

### 查询 Memory 列表

可通过 `path_prefix` 按路径前缀浏览 Memory，类似查看目录。

```Bash
curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/memory_stores/$STORE_ID/memories?path_prefix=/&order_by=path&depth=2" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  | jq -r '.data[] | "\(.type)  \(.path)"'
```

<span id=".6K-75Y-WLW1lbW9yeQ=="></span>

### 读取 Memory

读取单条 Memory 会返回完整内容。

```Bash
curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/memory_stores/$STORE_ID/memories/$MEMORY_ID" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  | jq -r '.content'
```

<span id=".5Yib5bu6LW1lbW9yeQ=="></span>

### 创建 Memory

`create` 会在指定 `path` 下新建 Memory；如果路径已存在，不会覆盖原内容。修改已有 Memory 请使用更新接口。

```bash
memory=$(
  curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/memory_stores/$STORE_ID/memories" \
    -H "Authorization: Bearer $ARK_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{
      "path": "/path/of/the/memory",
      "content": "<CONTENT_OF_THE_MEMORY>"
    }'
)

MEMORY_ID=$(jq -r '.id' <<<"$memory")
MEMORY_SHA=$(jq -r '.content_sha256' <<<"$memory")
```

<span id=".5pu05pawLW1lbW9yeQ=="></span>

### 更新 Memory

更新接口可修改内容、路径，或同时修改二者。修改路径可用于重命名或归档。

```Bash
curl -sS --fail-with-body -X POST "https://ark.cn-beijing.volces.com/api/v3/memory_stores/$STORE_ID/memories/$MEMORY_ID" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/new/path"
  }'
```

<span id=".5Yig6ZmkLW1lbW9yeQ=="></span>

### 删除 Memory

```Bash
curl -sS --fail-with-body -X DELETE "https://ark.cn-beijing.volces.com/api/v3/memory_stores/$STORE_ID/memories/$MEMORY_ID" \
  -H "Authorization: Bearer $ARK_API_KEY"
```

<span id=".566h55CGLW1lbW9yeS1zdG9yZQ=="></span>

## 管理 Memory Store

除创建外，Memory Store 还支持查询、删除等操作。

<span id=".5p-l6K-iLXN0b3JlLeWIl-ihqA=="></span>

### 查询 Store 列表

```Bash
curl -sS --fail-with-body "https://ark.cn-beijing.volces.com/api/v3/memory_stores" \
  -H "Authorization: Bearer $ARK_API_KEY"
```

<span id=".5Yig6ZmkLXN0b3Jl"></span>

### 删除 Store

```Bash
curl -sS --fail-with-body -X DELETE "https://ark.cn-beijing.volces.com/api/v3/memory_stores/$STORE_ID" \
  -H "Authorization: Bearer $ARK_API_KEY"
```

<span id=".5pyA5L2z5a6e6Le1"></span>

## 最佳实践

当 Store 达到 2,000 条 Memory 上限后，新 Memory 写入会失败。已有 Memory 仍可读取和更新。建议按以下方式管理长期记忆：

* **按用途拆分 Store** ：不要把所有内容放进一个通用 Store。可以按用户、团队共享知识、项目上下文分别建 Store。
* **在接近上限前整理内容** ：定期删除过期或重复 Memory，或将碎片化内容整理成更稳定的摘要 Store。

<a id="doc-2553729"></a>

---

## Advisor

> 来源：[https://docs.volcengine.com/docs/82379/2553729?lang=zh](https://docs.volcengine.com/docs/82379/2553729?lang=zh)

Advisor 是方舟 Managed Agents 提供的进阶能力，属于 `evolution`（演进工具）下的核心能力之一，也是「Agent 自我进化」能力的重要组成部分。开启后，当 Agent 在执行任务过程中多次执行失败、遇到当前模型无法处理的问题时，会自动唤起更强的顾问模型提供指导，帮助 Agent 突破能力边界、提升复杂任务的完成质量。

本文介绍如何为 Agent 开启和使用 Advisor。

<span id=".YWR2aXNvci3phY3nva7or7TmmI4="></span>

# Advisor 配置说明

Advisor 是 `evolution` 工具集中的一个子工具，通过 Agent 的 `tools` 字段配置。

配置结构如下：

```json
{
  "tools": [
    {
      "type": "evolution",
      "configs": [
        {
          "name": "advisor",
          "enabled": true
        }
      ]
    }
  ]
}
```

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip"><code>default_config</code> 和 <code>permission_policy</code> 是 API 返回中的字段，表示系统默认值。创建/更新时无需传入，系统会自动使用默认值 <code>always_allow</code>。</div>

字段说明

---

**tools[].type** `string` `必填`

工具类型，固定为 `evolution`。

---

**tools[].configs** `object[]` `选填`

演进工具的子工具配置列表。

---

configs. **name** `string` `必填`

子工具名称，Advisor 对应值为 `advisor`。

---

configs. **enabled** `boolean` `选填`

是否启用该子工具。默认值：`true`。

&nbsp;

<span id=".5YeG5aSH5bel5L2c"></span>

# 准备工作

开始前你需要：

* 已创建的 API Key：配置为环境变量 `ARK_API_KEY`，详情请参见 [API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)。
* 已创建的 Agent：详情请参见 [定义 Agent](https://www.volcengine.com/docs/82379/2553716)。
* 已创建的 Environment：详情请参见 [配置云环境](https://www.volcengine.com/docs/82379/2553721)。

本章节示例的 Base URL 与鉴权方式详情请参见 [Base URL 及鉴权](https://www.volcengine.com/docs/82379/1298459)。

<span id=".5byA5ZCvLWFkdmlzb3I="></span>

# 开启 Advisor

<span id=".5o6n5Yi25Y-w5pa55byP"></span>

## 控制台方式

1. 进入 [Agent 管理页面](https://console.volcengine.com/ark/region:ark+cn-beijing/managed-agent/agents)。
2. 点击「创建 Agent」，或在已有 Agent 卡片上点击「编辑」。
3. 在「05 高级参数」区域，找到「Advisor」开关，打开即可。
4. 点击「保存」。

开启后，该 Agent 的所有新 Session 都会自动启用 Advisor 能力。

<span id=".YXBpLeaWueW8jw=="></span>

## API 方式

创建或更新 Agent 时，在 `tools` 中挂载 `evolution` 类型并配置 `advisor` 即可开启。

<span id=".5Yib5bu65pe25byA5ZCv"></span>

### 创建时开启

<Tabs>
<Tab zoneid="L56z8Flzze" title="cURL">
<TabTitle>cURL</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-advisor-agent",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "system": "你是一个资深的代码工程师，负责处理复杂的编码和故障排查任务。",
    "tools": [
      {
        "type": "agent_toolset_20260701"
      },
      {
        "type": "evolution",
        "configs": [
          {
            "name": "advisor",
            "enabled": true
          }
        ]
      }
    ]
  }'
```

</Tab>
</Tabs>

示例响应如下：

```json
{
  "id": "agent-20260702070355-xxxxx",
  "type": "agent",
  "name": "my-advisor-agent",
  "version": 1,
  "model": {
    "id": "doubao-seed-2-1-pro-260628",
    "speed": "standard"
  },
  "tools": [
    {
      "type": "agent_toolset_20260701",
      "default_config": {
        "enabled": true
      }
    },
    {
      "type": "evolution",
      "configs": [
        {
          "name": "advisor",
          "enabled": true,
          "permission_policy": {
            "type": "always_allow"
          }
        }
      ],
      "default_config": {
        "enabled": true,
        "permission_policy": {
          "type": "always_allow"
        }
      }
    }
  ],
  "created_at": "2026-07-02T07:03:55Z",
  "updated_at": "2026-07-02T07:03:55Z"
}
```

<span id=".5pu05paw5bey5pyJLWFnZW50"></span>

### 更新已有 Agent

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip">更新时需要传入当前 <code>version</code>，版本号不匹配会更新失败。更新成功后会生成新版本。</div>

<Tabs>
<Tab zoneid="SRt1BhzZSl" title="cURL">
<TabTitle>cURL</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents/{agent_id} \
  -X POST \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "version": 1,
    "tools": [
      {
        "type": "agent_toolset_20260701"
      },
      {
        "type": "evolution",
        "configs": [
          {
            "name": "advisor",
            "enabled": true
          }
        ]
      }
    ]
  }'
```

</Tab>
</Tabs>

<div data-tips="true" data-tips-type="warning" data-tips-is-title="true">注意</div>

<div data-tips="true" data-tips-type="warning"><code>tools</code> 使用覆盖逻辑。请求体一旦传入 <code>tools</code>，系统会用该数组整体覆盖 Agent 当前的 <code>tools</code> 配置，不会在原有基础上追加。如果你只想新增或调整某个工具，需要先读取当前 Agent 的 <code>tools</code>，再把「需要保留的工具 + 新的工具」一起写回请求体。</div>

<span id=".5bel5L2c5pa55byP"></span>

# 工作方式

开启 Advisor 后，Agent 在 Session 中执行任务时，遇到以下情况会自动唤起顾问模型：

* Agent 多次执行失败，无法通过自身能力解决
* 当前模型返回工具调用异常、输出格式错误
* 反复卡在同一问题无法推进
* 系统提示词中引导的关键决策节点

顾问模型会接收完整的任务上下文，给出指导建议后，Agent 继续执行。整个过程无需人工干预。

<span id=".6KeC5a-fLWFkdmlzb3It6LCD55So"></span>

# 观察 Advisor 调用

Advisor 的调用过程可以通过 Session 事件流观测。事件流中会出现以下事件：

| 事件类型                     | 说明                               |
| ---------------------------- | ---------------------------------- |
| `agent.advisor_call_start` | Advisor 调用开始                   |
| `agent.advisor_call_end`   | Advisor 调用结束，包含顾问建议内容 |

查看方式：

* **控制台 Debug 模式** ：在 Agent 调试页面切换到 Debug 模式，可直观看到 Advisor 调用的时间点和内容。
* **事件流 API** ：通过 Session Events 接口获取完整事件流，编程方式处理。

事件流的使用方式详见 [Session 事件流](https://www.volcengine.com/docs/82379/2553725)。

<span id=".57O757uf5o-Q56S66K-N5bu66K6u"></span>

# 系统提示词建议

开启 Advisor 后，建议在系统提示词中明确告知 Agent 何时应该寻求顾问帮助，以获得更好的效果。以下是一段参考模板：

```text
你是一个专业的代码工程师。你有一个顾问模型可以提供更高级的架构指导和代码审查。

在以下情况下，请主动寻求顾问的帮助：
1. 在开始编写复杂代码之前，先咨询架构设计方案
2. 当你连续两次尝试同一问题仍未解决时
3. 当你需要在多个技术方案之间做选择时
4. 在任务完成前，进行最终的代码质量审查

对于顾问的建议，请认真考虑并采纳。如果你有充分的理由认为建议不适用，可以坚持自己的方案，但需要在回复中说明原因。
```

<span id=".6K6h6LS56K-05piO"></span>

# 计费说明

Advisor 调用产生的 Token 费用按顾问模型的价格单独计费，不计入执行模型的用量。具体计费规则请参考方舟 Managed Agents 的[计费说明](https://www.volcengine.com/docs/82379/1299378)。

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip">Beta 阶段 Advisor 功能可能有免费额度或优惠政策，具体以控制台公示为准。</div>

<span id=".55u45YWz5paH5qGj"></span>

# 相关文档

<columns>
<columnsItem zoneid="XPMdKMX6Pa">

<card mode="section" href="/docs/82379/2553719" >

<span id="tools"></span>

#### [Tools](https://www.volcengine.com/docs/82379/2553719)

了解 Agent 支持的工具类型和配置方式，包括 evolution 演进工具。

</card>

<card mode="section" href="/docs/82379/2553730" >

<span id="multi-agent"></span>

#### [Multi Agent](https://www.volcengine.com/docs/82379/2553730)

Multi Agent 支持一个协调器 Agent 将任务委派给多个子智能体并行执行。

</card>

</columnsItem>
<columnsItem zoneid="tJMZ6AqoYf">

<card mode="section" href="/docs/82379/2553731" >

<span id=".5a6a5LmJLW91dGNvbWU="></span>

#### [定义 Outcome](https://www.volcengine.com/docs/82379/2553731)

Outcome 支持定义任务验收标准，Agent 自动迭代直到达标。

</card>

<card mode="section" href="/docs/82379/2553725" >

<span id=".c2Vzc2lvbi3kuovku7bmtYE="></span>

#### [Session 事件流](https://www.volcengine.com/docs/82379/2553725)

通过事件流实时观测 Agent 的执行过程，包括 Advisor 调用。

</card>

</columnsItem>
</columns>

<a id="doc-2553730"></a>

---

## Multi Agent

> 来源：[https://docs.volcengine.com/docs/82379/2553730?lang=zh](https://docs.volcengine.com/docs/82379/2553730?lang=zh)

Multi Agent（多智能体协作）是方舟 Managed Agents 提供的进阶能力，属于 Agent 的能力扩展之一：允许一个 Agent（协调器）将任务委派给其他 Agent（子智能体）执行，实现多智能体之间的分工协作。通过专业化分工和并行执行，提升复杂任务的处理效率和输出质量。

本文介绍如何为 Agent 配置和使用 Multi Agent。

<span id=".bXVsdGktYWdlbnQt6YWN572u5a2X5q61"></span>

# Multi Agent 配置字段

`multiagent` 字段的完整结构（`type` / `agents[]` / `agents[].type` / `agents[].id` / `agents[].version`），请参见 [创建智能体 API](https://www.volcengine.com/docs/82379/2555910) 中的 `multiagent` 参数说明。

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip">配置了 Multi Agent 的 Agent（协调器）不能再被选作其他 Agent 的子智能体，避免循环调用。</div>

<span id=".5YeG5aSH5bel5L2c"></span>

# 准备工作

开始前你需要：

* 已创建的 API Key：配置为环境变量 `ARK_API_KEY`，详情请参见 [API Key 管理](https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey)。
* 已创建的 Agent：详情请参见 [定义 Agent](https://www.volcengine.com/docs/82379/2553716)。
* 已创建的 Environment：详情请参见 [配置云环境](https://www.volcengine.com/docs/82379/2553721)。

本章节示例的 Base URL 与鉴权方式详情请参见 [Base URL 及鉴权](https://www.volcengine.com/docs/82379/1298459)。

在配置 Multi Agent 之前，你需要：

1. 已经创建好所有需要用作子智能体的 Agent，并记录它们的 Agent ID。
2. 每个子智能体已经配置好各自的模型、系统提示词、Skills、Tools 等。
3. 准备好作为协调器的 Agent。

<span id=".6YWN572uLW11bHRpLWFnZW50"></span>

# 配置 Multi Agent

<span id=".5o6n5Yi25Y-w5pa55byP"></span>

## 控制台方式

1. 进入 [Agent 管理页面](https://console.volcengine.com/ark/region:ark+cn-beijing/managed-agent/agents)。
2. 选择一个将作为协调器的 Agent，点击「编辑」（或新建一个 Agent）。
3. 在左侧「04 能力扩展」区域，找到「Multi Agents」，点击「添加」。
4. 从列表中选择已创建的子智能体，可添加多个并调整顺序。
5. 在系统提示词中说明每个子智能体的专长和使用场景。
6. 点击「保存」。

<span id=".YXBpLeaWueW8jw=="></span>

## API 方式

创建或更新 Agent 时，传入 `multiagent` 配置即可开启 Multi Agent。

<span id=".5Yib5bu65Y2P6LCD5ZmoLWFnZW50"></span>

### 创建协调器 Agent

<Tabs>
<Tab zoneid="eOkvL0ekiM" title="cURL">
<TabTitle>cURL</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "engineering-lead",
    "model": {
      "id": "doubao-seed-2-1-pro-260628"
    },
    "system": "你是技术负责人，负责协调团队完成开发任务。根据任务需要，委派给合适的团队成员。",
    "multiagent": {
      "type": "coordinator",
      "agents": [
        {
          "type": "agent",
          "id": "agent-20260702070101-xxxxx"
        },
        {
          "type": "agent",
          "id": "agent-20260702070202-yyyyy"
        },
        {
          "type": "self"
        }
      ]
    }
  }'
```

</Tab>
</Tabs>

示例响应如下：

```json
{
  "id": "agent-20260702070355-xxxxx",
  "type": "agent",
  "name": "engineering-lead",
  "version": 1,
  "model": {
    "id": "doubao-seed-2-1-pro-260628",
    "speed": "standard"
  },
  "multiagent": {
    "type": "coordinator",
    "agents": [
      {
        "type": "agent",
        "id": "agent-20260702070101-xxxxx"
      },
      {
        "type": "agent",
        "id": "agent-20260702070202-yyyyy"
      },
      {
        "type": "self"
      }
    ]
  },
  "created_at": "2026-07-02T07:03:55Z",
  "updated_at": "2026-07-02T07:03:55Z"
}
```

<span id=".5pu05paw5bey5pyJLWFnZW50"></span>

### 更新已有 Agent

<div data-tips="true" data-tips-type="tip" data-tips-is-title="true">说明</div>

<div data-tips="true" data-tips-type="tip">更新时需要传入当前 <code>version</code>，版本号不匹配会更新失败。更新成功后会生成新版本。</div>

<Tabs>
<Tab zoneid="mI3woeGOSX" title="cURL">
<TabTitle>cURL</TabTitle>

```Bash
curl https://ark.cn-beijing.volces.com/api/v3/agents/{agent_id} \
  -X POST \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "version": 1,
    "multiagent": {
      "type": "coordinator",
      "agents": [
        {
          "type": "agent",
          "id": "agent-20260702070101-xxxxx"
        },
        {
          "type": "agent",
          "id": "agent-20260702070202-yyyyy"
        }
      ]
    }
  }'
```

</Tab>
</Tabs>

<span id=".5bel5L2c5pa55byP"></span>

# 工作方式

<span id=".5Lya6K-d57q_56iL5py65Yi2"></span>

## 会话线程机制

Multi Agent 基于「会话线程」机制实现上下文隔离：

* **主线程** ：协调器所在的主会话线程，与用户直接交互。
* **子线程** ：每个被委派的子智能体在独立的子线程中运行，拥有独立的对话历史。
* **线程持久化** ：子线程在整个会话生命周期内持久存在，协调器可以向同一个子智能体发送后续消息。

<span id=".5aeU5rS-5rWB56iL"></span>

## 委派流程

1. 用户向协调器发送任务。
2. 协调器分析任务，决定是否需要委派、委派给谁。
3. 系统创建子线程，启动子智能体。
4. 子智能体在子线程中独立执行任务，使用自己的工具和能力。
5. 子智能体完成任务后，将结果返回给协调器。
6. 协调器汇总所有子智能体的结果，输出最终响应。

<span id=".57O757uf5o-Q56S66K-N5bu66K6u"></span>

# 系统提示词建议

协调器的系统提示词直接影响任务拆分和委派的质量。以下是一些编写建议：

<span id=".5piO56Gu5a2Q5pm66IO95L2T55qE6IO95Yqb6L6555WM"></span>

## 明确子智能体的能力边界

清晰描述每个子智能体的专长、擅长领域和不擅长的事情，帮助协调器做出正确的委派决策。

```text
你有以下团队成员可以调用：

【代码审查员】
- 专长：代码质量审查、架构设计评估、安全漏洞检测
- 输入：完整的代码文件或代码片段
- 输出：审查报告，包含问题列表和改进建议
- 不擅长：功能开发、编写新代码

【测试工程师】
- 专长：单元测试编写、测试用例设计、覆盖率分析
- 输入：代码文件 + 功能需求描述
- 输出：测试代码文件 + 测试报告
```

<span id=".5a6a5LmJ5Y2P5L2c5rWB56iL"></span>

## 定义协作流程

明确任务流转的方式，比如是否需要串行、是否可以并行、什么情况下需要复审等。

```text
工作流程：
1. 收到开发任务后，先委派给开发工程师实现
2. 开发完成后，同时委派给代码审查员和测试工程师
3. 收到审查和测试结果后，汇总反馈给开发工程师修改
4. 重复上述过程直到达标
5. 最后委派给文档工程师更新文档
```

<span id=".6KeC5a-f5omn6KGM6L-H56iL"></span>

# 观察执行过程

Multi Agent 的执行过程可以通过事件流观测：

| 观测维度             | 说明                                       |
| -------------------- | ------------------------------------------ |
| **主线程事件** | 协调器的思考、工具调用、子智能体委派决策   |
| **子线程事件** | 每个子智能体的完整执行过程，可以单独查看   |
| **线程状态**   | 各子线程的运行状态（运行中、空闲、已终止） |

在控制台 Debug 模式下，可以通过线程切换器在主线程和各子线程之间切换，查看每个智能体的完整执行轨迹。

事件流的使用方式详见 [Session 事件流](https://www.volcengine.com/docs/82379/2553725)。

<span id=".5rOo5oSP5LqL6aG5"></span>

# 注意事项

<span id=".54mI5pys6ZSB5a6a"></span>

## 版本锁定

协调器创建时会锁定子智能体的版本号。后续子智能体更新版本后，协调器不会自动升级，需要手动更新协调器配置才能使用新版本的子智能体。

<span id=".5bWM5aWX6ZmQ5Yi2"></span>

## 嵌套限制

Multi Agent 目前只支持一层委派：协调器 → 子智能体。子智能体不能再配置 Multi Agent 作为下一级协调器，即不支持深度大于 1 的嵌套调用。

<span id=".5pWw6YeP6ZmQ5Yi2"></span>

## 数量限制

单个协调器最多可以配置 20 个不同的子智能体。但协调器可以调用同一个子智能体多次，产生多个并行的子线程。

<span id=".6LWE5rqQ5LiO6K6h6LS5"></span>

## 资源与计费

* 每个子线程独立消耗模型 Token 和沙箱资源。
* 子智能体的费用按各自的模型和使用量分别计费。
* 沙箱环境和文件系统在协调器和子智能体之间共享。

具体计费规则请参考方舟 Managed Agents 的[计费说明](https://www.volcengine.com/docs/82379/1299378)。

<span id=".55u45YWz5paH5qGj"></span>

# 相关文档

<columns>
<columnsItem zoneid="wMODsSdHHh">

<card mode="section" href="/docs/82379/2553729" >

<span id="advisor"></span>

#### [Advisor](https://www.volcengine.com/docs/82379/2553729)

Advisor 在 Agent 遇到困难时自动唤起更强的顾问模型提供指导。

</card>

<card mode="section" href="/docs/82379/2553731" >

<span id=".5a6a5LmJLW91dGNvbWU="></span>

#### [定义 Outcome](https://www.volcengine.com/docs/82379/2553731)

Outcome 支持定义任务验收标准，Agent 自动迭代直到达标。

</card>

</columnsItem>
<columnsItem zoneid="TSWYgASTPG">

<card mode="section" href="/docs/82379/2553716" >

<span id=".5a6a5LmJLWFnZW50"></span>

#### [定义 Agent](https://www.volcengine.com/docs/82379/2553716)

了解如何创建和管理 Agent，包括 Multi Agent 配置。

</card>

</columnsItem>
</columns>
