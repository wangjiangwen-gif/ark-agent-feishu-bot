"""火山方舟 Managed Agents 客户端（httpx 异步）。

移植自原 TS 项目 src/ark.ts，并新增本 demo 需要的能力：
  - create_session 支持 resources（挂载 Memory Store，卡点 D）
  - send_message 支持追加 system.message（动态系统提示词，卡点 C）
  - create_static_bearer_credential（卡点 A：静态 Bearer 鉴权 MCP）
  - create_memory_store / create_memory（卡点 D：每用户专属记忆）

SSE 解析、超时回查逻辑与原实现保持等价。
"""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import AsyncIterator, Awaitable, Callable, Optional
from urllib.parse import quote

import httpx

REQUEST_TIMEOUT = 30.0


@dataclass
class RunResult:
    terminal: str  # "idle" | "failed"
    messages: list[str] = field(default_factory=list)


class ArkError(RuntimeError):
    pass


def _now_ms() -> int:
    return int(time.time() * 1000)


def _unwrap(payload: dict) -> dict:
    data = payload.get("data")
    return data if isinstance(data, dict) else payload


def _response_id(payload: dict, resource: str) -> str:
    data = _unwrap(payload)
    ident = str(data.get("id") or "")
    if not ident:
        raise ArkError(f"创建 {resource} 成功，但响应中没有 ID")
    return ident


