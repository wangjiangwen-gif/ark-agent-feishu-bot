"""配置加载与校验（精简自原 TS 项目 src/config.ts）。

本 demo 去掉了用户 OAuth / lark-cli，因此删除相关字段，新增 MCP / 岗位 / 白名单等项。
config.env 由 init 写入，格式为 KEY="json-quoted-value"（每行一个），与原 serializeEnv 兼容。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Mapping, Optional

DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_DB_PATH = "./data/gateway.db"
DEFAULT_SESSION_TIMEOUT_MS = 600_000
DEFAULT_ROLE_TTL_MS = 86_400_000

REQUIRED_KEYS = [
    "ARK_API_KEY",
    "ARK_AGENT_ID",
    "ARK_ENVIRONMENT_ID",
    "ARK_VAULT_ID",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "MCP_SERVER_URL",
]


@dataclass(frozen=True)
class GatewayConfig:
    ark_api_key: str
    ark_agent_id: str
    ark_environment_id: str
    ark_vault_id: str
    ark_base_url: str
    feishu_app_id: str
    feishu_app_secret: str
    mcp_server_url: str
    database_path: str
    session_timeout_ms: int
    role_ttl_ms: int
    authorized_open_ids: tuple[str, ...]
    team_store_enabled: bool


def parse_env_text(text: str) -> dict[str, str]:
    """解析 KEY="value" 形式的 config.env。value 用 JSON 解码（兼容原 serializeEnv）。"""
    result: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        try:
            result[key] = json.loads(value)
        except (json.JSONDecodeError, ValueError):
            result[key] = value.strip('"')
    return result


def load_config_file(path: str, env: Optional[dict[str, str]] = None) -> None:
    """把 config.env 显式覆盖进 os.environ（语义同原 loadConfigFile）。"""
    target = os.environ if env is None else env
    with open(path, "r", encoding="utf-8") as fh:
        target.update(parse_env_text(fh.read()))


def _split_open_ids(value: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in value.replace(",", " ").split() if item.strip())


def load_config(env: Optional[Mapping[str, str]] = None) -> GatewayConfig:
    environ = os.environ if env is None else env
    missing = [key for key in REQUIRED_KEYS if not (environ.get(key) or "").strip()]
    if missing:
        raise RuntimeError(f"缺少环境变量：{', '.join(missing)}")

    session_timeout_ms = _positive_int(environ.get("SESSION_TIMEOUT_MS"), DEFAULT_SESSION_TIMEOUT_MS)
    if session_timeout_ms < 1_000:
        raise RuntimeError("SESSION_TIMEOUT_MS 必须是不小于 1000 的数字")
    role_ttl_ms = _positive_int(environ.get("ROLE_TTL_MS"), DEFAULT_ROLE_TTL_MS)

    return GatewayConfig(
        ark_api_key=environ["ARK_API_KEY"],
        ark_agent_id=environ["ARK_AGENT_ID"],
        ark_environment_id=environ["ARK_ENVIRONMENT_ID"],
        ark_vault_id=environ["ARK_VAULT_ID"],
        ark_base_url=(environ.get("ARK_BASE_URL") or DEFAULT_ARK_BASE_URL).rstrip("/"),
        feishu_app_id=environ["FEISHU_APP_ID"],
        feishu_app_secret=environ["FEISHU_APP_SECRET"],
        mcp_server_url=environ["MCP_SERVER_URL"],
        database_path=environ.get("GATEWAY_DB_PATH") or DEFAULT_DB_PATH,
        session_timeout_ms=session_timeout_ms,
        role_ttl_ms=role_ttl_ms,
        authorized_open_ids=_split_open_ids(environ.get("AUTHORIZED_OPEN_IDS") or ""),
        team_store_enabled=(environ.get("TEAM_STORE_ENABLED") or "").strip().lower() in ("1", "true", "yes"),
    )


def _positive_int(value: Optional[str], fallback: int) -> int:
    if value is None or not str(value).strip():
        return fallback
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        raise RuntimeError(f"数值配置无效：{value!r}")
    return parsed if parsed > 0 else fallback


def serialize_env(values: Mapping[str, str]) -> str:
    """把配置写成 KEY="json-quoted-value"（与原 serializeEnv 一致，避免注入可执行 shell）。"""
    return "".join(f"{key}={json.dumps(value, ensure_ascii=False)}\n" for key, value in values.items())
