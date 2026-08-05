"""卡点 C · 动态岗位信息注入。

策略（对应 FDE 清单 C-1 + C-2）：
  - RoleCache：(open_id, roleInfo, refreshedAt, injectedForSession)，24h TTL。
  - 收消息前判 TTL → 过期就拉 HR → 更新缓存（injectedForSession 置空）。
  - 只在「本 session 尚未注入过」时挂一个 system.message（避免每轮累积重复岗位声明）。
  - 岗位变动：on_role_change 更新缓存并清空 injectedForSession，下一轮强制重新注入。

HR 系统在本 demo 中用可替换的 RoleProvider 抽象；默认给一个 mock 实现。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable, Optional

from .store import GatewayStore

ROLE_INSTRUCTION = (
    "在权限判定、数据过滤、话术风格上严格以最近一次岗位声明为准；"
    "若后续再次收到新的岗位声明，以最近一次为准。"
)


@dataclass(frozen=True)
class RoleInfo:
    role: str
    store: str
    permissions: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {"role": self.role, "store": self.store, "permissions": list(self.permissions)}

    @classmethod
    def from_dict(cls, data: dict) -> "RoleInfo":
        return cls(
            role=str(data.get("role", "")),
            store=str(data.get("store", "")),
            permissions=tuple(data.get("permissions") or ()),
        )


# HR 系统契约：给 open_id 返回岗位信息。
RoleProvider = Callable[[str], RoleInfo]


def build_role_system_message(role: dict) -> str:
    """把岗位 JSON 拼成 system.message 文本。"""
    return f"【当前用户岗位信息】{json.dumps(role, ensure_ascii=False)}\n{ROLE_INSTRUCTION}"


class RoleManager:
    def __init__(
        self,
        store: GatewayStore,
        provider: RoleProvider,
        ttl_ms: int,
        now_ms: Callable[[], int] = None,
    ):
        self._store = store
        self._provider = provider
        self._ttl_ms = ttl_ms
        import time

        self._now_ms = now_ms or (lambda: int(time.time() * 1000))

    def ensure_fresh_role(self, open_id: str) -> dict:
        """判 TTL；过期或未命中就拉 HR 刷新缓存（刷新会清空 injectedForSession）。返回岗位 dict。"""
        cached = self._store.get_role(open_id)
        stale = cached is None or (self._now_ms() - cached.refreshed_at > self._ttl_ms)
        if stale:
            fresh = self._provider(open_id)
            row = self._store.upsert_role(open_id, fresh.to_dict(), refreshed_at=self._now_ms(), injected_for_session=None)
            return row.role
        return cached.role

    def system_message_for(self, open_id: str, session_id: str) -> Optional[str]:
        """若本 session 尚未注入过岗位，返回 system.message 文本并标记；否则返回 None。"""
        role = self.ensure_fresh_role(open_id)
        row = self._store.get_role(open_id)
        if row is not None and row.injected_for_session == session_id:
            return None
        self._store.mark_injected(open_id, session_id)
        return build_role_system_message(role)

    def on_role_change(self, open_id: str, new_role: RoleInfo) -> None:
        """岗位变动：更新缓存并清空 injectedForSession，强制下一轮重新注入（Session/Agent 不动）。"""
        self._store.upsert_role(open_id, new_role.to_dict(), refreshed_at=self._now_ms(), injected_for_session=None)


def mock_hr_provider(open_id: str) -> RoleInfo:
    """演示用 HR：按 open_id 后缀返回不同岗位，其余默认销售顾问。"""
    table = {
        "manager": RoleInfo(role="销售经理", store="上海浦东蔚来中心", permissions=("view_team_pipeline", "approve_discount")),
        "sales": RoleInfo(role="销售顾问", store="上海浦东蔚来中心", permissions=("view_own_leads",)),
    }
    for key, info in table.items():
        if open_id.endswith(key):
            return info
    return RoleInfo(role="销售顾问", store="上海浦东蔚来中心", permissions=("view_own_leads",))