class ArkClient:
    def __init__(self, api_key: str, base_url: str, client: Optional[httpx.AsyncClient] = None):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=REQUEST_TIMEOUT)
        self._environment_configs: dict[str, dict] = {}

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self.api_key}"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        response = await self._client.request(
            method,
            f"{self.base_url}{path}",
            headers=headers,
            content=json.dumps(body) if body is not None else None,
            timeout=REQUEST_TIMEOUT,
        )
        if response.status_code >= 400:
            request_id = response.headers.get("x-request-id")
            suffix = f" ({request_id})" if request_id else ""
            raise ArkError(f"方舟请求失败 {response.status_code}{suffix}: {response.text[:300]}")
        if not response.content:
            return {}
        try:
            return response.json()
        except json.JSONDecodeError:
            return {}

    # ---- agents ----
    async def get_agent(self, agent_id: str) -> dict:
        payload = await self._request("GET", f"/agents/{quote(agent_id, safe='')}")
        data = _unwrap(payload)
        version = data.get("version")
        return {"id": str(data.get("id") or agent_id), "version": None if version is None else str(version)}

    async def list_agents(self) -> list[dict]:
        payload = await self._request("GET", "/agents?limit=100")
        return [
            {
                "id": str(item.get("id") or ""),
                "name": str(item.get("name") or item.get("id") or ""),
                "version": None if item.get("version") is None else str(item.get("version")),
            }
            for item in _items(payload)
            if item.get("id")
        ]

    async def create_agent(self, config: dict) -> dict:
        payload = await self._request("POST", "/agents", config)
        data = _unwrap(payload)
        ident = str(data.get("id") or data.get("agent_id") or "")
        if not ident:
            raise ArkError("创建 Agent 成功，但响应中没有 Agent ID")
        version = data.get("version")
        return {"id": ident, "name": str(data.get("name") or config.get("name", "")), "version": None if version is None else str(version)}

    # ---- environments ----
    async def list_environments(self) -> list[dict]:
        payload = await self._request("GET", "/environments?limit=100")
        return [
            {"id": str(item.get("id") or ""), "name": str(item.get("name") or item.get("id") or "")}
            for item in _items(payload)
            if item.get("id")
        ]

    async def create_environment(self, name: str, env: Optional[dict[str, str]] = None) -> dict:
        config = {"type": "cloud", "networking": {"type": "unrestricted"}}
        if env:
            config["env"] = env
        payload = await self._request("POST", "/environments", {"name": name, "config": config})
        data = _unwrap(payload)
        ident = str(data.get("id") or data.get("environment_id") or "")
        if not ident:
            raise ArkError("创建 Environment 成功，但响应中没有 Environment ID")
        return {"id": ident, "name": str(data.get("name") or name)}

    async def get_environment_config(self, environment_id: str) -> dict:
        cached = self._environment_configs.get(environment_id)
        if cached:
            return cached
        payload = await self._request("GET", f"/environments/{quote(environment_id, safe='')}")
        data = _unwrap(payload)
        config = data.get("config")
        if not isinstance(config, dict) or not isinstance(config.get("type"), str):
            raise ArkError("Environment 响应缺少有效 config")
        self._environment_configs[environment_id] = config
        return config

    # ---- vaults & credentials ----
    async def create_vault(self, display_name: str) -> str:
        payload = await self._request("POST", "/vaults", {"display_name": display_name})
        return _response_id(payload, "Vault")

    async def list_vaults(self) -> list[dict]:
        payload = await self._request("GET", "/vaults?limit=100")
        return [
            {"id": str(item.get("id") or ""), "display_name": str(item.get("display_name") or "")}
            for item in _items(payload)
            if item.get("id")
        ]

    async def list_credentials(self, vault_id: str) -> list[dict]:
        payload = await self._request("GET", f"/vaults/{quote(vault_id, safe='')}/credentials?limit=100")
        result = []
        for item in _items(payload):
            if not item.get("id"):
                continue
            auth = item.get("auth") or {}
            result.append(
                {
                    "id": str(item.get("id")),
                    "display_name": str(item.get("display_name") or ""),
                    "auth_type": str(auth.get("type") or ""),
                    "mcp_server_url": auth.get("mcp_server_url"),
                }
            )
        return result

    async def create_static_bearer_credential(self, vault_id: str, display_name: str, mcp_server_url: str, token: str) -> str:
        """卡点 A：为 MCP 创建静态 Bearer 凭据。创建时方舟会立即握手探测 MCP，不可达则 4xx。"""
        payload = await self._request(
            "POST",
            f"/vaults/{quote(vault_id, safe='')}/credentials",
            {
                "display_name": display_name,
                "auth": {"type": "static_bearer", "mcp_server_url": mcp_server_url, "token": token},
            },
        )
        return _response_id(payload, "Credential")

    # ---- memory stores (卡点 D) ----
    async def create_memory_store(self, name: str, description: str) -> str:
        payload = await self._request("POST", "/memory_stores", {"name": name, "description": description})
        return _response_id(payload, "Memory Store")

    async def create_memory(self, store_id: str, path: str, content: str) -> None:
        await self._request(
            "POST",
            f"/memory_stores/{quote(store_id, safe='')}/memories",
            {"path": path, "content": content},
        )

    # ---- sessions ----
    async def create_session(
        self,
        agent_id: str,
        environment_id: str,
        vault_ids: Optional[list[str]] = None,
        env_overrides: Optional[dict[str, str]] = None,
        resources: Optional[list[dict]] = None,
    ) -> str:
        """一次成型：卡点 B（env_overrides 注入 OpenID）+ A（vault_ids）+ D（resources 挂 Memory Store）。"""
        vault_ids = vault_ids or []
        env_overrides = env_overrides or {}
        resources = resources or []

        body: dict = {"agent": agent_id}
        if env_overrides:
            # 卡点 B：会话级环境变量透传（environment_with_overrides）。
            environment_config = await self.get_environment_config(environment_id)
            merged_env = {**(environment_config.get("env") or {}), **env_overrides}
            body["environment"] = {
                "id": environment_id,
                "type": "environment_with_overrides",
                "config": {**environment_config, "env": merged_env},
            }
        else:
            body["environment_id"] = environment_id
        if vault_ids:
            body["vault_ids"] = vault_ids
        if resources:
            body["resources"] = resources

        payload = await self._request("POST", "/sessions", body)
        data = _unwrap(payload)
        ident = str(data.get("id") or data.get("session_id") or "")
        if not ident:
            raise ArkError("创建 Session 成功，但响应中没有 Session ID")
        return ident

    async def send_message(self, session_id: str, text: str, system_message: Optional[str] = None) -> None:
        """发送 user.message；若给了 system_message，追加为数组最后一个元素（卡点 C 动态系统提示词）。"""
        events: list[dict] = [{"type": "user.message", "content": [{"type": "text", "text": text}]}]
        if system_message:
            events.append({"type": "system.message", "content": [{"type": "text", "text": system_message}]})
        await self._request(
            "POST",
            f"/sessions/{quote(session_id, safe='')}/events",
            {"events": events},
        )

    async def run(
        self,
        session_id: str,
        text: str,
        timeout_ms: int,
        on_progress: Optional[Callable[[str], Awaitable[None]]] = None,
        system_message: Optional[str] = None,
    ) -> RunResult:
        started_at = _now_ms()
        messages: list[str] = []
        seen: set[str] = set()
        try:
            # 先建流再发消息，避免秒回 Agent 在 SSE 订阅建立前就 message+idle。
            async def _drive() -> RunResult:
                async with self._open_event_stream(session_id) as stream:
                    await self.send_message(session_id, text, system_message=system_message)
                    async for event in stream:
                        eid = event.get("id")
                        if eid and eid in seen:
                            continue
                        if eid:
                            seen.add(eid)
                        if event.get("type") == "agent.message":
                            body = event_text(event)
                            if body:
                                messages.append(body)
                        progress = event_progress(event)
                        if progress and on_progress:
                            await on_progress(progress)
                        if event.get("type") in ("session.error", "session.status_failed"):
                            return RunResult(terminal="failed", messages=messages)
                        if event.get("type") == "session.status_idle":
                            return RunResult(terminal="idle", messages=messages)
                raise ArkError("事件流结束，但未观察到 Session 终态")

            return await asyncio.wait_for(_drive(), timeout=timeout_ms / 1000)
        except (asyncio.TimeoutError, httpx.ReadTimeout):
            recovered = await self._recover_timed_out_run(session_id, started_at)
            if recovered:
                return recovered
            raise ArkError("Session 运行超时")

    async def _recover_timed_out_run(self, session_id: str, started_at: int) -> Optional[RunResult]:
        for attempt in range(3):
            if attempt:
                await asyncio.sleep(5)
            payload = await self._request("GET", f"/sessions/{quote(session_id, safe='')}/events?limit=200")
            events = payload.get("data") if isinstance(payload.get("data"), list) else []
            result = result_from_events(events, started_at)
            if result:
                return result
        return None

    def _open_event_stream(self, session_id: str):
        return _EventStream(self, session_id)


