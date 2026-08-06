import io
import os
from contextlib import redirect_stderr, redirect_stdout

import pytest

from arkagent import cli


def test_help_lists_commands():
    out = io.StringIO()
    with redirect_stdout(out):
        code = cli.main(["help"])
    assert code == 0
    text = out.getvalue()
    assert "init" in text and "doctor" in text and "run" in text


def test_missing_config_gives_hint(monkeypatch, tmp_path):
    # 指向一个没有 config.env 的目录，且清空必填环境变量 → 触发缺少环境变量提示。
    monkeypatch.setenv("ARKAGENT_HOME", str(tmp_path))
    for key in ("ARK_API_KEY", "ARK_AGENT_ID", "ARK_ENVIRONMENT_ID", "ARK_VAULT_ID", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "MCP_SERVER_URL"):
        monkeypatch.delenv(key, raising=False)
    err = io.StringIO()
    with redirect_stderr(err):
        code = cli.main(["doctor"])
    assert code == 1
    assert "arkagent init" in err.getvalue()


def test_mask_identity():
    assert cli._mask_identity("short") == "***"
    assert cli._mask_identity("ou-1234567890") == "ou-12***890"


def test_parse_mcp_url_arg_forms():
    assert cli._parse_mcp_url_arg([]) is None
    assert cli._parse_mcp_url_arg(["--other", "x"]) is None
    assert cli._parse_mcp_url_arg(["--mcp-url", "https://a/mcp"]) == "https://a/mcp"
    assert cli._parse_mcp_url_arg(["--mcp-url=https://b/mcp"]) == "https://b/mcp"
    # 前后空白被裁剪
    assert cli._parse_mcp_url_arg(["--mcp-url", "  https://c/mcp  "]) == "https://c/mcp"


def test_parse_mcp_url_arg_missing_value_raises():
    with pytest.raises(RuntimeError, match="--mcp-url"):
        cli._parse_mcp_url_arg(["--mcp-url"])


def test_looks_like_placeholder_token():
    # 无效：缺失 / 占位 / 误填成 URL
    assert cli._looks_like_placeholder_token(None) is True
    assert cli._looks_like_placeholder_token("") is True
    assert cli._looks_like_placeholder_token("   ") is True
    assert cli._looks_like_placeholder_token("xxx") is True
    assert cli._looks_like_placeholder_token("XXXX") is True
    assert cli._looks_like_placeholder_token("changeme") is True
    assert cli._looks_like_placeholder_token("https://71355983.r16.cpolar.top/mcp") is True
    # 有效：真实 token
    assert cli._looks_like_placeholder_token("demo-bearer-token") is False
    assert cli._looks_like_placeholder_token("sk-abc123") is False


class _FakeUpdateArk:
    """update-agent --mcp-url 编排用的假 ArkClient。"""

    def __init__(self, *_args, credentials=None, agent_version="5"):
        self._credentials = credentials or []
        self._agent_version = agent_version
        self.static_bearer_creates: list[tuple] = []
        self.deleted: list[str] = []
        self.updated_config = None

    async def get_agent(self, agent_id):
        return {"id": agent_id, "version": self._agent_version}

    async def list_credentials(self, vault_id):
        return list(self._credentials)

    async def create_static_bearer_credential(self, vault_id, display_name, mcp_server_url, token):
        self.static_bearer_creates.append((display_name, mcp_server_url, token))
        return "vcrd-new"

    async def update_agent(self, agent_id, config, version):
        self.updated_config = config
        return {"id": agent_id, "version": str(int(version) + 1)}

    async def delete_credential(self, vault_id, credential_id):
        self.deleted.append(credential_id)

    async def aclose(self):
        pass


def _write_config_env(path, **overrides):
    from arkagent.config import serialize_env

    values = {
        "ARK_API_KEY": "ark-key",
        "ARK_AGENT_ID": "agent-1",
        "ARK_ENVIRONMENT_ID": "env-1",
        "ARK_VAULT_ID": "vlt-1",
        "FEISHU_APP_ID": "cli-1",
        "FEISHU_APP_SECRET": "secret",
        "MCP_SERVER_URL": "https://old.example.com/mcp",
        "MCP_STATIC_BEARER": "demo-bearer-token",
    }
    values.update(overrides)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(serialize_env(values))


def test_update_agent_mcp_url_cleans_stale_credential_by_url(monkeypatch, tmp_path):
    """换址时按 URL（而非名字）清理旧凭据：异名旧凭据要删，已在新址的凭据要留。"""
    monkeypatch.setenv("ARKAGENT_HOME", str(tmp_path))
    config_path = os.path.join(str(tmp_path), "config.env")
    _write_config_env(config_path)  # 旧址 old.example.com

    new_url = "https://new.example.com/mcp"
    fake = _FakeUpdateArk(
        credentials=[
            # 历史遗留的异名凭据，指向旧址 → 应被删
            {"id": "vcrd-old", "display_name": "nio-mcp-static-bearer", "auth_type": "static_bearer", "mcp_server_url": "https://old.example.com/mcp"},
            # 已经指向新址的凭据 → 应保留
            {"id": "vcrd-keep", "display_name": "customer-a-mcp-static-bearer", "auth_type": "static_bearer", "mcp_server_url": new_url},
        ]
    )
    monkeypatch.setattr("arkagent.ark.ArkClient", lambda *a, **k: fake)

    out = io.StringIO()
    with redirect_stdout(out):
        code = cli.main(["update-agent", "--mcp-url", new_url])

    assert code == 0
    # 建了新址凭据
    assert fake.static_bearer_creates == [("customer-a-mcp-static-bearer", new_url, "demo-bearer-token")]
    # 只删了指向旧址的那条异名凭据，新址凭据保留
    assert fake.deleted == ["vcrd-old"]
    # Agent 指向新址
    assert fake.updated_config["mcp_servers"][0]["url"] == new_url
    # config.env 已写回新址
    from arkagent.config import parse_env_text

    written = parse_env_text(open(config_path, encoding="utf-8").read())
    assert written["MCP_SERVER_URL"] == new_url


def test_update_agent_mcp_url_rejects_placeholder_token(monkeypatch, tmp_path):
    """token 为占位（xxx）时换址应早失败，且不建/不删任何凭据。"""
    monkeypatch.setenv("ARKAGENT_HOME", str(tmp_path))
    config_path = os.path.join(str(tmp_path), "config.env")
    _write_config_env(config_path, MCP_STATIC_BEARER="xxx")

    fake = _FakeUpdateArk(
        credentials=[
            {"id": "vcrd-old", "display_name": "nio-mcp-static-bearer", "auth_type": "static_bearer", "mcp_server_url": "https://old.example.com/mcp"},
        ]
    )
    monkeypatch.setattr("arkagent.ark.ArkClient", lambda *a, **k: fake)

    err = io.StringIO()
    with redirect_stderr(err):
        code = cli.main(["update-agent", "--mcp-url", "https://new.example.com/mcp"])

    assert code == 1
    assert "MCP_STATIC_BEARER" in err.getvalue()
    # 早失败：既没建新凭据，也没删旧凭据
    assert fake.static_bearer_creates == []
    assert fake.deleted == []
