"""网关持久化（sqlite）：会话映射、事件去重、岗位缓存、Memory Store 映射。

移植自原 TS 项目 src/store.ts，并为卡点 C（role_cache）、D（memory_stores/team_stores）新增表。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class ConversationKey:
    tenant_key: str
    chat_id: str
    thread_id: str
    user_open_id: str


@dataclass(frozen=True)
class RoleRow:
    open_id: str
    role: dict
    refreshed_at: int
    injected_for_session: Optional[str]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())


class GatewayStore:
    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # sqlite 连接跨线程复用需要 check_same_thread=False + 自锁。
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        self._db.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS conversations (
                conversation_key TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                agent_version TEXT,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS processed_events (
                event_id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS role_cache (
                open_id TEXT PRIMARY KEY,
                role_json TEXT NOT NULL,
                refreshed_at INTEGER NOT NULL,
                injected_for_session TEXT
            );
            CREATE TABLE IF NOT EXISTS memory_stores (
                open_id TEXT PRIMARY KEY,
                store_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS team_stores (
                role TEXT PRIMARY KEY,
                store_id TEXT NOT NULL
            );
            """
        )
        self._db.commit()

    # ---- conversations ----
    def conversation_key(self, key: ConversationKey) -> str:
        return ":".join([key.tenant_key, key.chat_id, key.thread_id or "-", key.user_open_id or "-"])

    def get_session(self, key: ConversationKey) -> Optional[str]:
        with self._lock:
            row = self._db.execute(
                "SELECT session_id FROM conversations WHERE conversation_key = ?",
                (self.conversation_key(key),),
            ).fetchone()
        return row[0] if row else None

    def save_session(self, key: ConversationKey, session_id: str, agent_id: str, agent_version: Optional[str] = None) -> None:
        with self._lock:
            self._db.execute(
                """
                INSERT INTO conversations (conversation_key, session_id, agent_id, agent_version, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(conversation_key) DO UPDATE SET
                    session_id = excluded.session_id,
                    agent_id = excluded.agent_id,
                    agent_version = excluded.agent_version,
                    updated_at = excluded.updated_at
                """,
                (self.conversation_key(key), session_id, agent_id, agent_version, _now_iso()),
            )
            self._db.commit()

    def reset_session(self, key: ConversationKey) -> None:
        with self._lock:
            self._db.execute(
                "DELETE FROM conversations WHERE conversation_key = ?",
                (self.conversation_key(key),),
            )
            self._db.commit()

    def reset_all_sessions(self) -> int:
        with self._lock:
            cursor = self._db.execute("DELETE FROM conversations")
            self._db.commit()
            return cursor.rowcount

    # ---- event dedup ----
    def claim_event(self, event_id: str) -> bool:
        with self._lock:
            cursor = self._db.execute(
                "INSERT OR IGNORE INTO processed_events (event_id, status, updated_at) VALUES (?, 'processing', ?)",
                (event_id, _now_iso()),
            )
            self._db.commit()
            return cursor.rowcount == 1

    def complete_event(self, event_id: str, status: str) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE processed_events SET status = ?, updated_at = ? WHERE event_id = ?",
                (status, _now_iso(), event_id),
            )
            self._db.commit()

    # ---- role cache (卡点 C) ----
    def get_role(self, open_id: str) -> Optional[RoleRow]:
        with self._lock:
            row = self._db.execute(
                "SELECT open_id, role_json, refreshed_at, injected_for_session FROM role_cache WHERE open_id = ?",
                (open_id,),
            ).fetchone()
        if not row:
            return None
        return RoleRow(open_id=row[0], role=json.loads(row[1]), refreshed_at=int(row[2]), injected_for_session=row[3])

    def upsert_role(self, open_id: str, role: dict, refreshed_at: Optional[int] = None, injected_for_session: Optional[str] = None) -> RoleRow:
        stamp = _now_ms() if refreshed_at is None else refreshed_at
        with self._lock:
            self._db.execute(
                """
                INSERT INTO role_cache (open_id, role_json, refreshed_at, injected_for_session)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(open_id) DO UPDATE SET
                    role_json = excluded.role_json,
                    refreshed_at = excluded.refreshed_at,
                    injected_for_session = excluded.injected_for_session
                """,
                (open_id, json.dumps(role, ensure_ascii=False), stamp, injected_for_session),
            )
            self._db.commit()
        return RoleRow(open_id=open_id, role=role, refreshed_at=stamp, injected_for_session=injected_for_session)

    def mark_injected(self, open_id: str, session_id: str) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE role_cache SET injected_for_session = ? WHERE open_id = ?",
                (session_id, open_id),
            )
            self._db.commit()

    def clear_injection(self, open_id: str) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE role_cache SET injected_for_session = NULL WHERE open_id = ?",
                (open_id,),
            )
            self._db.commit()

    # ---- memory stores (卡点 D) ----
    def get_memory_store_id(self, open_id: str) -> Optional[str]:
        with self._lock:
            row = self._db.execute(
                "SELECT store_id FROM memory_stores WHERE open_id = ?",
                (open_id,),
            ).fetchone()
        return row[0] if row else None

    def save_memory_store_id(self, open_id: str, store_id: str) -> None:
        with self._lock:
            self._db.execute(
                """
                INSERT INTO memory_stores (open_id, store_id) VALUES (?, ?)
                ON CONFLICT(open_id) DO UPDATE SET store_id = excluded.store_id
                """,
                (open_id, store_id),
            )
            self._db.commit()

    def get_team_store_id(self, role: str) -> Optional[str]:
        with self._lock:
            row = self._db.execute(
                "SELECT store_id FROM team_stores WHERE role = ?",
                (role,),
            ).fetchone()
        return row[0] if row else None

    def save_team_store_id(self, role: str, store_id: str) -> None:
        with self._lock:
            self._db.execute(
                """
                INSERT INTO team_stores (role, store_id) VALUES (?, ?)
                ON CONFLICT(role) DO UPDATE SET store_id = excluded.store_id
                """,
                (role, store_id),
            )
            self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()
