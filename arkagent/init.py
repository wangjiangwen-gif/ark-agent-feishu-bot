"""交互式初始化：创建 客户A 销售助手 Agent + Environment + Vault + static_bearer 凭据，并写 config.env。

与原 TS init 的差异：
  - Agent 从「lark-cli 办公助手」改为「客户A 销售助手」：挂 mcp_servers + mcp_toolset（连 mock MCP）+ agent_toolset（读 Memory Store）。
  - 去掉用户 OAuth：飞书应用仅需 tenant 身份；OpenID 在运行时从消息事件直接取。
  - 新增 static_bearer 凭据（卡点 A）：创建时方舟会握手探测 MCP，故 MCP 必须先公网可达。
  - Environment 只放通用配置（透传 FEISHU_USER_OPEN_ID 靠会话级 override，卡点 B）。
"""
from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass
from typing import Awaitable, Callable

from .ark import ArkClient
from .config import serialize_env
from .node_helper import FeishuAppCredentials

CUSTOMER_A_AGENT_NAME = "客户A销售助手（方舟 MA 版）"
MCP_SERVER_NAME = "customer-a-mock"

CUSTOMER_A_AGENT_SYSTEM = """你是客户A门店的销售助手，服务对象是门店销售顾问与销售经理。

# 身份与数据边界
运行环境通过环境变量 FEISHU_USER_OPEN_ID 注入当前用户的飞书 open_id。需要用到 open_id 时，用 bash 执行 `printf '%s' "$FEISHU_USER_OPEN_ID"` 读取它的值；调用 MCP 工具（如 get_my_sales_data）查询用户专属数据时，必须把该 open_id 作为参数传入；不要臆造或串用他人 open_id。

# 岗位信息
运行时会通过 system.message 事件收到「当前用户岗位信息」的 JSON 声明。处理规则：
1. 若上下文出现多次岗位声明，以最近一次为准（在前的视为过期）。
2. 在权限判定、数据过滤、话术风格上严格以最近一次岗位声明为准。
3. 若从未收到任何岗位声明，先向用户确认岗位后再回答。

# 长期记忆
若挂载了记忆目录（/mnt/memory/），任务开始前先读取其中的用户画像与历史客户跟进笔记，据此个性化回答；记忆只读。

# 工具使用（重要）
- get_my_sales_data(open_id)：查询当前用户的销售线索与业绩看板。
- get_vehicle_info(model)：查询车型定位、续航与卖点，用于话术与答疑。
- get_team_pipeline(open_id)：查询本门店团队销售漏斗（各阶段数量、成员业绩）。此接口由后端按数据权限校验——仅销售经理有权，普通顾问会收到 forbidden 错误。用户问「团队漏斗/整体业绩/成员完成情况」时调用它。
这些工具已作为可直接调用的函数注入到你的工具列表中。查询业务数据时，**直接调用它们**并以返回结果为准。
若工具返回 forbidden/unauthorized 等错误，说明后端判定当前用户无权限，如实向用户说明「你当前岗位无权查看该数据」，不要伪造数据绕过，也不要声称是系统故障。
严禁把它们当成沙箱内的本地服务去寻找：不要用 bash/read 去列插件目录、扫描 localhost 端口、翻找可执行文件或配置。bash 的唯一合法用途是读取 FEISHU_USER_OPEN_ID 环境变量与读写 /mnt/memory 记忆文件。
不要凭记忆编造数据。不要打印任何 token、密钥或环境变量原文。命令失败先分析原因，不要原样重试。"""


@dataclass(frozen=True)
class InitResult:
    agent_id: str
    environment_id: str
    vault_id: str
    credential_id: str
    environment_created: bool
    env_path: str


