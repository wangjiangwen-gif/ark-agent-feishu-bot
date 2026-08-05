import json
import logging

from starlette.testclient import TestClient

from mock_mcp import data
from mock_mcp.server import build_app, build_server, mask_token


# ---- data / tool logic ----
def test_authorized_and_bucket_lookup():
    assert data.is_authorized("ou-demo-manager") is True
    assert data.is_authorized("ou-unknown") is False
    assert data.get_user_bucket("ou-demo-sales")["role"] == "销售顾问"


async def _call_tool(server, name, args):
    # FastMCP 工具管理器可直接调用（convert_result=False 返回工具原始返回值）。
    return await server._tool_manager.call_tool(name, args, context=None)


async def test_get_my_sales_data_scopes_by_openid():
    server = build_server()
    ok = await _call_tool(server, "get_my_sales_data", {"open_id": "ou-demo-manager"})
    payload = json.loads(ok)
    assert payload["role"] == "销售经理"
    assert "kpi" in payload

    denied = await _call_tool(server, "get_my_sales_data", {"open_id": "ou-nobody"})
    assert json.loads(denied)["error"] == "unauthorized"


async def test_get_vehicle_info_known_and_unknown():
    server = build_server()
    known = await _call_tool(server, "get_vehicle_info", {"model": "et9"})
    assert json.loads(known)["model"] == "ET9"
    unknown = await _call_tool(server, "get_vehicle_info", {"model": "xx"})
    assert json.loads(unknown)["error"] == "not_found"


# ---- 卡点 A: Bearer 中间件 ----
def test_missing_bearer_is_rejected():
    app = build_app(token="secret-token")
    client = TestClient(app)
    # 未带 token → 401（在 MCP 协议握手之前就被中间件拦截）
    resp = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert resp.status_code == 401
    assert resp.json()["error"] == "unauthorized"


def test_wrong_bearer_is_rejected():
    app = build_app(token="secret-token")
    client = TestClient(app)
    resp = client.post("/mcp", headers={"Authorization": "Bearer wrong"}, json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert resp.status_code == 401


def test_correct_bearer_passes_middleware():
    app = build_app(token="secret-token")
    # 用 context manager 触发 lifespan，初始化 MCP session manager 的 task group。
    with TestClient(app) as client:
        # 带正确 token → 不再是 401（后续 MCP 协议错误另说，这里只验证中间件放行）
        resp = client.post(
            "/mcp",
            headers={"Authorization": "Bearer secret-token", "Accept": "application/json, text/event-stream"},
            json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        )
    assert resp.status_code != 401


# ---- 卡点 A: 掩码日志（证据） ----
def test_mask_token_hides_middle():
    assert mask_token("demo-bearer-token-1234") == "demo…1234"
    assert mask_token("") == "<空>"
    assert mask_token("abcd1234") == "a…4"  # <=8 位只露头尾


def test_reject_logs_masked_token(caplog):
    app = build_app(token="secret-token-abcdef")
    client = TestClient(app)
    with caplog.at_level(logging.WARNING, logger="mock_mcp"):
        resp = client.post("/mcp", headers={"Authorization": "Bearer wrong-token-xyz"},
                            json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert resp.status_code == 401
    # 日志里出现掩码后的 token 与拒绝标记，且不含完整 token
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "401 拒绝" in logged
    assert "wron…-xyz" in logged
    assert "wrong-token-xyz" not in logged
