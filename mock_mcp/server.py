"""mock NIO MCP Server（FastMCP streamable-http）。

演示两个卡点的服务端配合：
  - 卡点 A：入站请求必须带 static Bearer token（Authorization: Bearer <token>），否则 401。
           方舟创建 static_bearer 凭据时会握手探测，故本服务须公网可达。
  - 卡点 B：工具以 open_id 为入参，按用户返回专属数据；open_id 不在白名单则拒绝。
           （open_id 由方舟会话级环境变量 FEISHU_USER_OPEN_ID 透传给 Agent，Agent 再传入工具。）

用法：
    MCP_STATIC_BEARER=xxx python -m mock_mcp            # 启动服务
    build_app(token) / build_server()                   # 供测试与嵌入
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import data

MCP_PATH = "/mcp"

logger = logging.getLogger("mock_mcp")


def mask_token(token: str) -> str:
    """掩码展示 token：只露头尾各 4 位，中间用 … 代替，避免日志泄露完整密钥。"""
    if not token:
        return "<空>"
    if len(token) <= 8:
        return token[0] + "…" + token[-1] if len(token) > 1 else "…"
    return f"{token[:4]}…{token[-4:]}"


def build_server() -> FastMCP:
    """构造带工具的 FastMCP 实例（无鉴权，鉴权在外层中间件做）。"""
    # FastMCP 默认开启 DNS rebinding 保护，只放行 127.0.0.1/localhost 的 Host，
    # 经内网穿透（ngrok/cpolar）访问时外部域名会被判非法 Host → 421 Misdirected Request。
    # 本 mock 本就设计为被方舟经公网探测/调用，故关闭该保护（demo 场景）。
    server = FastMCP(
        name="nio-mock-mcp",
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )

    @server.tool(description="查询指定用户（open_id）的销售线索与业绩看板；只能查自己有权限的数据。")
    def get_my_sales_data(open_id: str) -> str:
        if not data.is_authorized(open_id):
            return json.dumps({"error": "unauthorized", "message": f"open_id {open_id} 不在白名单，无权访问"}, ensure_ascii=False)
        return json.dumps(data.get_user_bucket(open_id), ensure_ascii=False)

    @server.tool(description="查询蔚来车型的定位、续航与卖点，用于话术与客户答疑。")
    def get_vehicle_info(model: str) -> str:
        info = data.VEHICLE_CATALOG.get(model.upper())
        if not info:
            return json.dumps({"error": "not_found", "message": f"未找到车型 {model}", "available": list(data.VEHICLE_CATALOG)}, ensure_ascii=False)
        return json.dumps({"model": model.upper(), **info}, ensure_ascii=False)

    return server


class StaticBearerMiddleware(BaseHTTPMiddleware):
    """卡点 A：校验 Authorization: Bearer <token>。token 为空表示不鉴权（仅本地调试）。"""

    def __init__(self, app, token: Optional[str]):
        super().__init__(app)
        self._token = token

    async def dispatch(self, request: Request, call_next):
        header = request.headers.get("authorization", "")
        # 卡点 A 证据：打印每个入站请求带的 Bearer token（掩码）与校验结果。
        if header.startswith("Bearer "):
            shown = f"Bearer {mask_token(header[len('Bearer '):])}"
        elif header:
            shown = "<非 Bearer 格式>"
        else:
            shown = "<缺失>"
        if self._token:
            expected = f"Bearer {self._token}"
            if header != expected:
                logger.warning("[MCP] %s %s  auth=%s  ❌ 401 拒绝（token 不匹配）",
                               request.method, request.url.path, shown)
                return JSONResponse({"error": "unauthorized", "message": "缺少或错误的 Bearer token"}, status_code=401)
            logger.info("[MCP] %s %s  auth=%s  ✅ static_bearer 校验通过",
                        request.method, request.url.path, shown)
        else:
            logger.info("[MCP] %s %s  auth=%s  ⚠️ 未配置 token，跳过校验（仅本地调试）",
                        request.method, request.url.path, shown)
        return await call_next(request)


def build_app(token: Optional[str] = None, server: Optional[FastMCP] = None) -> Starlette:
    """返回可 uvicorn 运行的 Starlette app，MCP 端点在 /mcp，外层套 Bearer 中间件。"""
    server = server or build_server()
    server.settings.streamable_http_path = MCP_PATH
    app = server.streamable_http_app()
    app.add_middleware(StaticBearerMiddleware, token=token)
    return app
