import pytest

from arkagent.memory import MemoryManager
from arkagent.role import RoleInfo
from arkagent.store import GatewayStore


class FakeArk:
    def __init__(self):
        self.stores = []
        self.memories = []
        self._counter = 0

    async def create_memory_store(self, name, description):
        self._counter += 1
        store_id = f"memstore-{self._counter}"
        self.stores.append({"id": store_id, "name": name, "description": description})
        return store_id

    async def create_memory(self, store_id, path, content):
        self.memories.append({"store_id": store_id, "path": path, "content": content})


@pytest.fixture
def deps():
    return FakeArk(), GatewayStore(":memory:")


async def test_ensure_user_store_creates_once_and_preloads_profile(deps):
    ark, store = deps
    mgr = MemoryManager(ark, store)
    role = RoleInfo(role="销售顾问", store="门店A")
    sid = await mgr.ensure_user_store("ou-1", role)
    assert sid == "memstore-1"
    assert ark.stores[0]["name"] == "user-ou-1-longterm"
    assert ark.memories[0]["path"] == "/profile/basic.md"
    # 第二次直接命中，不再创建
    sid2 = await mgr.ensure_user_store("ou-1", role)
    assert sid2 == "memstore-1"
    assert len(ark.stores) == 1


async def test_build_session_resources_user_only_by_default(deps):
    ark, store = deps
    mgr = MemoryManager(ark, store, team_store_enabled=False)
    resources = await mgr.build_session_resources("ou-1", RoleInfo(role="销售顾问", store="门店A"))
    assert len(resources) == 1
    assert resources[0]["type"] == "memory_store"
    assert resources[0]["memory_store_id"] == "memstore-1"


async def test_build_session_resources_adds_team_store_when_enabled(deps):
    ark, store = deps
    mgr = MemoryManager(ark, store, team_store_enabled=True)
    role = RoleInfo(role="销售经理", store="门店A")
    resources = await mgr.build_session_resources("ou-1", role)
    assert len(resources) == 2
    ids = [r["memory_store_id"] for r in resources]
    assert "memstore-1" in ids and "memstore-2" in ids
    # 同岗位第二个用户复用团队 Store
    resources2 = await mgr.build_session_resources("ou-2", role)
    team_ids = {store.get_team_store_id("销售经理")}
    assert resources2[1]["memory_store_id"] in team_ids


async def test_role_change_reuses_same_user_store(deps):
    ark, store = deps
    mgr = MemoryManager(ark, store)
    sid1 = await mgr.ensure_user_store("ou-1", RoleInfo(role="销售顾问", store="门店A"))
    # 岗位调动后开新 Session 仍复用同一 Store
    sid2 = await mgr.ensure_user_store("ou-1", RoleInfo(role="销售经理", store="门店B"))
    assert sid1 == sid2
    assert len(ark.stores) == 1


async def test_remember_writes_note_into_user_store(deps):
    ark, store = deps
    mgr = MemoryManager(ark, store)
    path = await mgr.remember("ou-1", "重点客户张先生，倾向 ET9", RoleInfo(role="销售经理", store="门店A"))
    # 写入的是一条 note（非 /profile/basic.md 预置画像）
    assert path.startswith("/notes/")
    notes = [m for m in ark.memories if m["path"].startswith("/notes/")]
    assert len(notes) == 1
    assert notes[0]["content"] == "重点客户张先生，倾向 ET9"
    assert notes[0]["store_id"] == "memstore-1"


async def test_remember_reuses_existing_store(deps):
    ark, store = deps
    mgr = MemoryManager(ark, store)
    await mgr.ensure_user_store("ou-1", RoleInfo(role="销售经理", store="门店A"))
    await mgr.remember("ou-1", "笔记一")
    # 复用既有 Store，不再新建
    assert len(ark.stores) == 1