class _EventStream:
    def __init__(self, client: ArkClient, session_id: str):
        self._client = client
        self._session_id = session_id
        self._ctx = None
        self._response: Optional[httpx.Response] = None

    async def __aenter__(self) -> AsyncIterator[dict]:
        url = f"{self._client.base_url}/sessions/{quote(self._session_id, safe='')}/events/stream"
        headers = {"Accept": "text/event-stream", "Authorization": f"Bearer {self._client.api_key}"}
        self._ctx = self._client._client.stream("GET", url, headers=headers, timeout=None)
        self._response = await self._ctx.__aenter__()
        if self._response.status_code >= 400:
            raise ArkError(f"方舟事件流失败 {self._response.status_code}")
        return self._iterate()

    async def __aexit__(self, *exc) -> None:
        if self._ctx is not None:
            await self._ctx.__aexit__(*exc)

    async def _iterate(self) -> AsyncIterator[dict]:
        buffer = ""
        async for chunk in self._response.aiter_text():
            buffer += chunk.replace("\r\n", "\n")
            events, buffer = drain_event_buffer(buffer)
            for event in events:
                yield event
        tail = buffer.strip()
        if tail:
            for event in parse_event_block(tail):
                yield event


# ---- SSE helpers（与原 TS 等价，模块级便于单测）----
def parse_event_block(block: str) -> list[dict]:
    lines = [line.strip() for line in block.split("\n")]
    lines = [line for line in lines if line and not line.startswith(":")]
    if not lines:
        return []
    data_lines = [line[5:].strip() for line in lines if line.startswith("data:")]
    if data_lines:
        return [json.loads("\n".join(data_lines))]
    return [json.loads(line) for line in lines]


def drain_event_buffer(input_text: str) -> tuple[list[dict], str]:
    normalized = input_text.replace("\r\n", "\n")
    events: list[dict] = []
    cursor = 0
    while True:
        boundary = normalized.find("\n\n", cursor)
        if boundary < 0:
            break
        events.extend(parse_event_block(normalized[cursor:boundary]))
        cursor = boundary + 2
    rest = normalized[cursor:]
    if "\n\n" not in normalized and "\n" in rest:
        parts = rest.split("\n")
        pending = parts.pop() if parts else ""
        for line in parts:
            events.extend(parse_event_block(line))
        return events, pending
    return events, rest


def event_progress(event: dict) -> Optional[str]:
    if event.get("type") == "agent.tool_result" and event.get("is_error") is True:
        return "工具执行未成功，Agent 正在尝试恢复"
    if event.get("type") != "agent.tool_use":
        return None
    name = event.get("name") if isinstance(event.get("name"), str) else "未知工具"
    payload_input = event.get("input") if isinstance(event.get("input"), dict) else {}
    description = payload_input.get("description")
    description = description.strip() if isinstance(description, str) else ""
    # 只展示 Agent 主动提供的简短描述，绝不转发 command、路径或完整工具参数。
    if description:
        return f"正在执行：{description[:120]}"
    return f"正在调用工具：{str(name)[:80]}"


def result_from_events(events: list[dict], started_at: int) -> Optional[RunResult]:
    def _after(event: dict) -> bool:
        stamp = event.get("processed_at")
        if not isinstance(stamp, str):
            return False
        parsed = _parse_iso_ms(stamp)
        return parsed is not None and parsed >= started_at

    current = [event for event in events if _after(event)]
    failed = any(event.get("type") in ("session.error", "session.status_failed") for event in current)
    idle = any(event.get("type") == "session.status_idle" for event in current)
    if not failed and not idle:
        return None
    messages = [event_text(event) for event in current if event.get("type") == "agent.message"]
    messages = [m for m in messages if m]
    return RunResult(terminal="failed" if failed else "idle", messages=messages)


def event_text(event: dict) -> str:
    content = event.get("content")
    if not isinstance(content, list):
        return ""
    return "\n".join(str(item.get("text") or "") for item in content if isinstance(item, dict) and item.get("type") == "text")


def _parse_iso_ms(value: str) -> Optional[int]:
    from datetime import datetime

    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return int(datetime.fromisoformat(text).timestamp() * 1000)
    except ValueError:
        return None


def _items(payload: dict) -> list[dict]:
    data = payload.get("data")
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return [item for item in data["items"] if isinstance(item, dict)]
    return []
