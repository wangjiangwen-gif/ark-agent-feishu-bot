"""arkagent 命令行入口：init / doctor / run。

架构：飞书 WS 客户端在主线程阻塞运行；asyncio 事件循环跑在后台线程，承载
Gateway 的异步编排与方舟调用。WS 回调（主线程）通过 loop.call_soon_threadsafe
把处理协程投递到事件循环，满足飞书 3 秒处理约束。
"""
from __future__ import annotations

import asyncio
import os
import sys
import threading

from .config import load_config, load_config_file
from .masked_input import read_masked_input
from .paths import get_arkagent_paths


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    command = argv[0] if argv else "run"
    try:
        if command == "run":
            _run()
        elif command == "doctor":
            asyncio.run(_doctor())
        elif command == "init":
            asyncio.run(_init())
        else:
            _print_help()
        return 0
    except KeyboardInterrupt:
        print("\n已取消。")
        return 130
    except Exception as error:  # noqa: BLE001 - 顶层兜底，给出友好提示
        print(str(error), file=sys.stderr)
        if str(error).startswith("缺少环境变量"):
            print("请运行 arkagent init 完成交互式配置。", file=sys.stderr)
        return 1


def _load_saved_environment():
    paths = get_arkagent_paths()
    if os.path.exists(paths.config_path):
        load_config_file(paths.config_path)
    return paths


def _mask_identity(value: str) -> str:
    if len(value) <= 8:
        return "***"
    return f"{value[:5]}***{value[-3:]}"


def _build_managers(config, ark, store):
    from .memory import MemoryManager
    from .role import RoleManager, mock_hr_provider

    role_manager = RoleManager(store, mock_hr_provider, ttl_ms=config.role_ttl_ms)
    memory_manager = MemoryManager(ark, store, team_store_enabled=config.team_store_enabled)
    return role_manager, memory_manager


def _run() -> None:
    from .ark import ArkClient
    from .feishu import FeishuSender, start_feishu_gateway
    from .gateway import Gateway
    from .store import GatewayStore

    _load_saved_environment()
    config = load_config()

    store = GatewayStore(config.database_path)
    ark = ArkClient(config.ark_api_key, config.ark_base_url)
    sender = FeishuSender(config.feishu_app_id, config.feishu_app_secret)
    role_manager, memory_manager = _build_managers(config, ark, store)

    # 后台线程跑事件循环，承载 Gateway 的异步任务。
    loop = asyncio.new_event_loop()

    async def reply(chat_id: str, text: str) -> None:
        # lark-oapi 发送是同步阻塞调用，放到 executor 避免卡住事件循环。
        await loop.run_in_executor(None, sender.send_to_chat, chat_id, text)

    gateway = Gateway(
        store,
        ark,
        reply,
        agent_id=config.ark_agent_id,
        environment_id=config.ark_environment_id,
        vault_id=config.ark_vault_id,
        timeout_ms=config.session_timeout_ms,
        authorized_open_ids=config.authorized_open_ids,
        role_manager=role_manager,
        memory_manager=memory_manager,
        loop=loop,
    )

    thread = threading.Thread(target=loop.run_forever, name="gateway-loop", daemon=True)
    thread.start()

    print("Gateway 配置：")
    print(f"- 飞书 App ID：{config.feishu_app_id}")
    print(f"- 方舟 Agent ID：{config.ark_agent_id}")
    print(f"- 方舟 Environment ID：{config.ark_environment_id}")
    print(f"- MCP Server：{config.mcp_server_url}")
    if config.authorized_open_ids:
        masked = ", ".join(_mask_identity(o) for o in config.authorized_open_ids)
        print(f"- 授权用户白名单：{masked}")
    else:
        print("- 授权用户白名单：未设置（对话鉴权交给 MCP 白名单）")
    print("聊天指令：/new 开新会话 · /role <岗位>[/门店] 模拟岗位调动 · /whoami 查看当前岗位")
    print("正在连接飞书 WebSocket；请在该 Bot 会话中发送消息。")
    # 阻塞运行 WS 客户端（主线程）。回调里 gateway.accept 会投递到后台事件循环。
    start_feishu_gateway(config.feishu_app_id, config.feishu_app_secret, gateway)


async def _doctor() -> None:
    from .ark import ArkClient

    _load_saved_environment()
    config = load_config()
    ark = ArkClient(config.ark_api_key, config.ark_base_url)
    try:
        agent = await ark.get_agent(config.ark_agent_id)
        version = f" v{agent['version']}" if agent.get("version") else ""
        print(f"配置有效；已连接 Agent {agent['id']}{version}。")
        print(f"MCP Server：{config.mcp_server_url}")
        print("飞书连接将在 run 命令启动时由 lark-oapi 完成鉴权。")
    finally:
        await ark.aclose()


async def _init() -> None:
    if not sys.stdin.isatty():
        raise RuntimeError("交互式 init 需要在终端中运行")

    from .ark import ArkClient
    from .init import run_guided_init
    from .node_helper import register_feishu_app

    paths = get_arkagent_paths()

    ark_api_key = read_masked_input("火山方舟 API Key（输入内容以 • 显示）: ").strip()
    if not ark_api_key:
        raise RuntimeError("方舟 API Key 不能为空")
    mcp_server_url = input("mock NIO MCP 公网地址（形如 https://xxx/mcp）: ").strip()
    if not mcp_server_url:
        raise RuntimeError("MCP Server 地址不能为空")
    mcp_static_bearer = read_masked_input("mock MCP 的 static Bearer token（输入内容以 • 显示）: ").strip()
    if not mcp_static_bearer:
        raise RuntimeError("MCP static Bearer token 不能为空")

    async def create_feishu_app():
        # registerApp 无 Python 等价物，走 Node 子进程扫码建应用。
        return await asyncio.get_event_loop().run_in_executor(None, register_feishu_app)

    result = await run_guided_init(
        ark_api_key=ark_api_key,
        mcp_server_url=mcp_server_url,
        mcp_static_bearer=mcp_static_bearer,
        create_ark=lambda key, base: ArkClient(key, base),
        create_feishu_app=create_feishu_app,
        env_path=paths.config_path,
        gateway_database_path=paths.database_path,
    )
    print(f"已创建蔚来销售助手 Agent：{result.agent_id}")
    print(f"{'已创建' if result.environment_created else '已复用'} Environment：{result.environment_id}")
    print(f"已配置 static_bearer 凭据：{result.credential_id}（创建时已握手探测 MCP）")
    print(f"配置已安全写入 {result.env_path}。")
    print("初始化完成。运行 `arkagent run` 启动 Gateway。")


def _print_help() -> None:
    print(
        "arkagent [command]\n\n"
        "  init    交互式创建 NIO 销售助手 Agent + 飞书应用（扫码）+ static_bearer 凭据\n"
        "  doctor  检查配置并验证方舟 Agent\n"
        "  run     启动本地 Gateway（默认）"
    )


if __name__ == "__main__":
    sys.exit(main())
