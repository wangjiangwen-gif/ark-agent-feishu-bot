import os
import stat

import pytest

from arkagent.config import load_config, parse_env_text, serialize_env, update_env_file


def _base_env(**overrides):
    env = {
        "ARK_API_KEY": "ark-key",
        "ARK_AGENT_ID": "agent-1",
        "ARK_ENVIRONMENT_ID": "env-1",
        "ARK_VAULT_ID": "vlt-1",
        "FEISHU_APP_ID": "cli-1",
        "FEISHU_APP_SECRET": "secret",
        "MCP_SERVER_URL": "https://mcp.example.com/mcp",
    }
    env.update(overrides)
    return env


def test_load_config_reports_all_missing_keys_at_once():
    with pytest.raises(RuntimeError) as excinfo:
        load_config({"ARK_API_KEY": "x"})
    message = str(excinfo.value)
    assert "缺少环境变量" in message
    assert "MCP_SERVER_URL" in message
    assert "FEISHU_APP_ID" in message


def test_load_config_applies_defaults():
    config = load_config(_base_env())
    assert config.ark_base_url == "https://ark.cn-beijing.volces.com/api/v3"
    assert config.session_timeout_ms == 600_000
    assert config.role_ttl_ms == 86_400_000
    assert config.authorized_open_ids == ()
    assert config.team_store_enabled is False


def test_load_config_parses_optional_fields():
    config = load_config(_base_env(
        SESSION_TIMEOUT_MS="120000",
        ROLE_TTL_MS="3600000",
        AUTHORIZED_OPEN_IDS="ou-1, ou-2 ou-3",
        TEAM_STORE_ENABLED="true",
        ARK_BASE_URL="https://ark.example.com/api/v3/",
    ))
    assert config.session_timeout_ms == 120_000
    assert config.role_ttl_ms == 3_600_000
    assert config.authorized_open_ids == ("ou-1", "ou-2", "ou-3")
    assert config.team_store_enabled is True
    assert config.ark_base_url == "https://ark.example.com/api/v3"


def test_session_timeout_below_floor_is_rejected():
    with pytest.raises(RuntimeError, match="SESSION_TIMEOUT_MS"):
        load_config(_base_env(SESSION_TIMEOUT_MS="500"))


def test_serialize_and_parse_roundtrip_quotes_values():
    text = serialize_env({"TOKEN": "a b#c"})
    assert text == 'TOKEN="a b#c"\n'
    assert parse_env_text(text) == {"TOKEN": "a b#c"}


def test_update_env_file_updates_key_and_preserves_others(tmp_path):
    path = os.path.join(str(tmp_path), "config.env")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(serialize_env({
            "MCP_SERVER_URL": "https://old.example.com/mcp",
            "MCP_STATIC_BEARER": "demo-bearer-token",
            "ARK_API_KEY": "ark-key",
        }))

    update_env_file(path, {"MCP_SERVER_URL": "https://new.example.com/mcp"})

    result = parse_env_text(open(path, encoding="utf-8").read())
    # 目标键被更新
    assert result["MCP_SERVER_URL"] == "https://new.example.com/mcp"
    # 其余键原样保留
    assert result["MCP_STATIC_BEARER"] == "demo-bearer-token"
    assert result["ARK_API_KEY"] == "ark-key"
    # 权限被收敛到 0600
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
