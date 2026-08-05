"""卡点 D · 跨 Session 记忆延续（Memory Store）。

策略（对应 FDE 清单 D-1/D-2/D-3）：
  - 每 open_id 一个专属 Memory Store（name 含 open_id 便于运维反查）；首次创建时预置画像。
  - 创建 Session 时通过 resources 挂载该 Store（Memory Store 只能创建时挂载）。
  - 岗位调动：不新建 Store，只开新 Session 挂同一 Store，老对话摘要天然带入。
  - 可选（TEAM_STORE_ENABLED）：同岗位额外挂一个团队共享 Store（D-3）。

写入链路（客户侧适配）：方舟不自动抽取对话、Agent 对 /mnt/memory 只读，写记忆只能由应用侧
调 API（POST /memory_stores/{id}/memories）。本 demo 用 /remember 显式指令触发 remember()，
把用户指定内容写成一条 note；下个 Session 挂载同一 Store 即可读到，实现跨会话记忆。
"""
from __future__ import annotations

import time
from typing import Optional

from .ark import ArkClient
from .role import RoleInfo
from .store import GatewayStore

USER_STORE_INSTRUCTIONS = "开始任务前先读取 /mnt/memory/ 下的用户画像与历史跟进笔记，据此个性化回答。"
TEAM_STORE_INSTRUCTIONS = "同时参考团队共享 SOP 与话术规范。"
NOTES_DIR = "/notes"


class MemoryManager:
    def __init__(self, ark: ArkClient, store: GatewayStore, team_store_enabled: bool = False):
        self._ark = ark
        self._store = store
        self._team_store_enabled = team_store_enabled

    async def ensure_user_store(self, open_id: str, role: Optional[RoleInfo] = None) -> str:
        """返回该用户专属 Memory Store id；不存在则创建并预置画像。"""
        existing = self._store.get_memory_store_id(open_id)
        if existing:
            return existing
        store_id = await self._ark.create_memory_store(
            name=f"user-{open_id}-longterm",
            description=(
                f"Long-term memory for user {open_id}: past customer follow-ups, "
                "personal preferences, learned SOPs. Agent should read at task start."
            ),
        )
        if role is not None:
            await self._ark.create_memory(
                store_id,
                "/profile/basic.md",
                f"# 用户画像\n- 岗位: {role.role}\n- 门店: {role.store}\n",
            )
        self._store.save_memory_store_id(open_id, store_id)
        return store_id

    async def remember(self, open_id: str, note: str, role: Optional[RoleInfo] = None) -> str:
        """把用户显式指定的内容写成一条 note 存入其专属 Store（/remember 触发）。

        方舟不自动抽取记忆、Agent 对 /mnt/memory 只读，故写入必须由应用侧调 API 完成。
        每条 note 用时间戳命名，避免同路径不覆盖（create 语义：路径已存在则不覆盖）。
        返回写入的 memory 路径，便于回执与运维反查。
        """
        store_id = await self.ensure_user_store(open_id, role)
        path = f"{NOTES_DIR}/{time.strftime('%Y%m%d-%H%M%S', time.localtime())}.md"
        await self._ark.create_memory(store_id, path, note)
        return path

    async def ensure_team_store(self, role_name: str) -> str:
        """返回同岗位团队共享 Store id（D-3）；不存在则创建。"""
        existing = self._store.get_team_store_id(role_name)
        if existing:
            return existing
        store_id = await self._ark.create_memory_store(
            name=f"team-{role_name}-shared",
            description=f"Shared SOP and playbook for role {role_name}.",
        )
        self._store.save_team_store_id(role_name, store_id)
        return store_id

    async def build_session_resources(self, open_id: str, role: Optional[RoleInfo] = None) -> list[dict]:
        """组装创建 Session 时的 resources 数组（用户 Store + 可选团队 Store）。"""
        resources: list[dict] = []
        user_store_id = await self.ensure_user_store(open_id, role)
        resources.append(
            {"type": "memory_store", "memory_store_id": user_store_id, "instructions": USER_STORE_INSTRUCTIONS}
        )
        if self._team_store_enabled and role is not None:
            team_store_id = await self.ensure_team_store(role.role)
            resources.append(
                {"type": "memory_store", "memory_store_id": team_store_id, "instructions": TEAM_STORE_INSTRUCTIONS}
            )
        return resources
