import os
import tempfile

from arkagent.init import (
    MCP_SERVER_NAME,
    NIO_AGENT_NAME,
    build_nio_agent_config,
    run_guided_init,
)
from arkagent.node_helper import FeishuAppCredentials


def test_nio_agent_config_pairs_mcp_server_and_toolset():
    config = build_nio_agent_config("https://mcp.example.com/mcp")
    assert config["name"] == NIO_AGENT_NAME
    server_names = [s["name"] for s in config["mcp_servers"]]
    toolset_refs = [t["mcp_server_name"] for t in config["tools"] if t["type"] == "mcp_toolset"]
    # mcp_servers 与 mcp_toolset 必须一一对应
    assert server_names == [MCP_SERVER_NAME]
    assert toolset_refs == [MCP_SERVER_NAME]
    # Memory Store 硬前提：agent_toolset 必须在
    assert any(t["type"] == "agent_toolset_20260701" for t in config["tools"])
    assert config["mcp_servers"][0]["url"] == "https://mcp.example.com/mcp"


class FakeArk:
    def __init__(self, environments=None, vaults=None, credentials=None):
        self.agent_creates = 0
        self.env_creates = 0
        self.static_bearer_creates = 0
        self._environments = environments or []
        self._vaults = vaults or []
        self._credentials = credentials or []
        self.last_agent_config = None

    async def create_agent(self, config):
        self.agent_creates += 1
        self.last_agent_config = config
        return {"id": "agent-1", "name": config["name"], "version": "1"}

    async def list_vaults(self):
        return self._vaults

    async def create_vault(self, name):
        return "vlt-new"

    async def list_credentials(self, vault_id):
        return self._credentials

    async def create_static_bearer_credential(self, vault_id, display_name, mcp_server_url, token):
        self.static_bearer_creates += 1
        return "vcrd-new"

    async def list_environments(self):
        return self._environments

    async def create_environment(self, name, env=None):
        self.env_creates += 1
        return {"id": "env-new", "name": name}


async def test_guided_init_reuses_environment_with_stable_name():
    with tempfile.TemporaryDirectory() as tmp:
        env_path = os.path.join(tmp, "config.env")
        ark = FakeArk(
            environments=[{"id": "env-existing", "name": "nio-ma-agent-1-cli-1"}],
            vaults=[{"id": "vlt-1", "display_name": "nio-ma-agent-1"}],
            credentials=[{"id": "vcrd-1", "display_name": "nio-mcp-static-bearer", "auth_type": "static_bearer"}],
        )
        result = await run_guided_init(
            ark_api_key="ark-secret",
            mcp_server_url="https://mcp.example.com/mcp",
            mcp_static_bearer="mcp-token",
            create_ark=lambda key, base: ark,
            create_feishu_app=_fake_app("cli-1"),
            env_path=env_path,
        )
        assert result.environment_id == "env-existing"
        assert result.agent_id == "agent-1"
        assert result.environment_created is False
        assert ark.env_creates == 0
        assert ark.agent_creates == 1
        # 复用已有 static_bearer 凭据，不重复创建
        assert ark.static_bearer_creates == 0
        content = open(env_path, encoding="utf-8").read()
        assert 'ARK_ENVIRONMENT_ID="env-existing"' in content
        assert 'MCP_SERVER_URL="https://mcp.example.com/mcp"' in content
        assert "ARK_CREDENTIAL_ID" not in content  # 本 demo 已去掉该字段


async def test_guided_init_creates_environment_and_static_bearer_when_missing():
    with tempfile.TemporaryDirectory() as tmp:
        env_path = os.path.join(tmp, "config.env")
        ark = FakeArk(environments=[], vaults=[], credentials=[])
        result = await run_guided_init(
            ark_api_key="ark-secret",
            mcp_server_url="https://mcp.example.com/mcp",
            mcp_static_bearer="mcp-token",
            create_ark=lambda key, base: ark,
            create_feishu_app=_fake_app("cli-2"),
            env_path=env_path,
        )
        assert result.environment_created is True
        assert ark.static_bearer_creates == 1
        # 私密写入：文件权限 600
        mode = os.stat(env_path).st_mode & 0o777
        assert mode == 0o600
        content = open(env_path, encoding="utf-8").read()
        assert 'FEISHU_APP_ID="cli-2"' in content


def _fake_app(app_id):
    async def factory():
        return FeishuAppCredentials(app_id=app_id, app_secret="feishu-secret", user_open_id=None)

    return factory
