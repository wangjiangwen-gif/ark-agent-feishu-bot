"""轻量计时打点工具。

用于在关键链路上测量各段耗时，输出统一的 [timing] 结构化日志，帮助定位
"Bot 回复慢在哪一段"。所有耗时用 time.perf_counter 计算，单位毫秒。

用法：

    from .timing import time_block, timing_logger

    with time_block("gateway.create_session", user=open_id):
        session_id = await self._ark.create_session(...)

日志形如：
    [timing] gateway.create_session=1234.5ms user=ou-xxx

日志走标准 logging（logger 名 "arkagent.timing"，级别 INFO）；需要在入口
（如 arkagent run）配置 logging.basicConfig 才会输出到终端。
"""
from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import Iterator

timing_logger = logging.getLogger("arkagent.timing")


def _format_fields(fields: dict[str, object]) -> str:
    if not fields:
        return ""
    return " " + " ".join(f"{k}={v}" for k, v in fields.items() if v is not None)


@contextmanager
def time_block(label: str, **fields: object) -> Iterator[None]:
    """测量代码块耗时并打一条 [timing] 日志。

    label   段名，如 "gateway.run"、"ark.create_session.post"。
    fields  附加上下文（user、session、first 等），会拼进日志行。
    即使块内抛异常也会记一条带 error 标记的耗时，便于分析失败路径的耗时。
    """
    start = time.perf_counter()
    error: str | None = None
    try:
        yield
    except BaseException as exc:  # noqa: BLE001 - 记录后原样抛出，不吞异常
        error = type(exc).__name__
        raise
    finally:
        elapsed_ms = (time.perf_counter() - start) * 1000
        extra = dict(fields)
        if error:
            extra["error"] = error
        timing_logger.info("[timing] %s=%.1fms%s", label, elapsed_ms, _format_fields(extra))


class Stopwatch:
    """手动分段计时器，用于无法用单个 with 包裹、需要多次 lap 的场景（如 SSE 首字节 vs 总耗时）。"""

    def __init__(self) -> None:
        self._start = time.perf_counter()
        self._last = self._start

    def lap_ms(self) -> float:
        """返回距上次 lap（或创建）以来的毫秒数，并重置分段起点。"""
        now = time.perf_counter()
        delta = (now - self._last) * 1000
        self._last = now
        return delta

    def total_ms(self) -> float:
        """返回距创建以来的总毫秒数。"""
        return (time.perf_counter() - self._start) * 1000

    def mark(self, label: str, **fields: object) -> None:
        """打一条自创建以来总耗时的 [timing] 日志（不重置）。"""
        timing_logger.info("[timing] %s=%.1fms%s", label, self.total_ms(), _format_fields(fields))
