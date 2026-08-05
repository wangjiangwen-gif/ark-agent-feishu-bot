"""飞书接入层：WS 长连接收消息 + im.v1 发消息 + 消息归一化。

移植自原 TS 项目 src/feishu.ts。用 lark-oapi（Python SDK）替代 node-sdk。
WS 回调只做去重与入队（不等待 Agent 执行），满足飞书 3 秒处理约束。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional, Protocol


@dataclass(frozen=True)
class IncomingMessage:
    event_id: str
    message_id: str
    chat_id: str
    chat_type: str  # "p2p" | "group"
    thread_id: str
    user_open_id: str
    tenant_key: str
    text: str
    mentioned_bot: bool


class GatewayLike(Protocol):
    def accept(self, message: IncomingMessage) -> None: ...


def normalize_feishu_message(event: dict) -> Optional[IncomingMessage]:
    """把 im.message.receive_v1 事件体归一化为 IncomingMessage；非文本/缺字段则丢弃。"""
    message = event.get("message") or {}
    if not message.get("message_id") or not message.get("chat_id") or message.get("message_type") != "text":
        return None
    try:
        content = json.loads(message.get("content") or "{}")
        text = str(content.get("text") or "")
    except (json.JSONDecodeError, ValueError):
        return None
    mentions = message.get("mentions") or []
    for mention in mentions:
        key = mention.get("key")
        if key:
            text = text.replace(key, "")
    sender = event.get("sender") or {}
    sender_id = sender.get("sender_id") or {}
    chat_type = "p2p" if message.get("chat_type") == "p2p" else "group"
    return IncomingMessage(
        event_id=event.get("event_id") or message.get("message_id"),
        message_id=message["message_id"],
        chat_id=message["chat_id"],
        chat_type=chat_type,
        thread_id=message.get("thread_id") or message.get("root_id") or message.get("parent_id") or "",
        user_open_id=sender_id.get("open_id") or "",
        tenant_key=event.get("tenant_key") or "default",
        text=text.strip(),
        mentioned_bot=bool(mentions),
    )


class FeishuSender:
    """基于 lark-oapi 的消息发送器（reply / send by chat_id）。"""

    def __init__(self, app_id: str, app_secret: str):
        import lark_oapi as lark

        self._lark = lark
        self._client = (
            lark.Client.builder()
            .app_id(app_id)
            .app_secret(app_secret)
            .log_level(lark.LogLevel.INFO)
            .build()
        )

    def reply(self, message_id: str, text: str) -> None:
        from lark_oapi.api.im.v1 import (
            ReplyMessageRequest,
            ReplyMessageRequestBody,
        )

        body = (
            ReplyMessageRequestBody.builder()
            .content(json.dumps({"text": text}, ensure_ascii=False))
            .msg_type("text")
            .build()
        )
        request = ReplyMessageRequest.builder().message_id(message_id).request_body(body).build()
        response = self._client.im.v1.message.reply(request)
        if not response.success():
            raise RuntimeError(f"飞书回复失败 {response.code}: {response.msg}")

    def send_to_chat(self, chat_id: str, text: str) -> None:
        from lark_oapi.api.im.v1 import (
            CreateMessageRequest,
            CreateMessageRequestBody,
        )

        body = (
            CreateMessageRequestBody.builder()
            .receive_id(chat_id)
            .msg_type("text")
            .content(json.dumps({"text": text}, ensure_ascii=False))
            .build()
        )
        request = CreateMessageRequest.builder().receive_id_type("chat_id").request_body(body).build()
        response = self._client.im.v1.message.create(request)
        if not response.success():
            raise RuntimeError(f"飞书发送失败 {response.code}: {response.msg}")


def start_feishu_gateway(app_id: str, app_secret: str, gateway: GatewayLike) -> None:
    """启动 WS 长连接，阻塞运行。收到消息即归一化并入队。"""
    import lark_oapi as lark
    from lark_oapi.api.im.v1 import P2ImMessageReceiveV1

    def _on_message(data: P2ImMessageReceiveV1) -> None:
        # lark-oapi 会把事件解析成对象；转成 dict 后复用与 TS 等价的归一化逻辑。
        raw = lark.JSON.marshal(data.event)
        message = normalize_feishu_message(json.loads(raw))
        if message:
            gateway.accept(message)

    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(_on_message)
        .build()
    )
    ws_client = lark.ws.Client(app_id, app_secret, event_handler=handler, log_level=lark.LogLevel.INFO)
    ws_client.start()
