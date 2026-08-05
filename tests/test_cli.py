import io
from contextlib import redirect_stderr, redirect_stdout

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
