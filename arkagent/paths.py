"""状态目录解析：~/.arkagent/{config.env, gateway.db}，可用 ARKAGENT_HOME 覆盖。

移植自原 TS 项目 src/paths.ts，语义保持一致。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional


@dataclass(frozen=True)
class ArkagentPaths:
    state_dir: str
    config_path: str
    database_path: str


def get_arkagent_paths(env: Optional[Mapping[str, str]] = None) -> ArkagentPaths:
    environ = os.environ if env is None else env
    override = environ.get("ARKAGENT_HOME")
    state_dir = Path(override).resolve() if override else (Path.home() / ".arkagent").resolve()
    return ArkagentPaths(
        state_dir=str(state_dir),
        config_path=str(state_dir / "config.env"),
        database_path=str(state_dir / "gateway.db"),
    )
