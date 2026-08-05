import httpx
import pytest
import respx

from arkagent.ark import (
    ArkClient,
    drain_event_buffer,
    event_progress,
    event_text,
    result_from_events,
)

BASE = "https://ark.example/api/v3"


def _client():
    return ArkClient("key", BASE)


# ---- pure SSE helpers ----
def test_drain_event_buffer_parses_split_sse_frames():
    events, rest = drain_event_buffer('data: {"type":"agent.message","id":"1"}\n\ndata: {"type":"session.')
    assert len(events) == 1
    events2, _ = drain_event_buffer(rest + 'status_idle","id":"2"}\n\n')
    assert events2[0]["type"] == "session.status_idle"


def test_drain_event_buffer_parses_ndjson():
    events, _ = drain_event_buffer('{"type":"agent.message","id":"1"}\n{"type":"session.status_idle"}\n')
    assert len(events) == 2


def test_event_text_joins_text_blocks_only():
    assert event_text({"content": [{"type": "text", "text": "甲"}, {"type": "image"}, {"type": "text", "text": "乙"}]}) == "甲\n乙"


def test_event_progress_hides_raw_commands():
    assert event_progress({"type": "agent.tool_use", "name": "bash", "input": {"description": "检查工具", "command": "env | grep TOKEN"}}) == "正在执行：检查工具"
    assert event_progress({"type": "agent.tool_use", "name": "read", "input": {"file_path": "/secret"}}) == "正在调用工具：read"
    assert event_progress({"type": "agent.tool_result", "is_error": True}) == "工具执行未成功，Agent 正在尝试恢复"
    assert event_progress({"type": "agent.thinking"}) is None


def test_result_from_events_only_recovers_current_run():
    since = int(__import__("datetime").datetime.fromisoformat("2026-07-21T17:00:00+08:00").timestamp() * 1000)
    result = result_from_events(
        [
            {"type": "agent.message", "processed_at": "2026-07-21T16:59:00+08:00", "content": [{"type": "text", "text": "旧回复"}]},
            {"type": "agent.message", "processed_at": "2026-07-21T17:00:01+08:00", "content": [{"type": "text", "text": "新回复"}]},
            {"type": "session.status_idle", "processed_at": "2026-07-21T17:00:02+08:00"},
        ],
        since,
    )
    assert result.terminal == "idle"
    assert result.messages == ["新回复"]


# ---- session binding (卡点 B) ----
@respx.mock
async def test_create_session_injects_openid_via_environment_overrides():
    respx.get(f"{BASE}/environments/env-1").mock(
        return_value=httpx.Response(200, json={"id": "env-1", "config": {
            "type": "cloud", "networking": {"type": "unrestricted"},
            "env": {"KEEP_ME": "yes"},
        }})
    )
    route = respx.post(f"{BASE}/sessions").mock(return_value=httpx.Response(200, json={"id": "sesn-1"}))

    client = _client()
    session_id = await client.create_session(
        "agent-1", "env-1", vault_ids=["vlt-1"], env_overrides={"FEISHU_USER_OPEN_ID": "ou-message-user"}
    )
    await client.aclose()

    assert session_id == "sesn-1"
    body = route.calls.last.request.content
    import json
    sent = json.loads(body)
    assert sent["environment"]["type"] == "environment_with_overrides"
    assert sent["environment"]["config"]["env"] == {"KEEP_ME": "yes", "FEISHU_USER_OPEN_ID": "ou-message-user"}
    assert sent["vault_ids"] == ["vlt-1"]
    assert "environment_id" not in sent


@respx.mock
async def test_create_session_without_overrides_uses_environment_id():
    route = respx.post(f"{BASE}/sessions").mock(return_value=httpx.Response(200, json={"id": "sesn-2"}))
    client = _client()
    await client.create_session("agent-1", "env-1")
    await client.aclose()
    import json
    sent = json.loads(route.calls.last.request.content)
    assert sent == {"agent": "agent-1", "environment_id": "env-1"}


