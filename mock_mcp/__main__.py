"""启动 mock NIO MCP Server。

    MCP_STATIC_BEARER=<token> MCP_HOST=0.0.0.0 MCP_PORT=8765 python -m mock_mcp
"""
from __future__ import annotations

import logging
import os

import uvicorn

from .server import build_app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    token = os.environ.get("MCP_STATIC_BEARER") or None
    host = os.environ.get("MCP_HOST", "127.0.0.1")
    port = int(os.environ.get("MCP_PORT", "8765"))
    if not token:
        print("[warn] 未设置 MCP_STATIC_BEARER，服务将不校验 Bearer（仅限本地调试）。")
    app = build_app(token=token)
    print(f"mock NIO MCP 监听 http://{host}:{port}/mcp")
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
