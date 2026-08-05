"""网关编排：飞书消息 → 方舟 Session。

移植自原 TS 项目 src/gateway.ts，用 asyncio 重写串行队列，并接入：
  - 卡点 B：创建 Session 时用 env_overrides 透传 FEISHU_USER_OPEN_ID。
  - 卡点 C：RoleManager 判是否挂 system.message（动态岗位注入）。
  - 卡点 D：MemoryManager 组装 resources（挂用户专属 Memory Store）。

聊天指令：/new 开新会话、/role <描述> 模拟岗位调动、/whoami 查看当前岗位。
WS 回调（可能来自其它线程）只做去重与入队，满足飞书 3 秒处理约束。
"""
from __future__ import annotations

import asyncio
import contextlib
from typing import Awaitable, Callable, Optional

from .ark import ArkClient, RunResult
from .feishu import IncomingMessage
from .memory import MemoryManager
from .role import RoleInfo, RoleManager
from .store import ConversationKey, GatewayStore

Reply = Callable[[str, str], Awaitable[None]]
DEFAULT_PROGRESS_DELAY_MS = 2_500


class KeyedQueue:
    """按 key 串行化协程：同一会话的消息按到达顺序依次处理，不同会话并行。

    所有方法都必须在事件循环线程内调用（由 Gateway 保证）。
    """

    def __init__(self) -> None:
        self._tails: dict[str, asyncio.Task] = {}

    def enqueue(self, key: str, task_factory: Callable[[], Awaitable[None]]) -> None:
        previous = self._tails.get(key)

        async def runner() -> None:
            if previous is not None:
                with contextlib.suppress(Exception):
                    await previous
            await task_factory()

        current = asyncio.get_event_loop().create_task(runner())
        self._tails[key] = current

        def _cleanup(done: asyncio.Task, k: str = key) -> None:
            if self._tails.get(k) is done:
                del self._tails[k]

        current.add_done_callback(_cleanup)


