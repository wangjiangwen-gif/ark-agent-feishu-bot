from arkagent.store import ConversationKey, GatewayStore


def _key(user="ou-user"):
    return ConversationKey(tenant_key="tenant", chat_id="chat", thread_id="", user_open_id=user)


def _store():
    return GatewayStore(":memory:")


def test_conversation_key_includes_all_identity_fields():
    store = _store()
    key = ConversationKey(tenant_key="t", chat_id="c", thread_id="th", user_open_id="ou")
    assert store.conversation_key(key) == "t:c:th:ou"
    empty = ConversationKey(tenant_key="t", chat_id="c", thread_id="", user_open_id="")
    assert store.conversation_key(empty) == "t:c:-:-"


def test_session_roundtrip_and_reset():
    store = _store()
    key = _key()
    assert store.get_session(key) is None
    store.save_session(key, "sess-1", "agent-1", "v1")
    assert store.get_session(key) == "sess-1"
    store.reset_session(key)
    assert store.get_session(key) is None


def test_reset_all_sessions_returns_row_count():
    store = _store()
    store.save_session(_key("ou-a"), "s1", "agent-1")
    store.save_session(_key("ou-b"), "s2", "agent-1")
    assert store.reset_all_sessions() == 2


def test_claim_event_is_idempotent():
    store = _store()
    assert store.claim_event("evt-1") is True
    assert store.claim_event("evt-1") is False


def test_role_cache_upsert_and_injection_flags():
    store = _store()
    assert store.get_role("ou-1") is None
    row = store.upsert_role("ou-1", {"title": "销售经理"}, refreshed_at=1000)
    assert row.role == {"title": "销售经理"}
    assert row.injected_for_session is None

    store.mark_injected("ou-1", "sess-9")
    assert store.get_role("ou-1").injected_for_session == "sess-9"

    store.clear_injection("ou-1")
    assert store.get_role("ou-1").injected_for_session is None


def test_memory_store_mapping_roundtrip():
    store = _store()
    assert store.get_memory_store_id("ou-1") is None
    store.save_memory_store_id("ou-1", "mem-1")
    assert store.get_memory_store_id("ou-1") == "mem-1"
    store.save_memory_store_id("ou-1", "mem-2")
    assert store.get_memory_store_id("ou-1") == "mem-2"


def test_team_store_mapping_roundtrip():
    store = _store()
    store.save_team_store_id("销售", "team-1")
    assert store.get_team_store_id("销售") == "team-1"
