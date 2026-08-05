import asyncio

import pytest

from arkagent.ark import RunResult
from arkagent.feishu import IncomingMessage
from arkagent.gateway import (
    Gateway,
    result_to_reply,
    should_handle_message,
    to_conversation_key,
)
from arkagent.memory import MemoryManager
from arkagent.role import RoleInfo, RoleManager
from arkagent.store import ConversationKey, GatewayStore


def message(**overrides) -> IncomingMessage:
    base = dict(
        event_id="event-1",
        message_id="message-1",
        chat_id="chat-1",
        chat_type="p2p",
        thread_id="",
        user_open_id="user-1",
        tenant_key="tenant-1",
        text="你好",
        mentioned_bot=False,
    )
    base.update(overrides)
    return IncomingMessage(**base)


class FakeArk:
    def __init__(self, run_result=None):
        self.creates = 0
        self.runs = 0
        self.last_env = None
        self.last_vaults = None
        self.last_resources = None
        self.last_system_message = "unset"
        self._run_result = run_result or RunResult(terminal="idle", messages=["回复"])

    async def create_session(self, agent_id, environment_id, vault_ids=None, env_overrides=None, resources=None):
        self.creates += 1
        self.last_env = env_overrides
        self.last_vaults = vault_ids
        self.last_resources = resources
        return f"session-{self.creates}"

    async def run(self, session_id, text, timeout_ms, on_progress=None, system_message=None):
        self.runs += 1
        self.last_system_message = system_message
        return self._run_result


# ---- pure helpers ----
def test_group_messages_require_mention():
    assert should_handle_message(message(chat_type="group", mentioned_bot=False)) is False
    assert should_handle_message(message(chat_type="group", mentioned_bot=True)) is True


def test_group_conversations_isolated_by_sender():
    store = GatewayStore(":memory:")
    a = to_conversation_key(message(chat_type="group", mentioned_bot=True, user_open_id="ou-1"))
    b = to_conversation_key(message(chat_type="group", mentioned_bot=True, user_open_id="ou-2"))
    assert store.conversation_key(a) != store.conversation_key(b)


def test_result_to_reply_requires_terminal_and_message():
    with pytest.raises(RuntimeError, match="没有产生回复"):
        result_to_reply(RunResult(terminal="idle", messages=[]))
    with pytest.raises(RuntimeError, match="执行失败"):
        result_to_reply(RunResult(terminal="failed", messages=["partial"]))
    assert result_to_reply(RunResult(terminal="idle", messages=["完成"])) == "完成"
    assert result_to_reply(RunResult(terminal="idle", messages=["先检查", "读取 Skill", "文档已创建"])) == "文档已创建"


def _gateway(store, ark, replies, **kwargs):
    async def reply(chat_id, text):
        replies.append(text)

    return Gateway(
        store,
        ark,
        reply,
        agent_id="agent-1",
        environment_id="env-1",
        vault_id="vlt-1",
        timeout_ms=5_000,
        **kwargs,
    )


# ---- behavior ----
async def test_gateway_dedupes_and_reuses_session():
    store = GatewayStore(":memory:")
    ark = FakeArk()
    replies: list[str] = []
    gw = _gateway(store, ark, replies)
    assert gw.accept(message()) is True
    assert gw.accept(message()) is False  # 同 event 去重
    gw.accept(message(event_id="event-2", message_id="message-2", text="再问"))
    await asyncio.sleep(0.05)
    assert ark.creates == 1
    assert ark.runs == 2
    assert replies == ["已收到，正在处理。首次启动可能需要几分钟。", "回复", "回复"]


async def test_gateway_binds_openid_via_env_overrides_and_vault():
    store = GatewayStore(":memory:")
    ark = FakeArk()
    replies: list[str] = []
    gw = _gateway(store, ark, replies)
    gw.accept(message(user_open_id="ou-current-user"))
    await asyncio.sleep(0.05)
    assert ark.last_vaults == ["vlt-1"]
    assert ark.last_env == {"FEISHU_USER_OPEN_ID": "ou-current-user"}


async def test_gateway_rejects_unauthorized_users_when_whitelist_set():
    store = GatewayStore(":memory:")
    ark = FakeArk()
    replies: list[str] = []
    gw = _gateway(store, ark, replies, authorized_open_ids=("user-1",))
    gw.accept(message(user_open_id="user-2"))
    await asyncio.sleep(0.05)
    assert "未授权" in replies[0]
    assert ark.creates == 0


async def test_gateway_allows_all_when_whitelist_empty():
    store = GatewayStore(":memory:")
    ark = FakeArk()
    replies: list[str] = []
    gw = _gateway(store, ark, replies)  # 无白名单
    gw.accept(message(user_open_id="anyone"))
    await asyncio.sleep(0.05)
    assert ark.creates == 1


async def test_new_command_resets_session_without_before_hook():
    store = GatewayStore(":memory:")
    key = ConversationKey(tenant_key="tenant-1", chat_id="chat-1", thread_id="", user_open_id="user-1")
    store.save_session(key, "session-old", "agent-1")
    ark = FakeArk()
    replies: list[str] = []
    attempts = {"n": 0}

    async def before():
        attempts["n"] += 1
        raise RuntimeError("expired")

    gw = _gateway(store, ark, replies, before_create_session=before)
    gw.accept(message(text="/new"))
    await asyncio.sleep(0.05)
    assert attempts["n"] == 0
    assert store.get_session(key) is None
    assert "已开启新会话" in replies[0]