class Gateway:
    def __init__(
        self,
        store: GatewayStore,
        ark: ArkClient,
        reply: Reply,
        *,
        agent_id: str,
        environment_id: str,
        vault_id: str,
        timeout_ms: int,
        authorized_open_ids: tuple[str, ...] = (),
        progress_delay_ms: int = DEFAULT_PROGRESS_DELAY_MS,
        role_manager: Optional[RoleManager] = None,
        memory_manager: Optional[MemoryManager] = None,
        before_create_session: Optional[Callable[[], Awaitable[None]]] = None,
        loop: Optional[asyncio.AbstractEventLoop] = None,
    ) -> None:
        self._store = store
        self._ark = ark
        self._reply = reply
        self._agent_id = agent_id
        self._environment_id = environment_id
        self._vault_id = vault_id
        self._timeout_ms = timeout_ms
        self._authorized_open_ids = set(authorized_open_ids)
        self._progress_delay_ms = progress_delay_ms
        self._role = role_manager
        self._memory = memory_manager
        self._before_create_session = before_create_session
        self._loop = loop
        self._queue = KeyedQueue()

    def accept(self, message: IncomingMessage) -> bool:
        """同步入口（可能被 WS 线程调用）：去重后把处理协程调度到事件循环。"""
        if not should_handle_message(message):
            return False
        if not self._store.claim_event(message.event_id):
            return False
        key = to_conversation_key(message)
        conv_key = self._store.conversation_key(key)

        def _do_enqueue() -> None:
            self._queue.enqueue(conv_key, lambda: self._run_task(message, key))

        running = None
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        target = self._loop or running
        if target is None:
            raise RuntimeError("Gateway.accept 需要一个运行中的事件循环")
        if running is target:
            _do_enqueue()
        else:
            target.call_soon_threadsafe(_do_enqueue)
        return True

    async def _run_task(self, message: IncomingMessage, key: ConversationKey) -> None:
        try:
            await self._process(message, key)
            self._store.complete_event(message.event_id, "completed")
        except Exception as error:  # noqa: BLE001 - 网关兜底，任何失败都要回执给用户
            self._store.complete_event(message.event_id, "failed")
            reason = str(error)
            await self._reply(message.chat_id, f"执行失败：{reason[:240]}")

    async def _process(self, message: IncomingMessage, key: ConversationKey) -> None:
        if self._authorized_open_ids and message.user_open_id not in self._authorized_open_ids:
            await self._reply(
                message.chat_id,
                "当前用户未授权。请联系管理员把你的 open_id 加入白名单。",
            )
            return

        text = message.text.strip()
        if text == "/new":
            # 卡点 D：岗位调动开新 Session（下一条消息会挂同一 Memory Store）。
            self._store.reset_session(key)
            await self._reply(message.chat_id, "已开启新会话，下一条消息会创建新的 Agent Session（记忆延续）。")
            return
        if text == "/whoami":
            await self._reply(message.chat_id, self._describe_role(message.user_open_id))
            return
        if text.startswith("/role"):
            await self._handle_role_command(message, text)
            return

        if self._before_create_session:
            await self._before_create_session()

        session_id = self._store.get_session(key)
        progress_task: Optional[asyncio.Task] = None
        if not session_id:
            await self._reply(message.chat_id, "已收到，正在处理。首次启动可能需要几分钟。")
            session_id = await self._create_session(message)
            self._store.save_session(key, session_id, self._agent_id)
        else:
            progress_task = asyncio.get_event_loop().create_task(self._delayed_progress(message.chat_id))

        # 卡点 C：仅在本 session 尚未注入过岗位时挂 system.message。
        system_message = None
        if self._role:
            system_message = self._role.system_message_for(message.user_open_id, session_id)

        try:
            # 不传 on_progress：避免把 tool_use/tool_result 转成进度消息刷屏。
            result = await self._ark.run(session_id, message.text, self._timeout_ms, system_message=system_message)
        finally:
            if progress_task is not None:
                progress_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await progress_task
        await self._reply(message.chat_id, result_to_reply(result))

    async def _create_session(self, message: IncomingMessage) -> str:
        resources: list[dict] = []
        role_info: Optional[RoleInfo] = None
        if self._role:
            role_info = RoleInfo.from_dict(self._role.ensure_fresh_role(message.user_open_id))
        if self._memory:
            resources = await self._memory.build_session_resources(message.user_open_id, role_info)
        return await self._ark.create_session(
            self._agent_id,
            self._environment_id,
            vault_ids=[self._vault_id] if self._vault_id else [],
            env_overrides={"FEISHU_USER_OPEN_ID": message.user_open_id},  # 卡点 B
            resources=resources,  # 卡点 D
        )

    async def _handle_role_command(self, message: IncomingMessage, text: str) -> None:
        if not self._role:
            await self._reply(message.chat_id, "当前未启用岗位注入功能。")
            return
        desc = text[len("/role"):].strip()
        if not desc:
            await self._reply(message.chat_id, "用法：/role 新岗位名称[/门店]，例如 /role 销售经理/上海浦东蔚来中心")
            return
        role_part, _, store_part = desc.partition("/")
        new_role = RoleInfo(role=role_part.strip(), store=store_part.strip() or "未知门店")
        self._role.on_role_change(message.user_open_id, new_role)
        await self._reply(
            message.chat_id,
            f"已更新岗位为「{new_role.role}」，下一轮对话会自动向 Agent 声明新岗位（无需新建 Session）。",
        )

    def _describe_role(self, open_id: str) -> str:
        if not self._role:
            return "当前未启用岗位注入功能。"
        role = self._role.ensure_fresh_role(open_id)
        return f"当前岗位：{role.get('role')}（{role.get('store')}）"

    async def _delayed_progress(self, chat_id: str) -> None:
        await asyncio.sleep(self._progress_delay_ms / 1000)
        await self._reply(chat_id, "已收到，正在处理，请稍候。")


def should_handle_message(message: IncomingMessage) -> bool:
    if not message.text.strip():
        return False
    return message.chat_type == "p2p" or message.mentioned_bot


def to_conversation_key(message: IncomingMessage) -> ConversationKey:
    return ConversationKey(
        tenant_key=message.tenant_key,
        chat_id=message.chat_id,
        thread_id=message.thread_id,
        user_open_id=message.user_open_id,
    )


def result_to_reply(result: RunResult) -> str:
    if result.terminal == "failed":
        raise RuntimeError("Agent Session 执行失败")
    if not result.messages:
        raise RuntimeError("Agent Session 已结束，但没有产生回复")
    # 一个 run 可能产生多条 agent.message：前面通常是“让我先检查…”类播报，最后一条才是完整结果。
    return result.messages[-1]
