from arkagent.role import RoleInfo, RoleManager, build_role_system_message, mock_hr_provider
from arkagent.store import GatewayStore


class Clock:
    def __init__(self):
        self.now = 1_000_000

    def __call__(self):
        return self.now


def _manager(ttl_ms=86_400_000, provider=None, clock=None):
    store = GatewayStore(":memory:")
    clock = clock or Clock()
    provider = provider or (lambda oid: RoleInfo(role="销售顾问", store="门店A", permissions=("view_own_leads",)))
    return RoleManager(store, provider, ttl_ms=ttl_ms, now_ms=clock), store, clock


def test_ensure_fresh_role_fetches_on_miss_and_caches():
    calls = []

    def provider(oid):
        calls.append(oid)
        return RoleInfo(role="销售经理", store="门店B")

    mgr, _, _ = _manager(provider=provider)
    role = mgr.ensure_fresh_role("ou-1")
    assert role["role"] == "销售经理"
    mgr.ensure_fresh_role("ou-1")
    assert calls == ["ou-1"]  # 第二次命中缓存，不再拉 HR


def test_ensure_fresh_role_refetches_after_ttl():
    calls = []

    def provider(oid):
        calls.append(oid)
        return RoleInfo(role="销售顾问", store="门店A")

    clock = Clock()
    mgr, _, _ = _manager(ttl_ms=1000, provider=provider, clock=clock)
    mgr.ensure_fresh_role("ou-1")
    clock.now += 2000  # 超过 TTL
    mgr.ensure_fresh_role("ou-1")
    assert len(calls) == 2


def test_system_message_only_injected_once_per_session():
    mgr, _, _ = _manager()
    first = mgr.system_message_for("ou-1", "sess-1")
    assert first is not None and "岗位信息" in first
    # 同 session 再次询问不再注入，避免累积
    assert mgr.system_message_for("ou-1", "sess-1") is None
    # 新 session 需要重新注入
    assert mgr.system_message_for("ou-1", "sess-2") is not None


def test_on_role_change_forces_reinjection():
    mgr, store, _ = _manager()
    mgr.system_message_for("ou-1", "sess-1")
    assert mgr.system_message_for("ou-1", "sess-1") is None

    mgr.on_role_change("ou-1", RoleInfo(role="店长", store="门店C"))
    reinjected = mgr.system_message_for("ou-1", "sess-1")
    assert reinjected is not None and "店长" in reinjected


def test_build_role_system_message_contains_json_and_rule():
    text = build_role_system_message({"role": "销售经理"})
    assert "销售经理" in text
    assert "最近一次" in text


def test_mock_hr_provider_maps_suffix():
    assert mock_hr_provider("ou-abc-manager").role == "销售经理"
    assert mock_hr_provider("ou-abc-sales").role == "销售顾问"
    assert mock_hr_provider("ou-random").role == "销售顾问"