async def test_reused_slow_session_gets_delayed_progress():
    store = GatewayStore(":memory:")
    key = ConversationKey(tenant_key="tenant-1", chat_id="chat-1", thread_id="", user_open_id="user-1")
    store.save_session(key, "session-1", "agent-1")
    replies: list[str] = []

    class SlowArk(FakeArk):
        async def run(self, session_id, text, timeout_ms, on_progress=None, system_message=None):
            await asyncio.sleep(0.03)
            return RunResult(terminal="idle", messages=["回复"])

    gw = _gateway(store, SlowArk(), replies, progress_delay_ms=5)
    gw.accept(message())
    await asyncio.sleep(0.1)
    assert replies == ["已收到，正在处理，请稍候。", "回复"]


# ---- 卡点 C: role injection ----
async def test_gateway_injects_role_system_message_once_per_session():
    store = GatewayStore(":memory:")
    ark = FakeArk()
    replies: list[str] = []
    role_mgr = RoleManager(store, lambda oid: RoleInfo(role="销售经理", store="门店A"), ttl_ms=86_400_000)
    gw = _gateway(store, ark, replies, role_manager=role_mgr)
    gw.accept(message())
    await asyncio.sleep(0.05)
    assert ark.last_system_message is not None and "销售经理" in ark.last_system_message
    # 同 session 第二轮不再注入
    gw.accept(message(event_id="e2", message_id="m2", text="再问"))
    await asyncio.sleep(0.05)
    assert ark.last_system_message is None


async def test_role_command_forces_reinjection():
    store = GatewayStore(":memory:")
    ark = FakeArk()
    replies: list[str] = []
    role_mgr = RoleManager(store, lambda oid: RoleInfo(role="销售顾问", store="门店A"), ttl_ms=86_400_000)
    gw = _gateway(store, ark, replies, role_manager=role_mgr)
    gw.accept(message())
    await asyncio.sleep(0.05)
    gw.accept(message(event_id="e2", message_id="m2"))
    await asyncio.sleep(0.05)
    assert ark.last_system_message is None  # 已注入

    gw.accept(message(event_id="e3", message_id="m3", text="/role 店长/门店B"))
    await asyncio.sleep(0.05)
    assert any("已更新岗位" in r for r in replies)

    gw.accept(message(event_id="e4", message_id="m4", text="继续"))
    await asyncio.sleep(0.05)
    assert ark.last_system_message is not None and "店长" in ark.last_system_message


# ---- 卡点 D: memory resources ----
async def test_gateway_mounts_memory_store_resources():
    store = GatewayStore(":memory:")
    ark = FakeArk()
    replies: list[str] = []
    role_mgr = RoleManager(store, lambda oid: RoleInfo(role="销售顾问", store="门店A"), ttl_ms=86_400_000)

    class MemArk:
        def __init__(self):
            self.count = 0

        async def create_memory_store(self, name, description):
            self.count += 1
            return f"memstore-{self.count}"

        async def create_memory(self, store_id, path, content):
            pass

    mem_mgr = MemoryManager(MemArk(), store)
    gw = _gateway(store, ark, replies, role_manager=role_mgr, memory_manager=mem_mgr)
    gw.accept(message())
    await asyncio.sleep(0.05)
    assert ark.last_resources is not None
    assert ark.last_resources[0]["type"] == "memory_store"
    assert ark.last_resources[0]["memory_store_id"] == "memstore-1"


async def test_whoami_reports_role():
    store = GatewayStore(":memory:")
    ark = FakeArk()
    replies: list[str] = []
    role_mgr = RoleManager(store, lambda oid: RoleInfo(role="销售经理", store="门店A"), ttl_ms=86_400_000)
    gw = _gateway(store, ark, replies, role_manager=role_mgr)
    gw.accept(message(text="/whoami"))
    await asyncio.sleep(0.05)
    assert "销售经理" in replies[0]
    assert ark.creates == 0


async def test_remember_command_writes_memory_without_session():
    store = GatewayStore(":memory:")
    ark = FakeArk()
    replies: list[str] = []
    role_mgr = RoleManager(store, lambda oid: RoleInfo(role="销售经理", store="门店A"), ttl_ms=86_400_000)

    class MemArk:
        def __init__(self):
            self.count = 0
            self.written: list[dict] = []

        async def create_memory_store(self, name, description):
            self.count += 1
            return f"memstore-{self.count}"

        async def create_memory(self, store_id, path, content):
            self.written.append({"store_id": store_id, "path": path, "content": content})

    mem_ark = MemArk()
    mem_mgr = MemoryManager(mem_ark, store)
    gw = _gateway(store, ark, replies, role_manager=role_mgr, memory_manager=mem_mgr)
    gw.accept(message(text="/remember 重点客户张先生，倾向 ET9"))
    await asyncio.sleep(0.05)
    # /remember 不创建 Agent Session，只写记忆
    assert ark.creates == 0
    notes = [w for w in mem_ark.written if w["path"].startswith("/notes/")]
    assert len(notes) == 1
    assert notes[0]["content"] == "重点客户张先生，倾向 ET9"
    assert "已记住" in replies[0]


async def test_remember_command_without_content_shows_usage():
    store = GatewayStore(":memory:")
    ark = FakeArk()
    replies: list[str] = []

    class MemArk:
        async def create_memory_store(self, name, description):
            raise AssertionError("空内容不应写记忆")

        async def create_memory(self, store_id, path, content):
            raise AssertionError("空内容不应写记忆")

    mem_mgr = MemoryManager(MemArk(), store)
    gw = _gateway(store, ark, replies, memory_manager=mem_mgr)
    gw.accept(message(text="/remember"))
    await asyncio.sleep(0.05)
    assert "用法" in replies[0]
    assert ark.creates == 0
