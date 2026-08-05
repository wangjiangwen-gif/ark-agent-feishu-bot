"""Node 小岛的 Python 封装：以子进程运行 register_app.mjs 扫码建飞书应用。

registerApp 无 Python 等价物，故保留 Node 脚本。这里负责：
  - 定位 node-helper 目录与 node 可执行文件；
  - 以子进程运行，stderr（二维码/提示）直连终端；
  - 从临时 JSON 文件读回 {appId, appSecret, userOpenId}。
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

NODE_HELPER_DIR = Path(__file__).resolve().parent.parent / "node-helper"


@dataclass(frozen=True)
class FeishuAppCredentials:
    app_id: str
    app_secret: str
    user_open_id: Optional[str] = None


def register_feishu_app(node_bin: str = "node", helper_dir: Optional[Path] = None) -> FeishuAppCredentials:
    helper_dir = helper_dir or NODE_HELPER_DIR
    script = helper_dir / "register_app.mjs"
    if not script.exists():
        raise RuntimeError(f"找不到 registerApp 脚本：{script}")
    if not (helper_dir / "node_modules").exists():
        raise RuntimeError(f"Node 依赖未安装，请先在 {helper_dir} 运行 npm install")

    with tempfile.TemporaryDirectory() as tmp:
        out_path = os.path.join(tmp, "app.json")
        # stderr 继承终端（二维码/提示直接展示），stdout 不使用。
        completed = subprocess.run(
            [node_bin, str(script), out_path],
            cwd=str(helper_dir),
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"registerApp 失败（exit={completed.returncode}）")
        with open(out_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    return parse_credentials(data)


def parse_credentials(data: dict) -> FeishuAppCredentials:
    app_id = str(data.get("appId") or "")
    app_secret = str(data.get("appSecret") or "")
    if not app_id or not app_secret:
        raise RuntimeError("registerApp 返回缺少 appId/appSecret")
    user_open_id = data.get("userOpenId") or None
    return FeishuAppCredentials(app_id=app_id, app_secret=app_secret, user_open_id=user_open_id)