def build_customer_a_agent_config(mcp_server_url: str) -> dict:
    """客户A 销售助手 Agent 定义：mcp_servers/mcp_toolset 一一对应 + agent_toolset 读记忆。"""
    return {
        "name": CUSTOMER_A_AGENT_NAME,
        "description": "客户A门店销售助手：按用户身份查线索/业绩，读长期记忆，答车型话术",
        "model": {"id": "doubao-seed-2-1-pro-260628"},
        "system": CUSTOMER_A_AGENT_SYSTEM,
        "tools": [
            # 卡点 D 需要 agent_toolset 的 read/glob/grep 读 /mnt/memory/；卡点 B 需要 bash 读
            # 环境变量 FEISHU_USER_OPEN_ID 拿到当前用户 open_id。所以 bash 必须保留，但要靠 system
            # prompt 强约束用途——否则 doubao 面对"查数据"会拿 bash 去沙箱瞎找远程 MCP（翻 plugins、
            # 扫端口），不直接调 mcp_toolset。web_search/web_fetch 本场景用不到，关掉减少干扰。
            {
                "type": "agent_toolset_20260701",
                "default_config": {"enabled": True},
                "configs": [
                    {"name": "web_search", "enabled": False},
                    {"name": "web_fetch", "enabled": False},
                ],
            },
            {
                "type": "mcp_toolset",
                "mcp_server_name": MCP_SERVER_NAME,
                "default_config": {"permission_policy": {"type": "always_allow"}},
            },
        ],
        "skills": [],
        "mcp_servers": [
            {"type": "url", "name": MCP_SERVER_NAME, "url": mcp_server_url},
        ],
        "metadata": {"created_via": "customer-a-ma-demo", "scenario": "customer-a-sales-assistant"},
    }


def _sanitize(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-")
    return cleaned or "agent"


async def run_guided_init(
    *,
    ark_api_key: str,
    mcp_server_url: str,
    mcp_static_bearer: str,
    create_ark: Callable[[str, str], ArkClient],
    create_feishu_app: Callable[[], Awaitable[FeishuAppCredentials]],
    ark_base_url: str = "https://ark.cn-beijing.volces.com/api/v3",
    env_path: str = ".env",
    gateway_database_path: str = "./data/gateway.db",
    role_ttl_ms: int = 86_400_000,
    team_store_enabled: bool = False,
) -> InitResult:
    ark = create_ark(ark_api_key, ark_base_url.rstrip("/"))

    # 创建是非幂等操作，失败后不自动重试。
    agent = await ark.create_agent(build_customer_a_agent_config(mcp_server_url))

    feishu_app = await create_feishu_app()

    # Vault：稳定命名，便于重跑 init 复用。
    vault_name = f"customer-a-ma-{_sanitize(agent['id'])}"[:100]
    vaults = await ark.list_vaults()
    vault = next((v for v in vaults if v["display_name"] == vault_name), None)
    vault_id = vault["id"] if vault else await ark.create_vault(vault_name)

    # 卡点 A：static_bearer 凭据。创建时方舟握手探测 MCP，不可达会直接 4xx 失败。
    credential_name = "customer-a-mcp-static-bearer"
    existing = next(
        (c for c in await ark.list_credentials(vault_id) if c["display_name"] == credential_name and c["auth_type"] == "static_bearer"),
        None,
    )
    if existing:
        credential_id = existing["id"]
    else:
        credential_id = await ark.create_static_bearer_credential(vault_id, credential_name, mcp_server_url, mcp_static_bearer)

    # Environment：稳定命名（含 App ID，避免误复用旧应用的 Environment）。
    environment_name = f"customer-a-ma-{_sanitize(agent['id'])}-{_sanitize(feishu_app.app_id)}"[:60]
    environments = await ark.list_environments()
    environment = next((e for e in environments if e["name"] == environment_name), None)
    environment_created = False
    if not environment:
        try:
            environment = await ark.create_environment(environment_name)
            environment_created = True
        except Exception:
            environments = await ark.list_environments()
            environment = next((e for e in environments if e["name"] == environment_name), None)
            if not environment:
                raise

    content = serialize_env(
        {
            "ARK_API_KEY": ark_api_key,
            "ARK_AGENT_ID": agent["id"],
            "ARK_ENVIRONMENT_ID": environment["id"],
            "ARK_VAULT_ID": vault_id,
            "ARK_BASE_URL": ark_base_url.rstrip("/"),
            "FEISHU_APP_ID": feishu_app.app_id,
            "FEISHU_APP_SECRET": feishu_app.app_secret,
            "MCP_SERVER_URL": mcp_server_url,
            "GATEWAY_DB_PATH": gateway_database_path,
            "SESSION_TIMEOUT_MS": "600000",
            "ROLE_TTL_MS": str(role_ttl_ms),
            "TEAM_STORE_ENABLED": "true" if team_store_enabled else "false",
        }
    )
    _write_secure(env_path, content)
    return InitResult(
        agent_id=agent["id"],
        environment_id=environment["id"],
        vault_id=vault_id,
        credential_id=credential_id,
        environment_created=environment_created,
        env_path=env_path,
    )


def _write_secure(path: str, content: str) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, mode=0o700, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