@respx.mock
async def test_create_session_mounts_memory_store_resources():
    route = respx.post(f"{BASE}/sessions").mock(return_value=httpx.Response(200, json={"id": "sesn-3"}))
    client = _client()
    await client.create_session(
        "agent-1", "env-1",
        resources=[{"type": "memory_store", "memory_store_id": "mem-1", "instructions": "先读偏好"}],
    )
    await client.aclose()
    import json
    sent = json.loads(route.calls.last.request.content)
    assert sent["resources"][0]["memory_store_id"] == "mem-1"


# ---- system.message (卡点 C) ----
@respx.mock
async def test_send_message_appends_system_message_last():
    route = respx.post(f"{BASE}/sessions/sesn-1/events").mock(return_value=httpx.Response(200, json={"data": []}))
    client = _client()
    await client.send_message("sesn-1", "你好", system_message="你现在是销售经理")
    await client.aclose()
    import json
    sent = json.loads(route.calls.last.request.content)
    assert [e["type"] for e in sent["events"]] == ["user.message", "system.message"]
    assert sent["events"][-1]["content"][0]["text"] == "你现在是销售经理"


# ---- static bearer (卡点 A) ----
@respx.mock
async def test_create_static_bearer_credential_shape():
    route = respx.post(f"{BASE}/vaults/vlt-1/credentials").mock(return_value=httpx.Response(200, json={"id": "vcrd-1"}))
    client = _client()
    cred = await client.create_static_bearer_credential("vlt-1", "NIO MCP", "https://mcp/mcp", "tok")
    await client.aclose()
    assert cred == "vcrd-1"
    import json
    sent = json.loads(route.calls.last.request.content)
    assert sent["auth"] == {"type": "static_bearer", "mcp_server_url": "https://mcp/mcp", "token": "tok"}


@respx.mock
async def test_static_bearer_handshake_failure_propagates():
    respx.post(f"{BASE}/vaults/vlt-1/credentials").mock(
        return_value=httpx.Response(400, text="mcp unreachable", headers={"x-request-id": "req-9"})
    )
    client = _client()
    with pytest.raises(Exception) as excinfo:
        await client.create_static_bearer_credential("vlt-1", "NIO MCP", "https://mcp/mcp", "tok")
    await client.aclose()
    assert "req-9" in str(excinfo.value)


# ---- memory store (卡点 D) ----
@respx.mock
async def test_create_memory_store_and_memory():
    respx.post(f"{BASE}/memory_stores").mock(return_value=httpx.Response(200, json={"id": "memstore-1"}))
    mem_route = respx.post(f"{BASE}/memory_stores/memstore-1/memories").mock(return_value=httpx.Response(200, json={"id": "m-1"}))
    client = _client()
    store_id = await client.create_memory_store("张三的记忆", "个人偏好")
    await client.create_memory(store_id, "/prefs.md", "喜欢简洁回复")
    await client.aclose()
    assert store_id == "memstore-1"
    import json
    sent = json.loads(mem_route.calls.last.request.content)
    assert sent == {"path": "/prefs.md", "content": "喜欢简洁回复"}


# ---- run: SSE before send ----
@respx.mock
async def test_run_opens_stream_before_sending_message():
    order: list[str] = []

    def stream_responder(request):
        order.append("stream")
        body = "\n".join([
            'data: {"type":"agent.message","content":[{"type":"text","text":"完成"}]}',
            "",
            'data: {"type":"session.status_idle"}',
            "",
        ])
        return httpx.Response(200, text=body, headers={"Content-Type": "text/event-stream"})

    def events_responder(request):
        order.append("events")
        return httpx.Response(200, json={"data": []})

    respx.get(f"{BASE}/sessions/session-1/events/stream").mock(side_effect=stream_responder)
    respx.post(f"{BASE}/sessions/session-1/events").mock(side_effect=events_responder)

    client = _client()
    result = await client.run("session-1", "你好", 5_000)
    await client.aclose()
    assert order == ["stream", "events"]
    assert result.terminal == "idle"
    assert result.messages == ["完成"]
