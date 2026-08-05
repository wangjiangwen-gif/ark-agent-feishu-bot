import json

from arkagent.feishu import normalize_feishu_message


def test_normalize_extracts_text_and_removes_mention_tokens():
    result = normalize_feishu_message({
        "event_id": "evt-1",
        "tenant_key": "tenant-1",
        "sender": {"sender_id": {"open_id": "ou-user"}},
        "message": {
            "message_id": "om-1",
            "chat_id": "oc-1",
            "chat_type": "group",
            "message_type": "text",
            "content": json.dumps({"text": "@_user_1 帮我总结"}),
            "mentions": [{"key": "@_user_1", "id": {"open_id": "ou-bot"}}],
        },
    })
    assert result is not None
    assert result.text == "帮我总结"
    assert result.mentioned_bot is True
    assert result.user_open_id == "ou-user"
    assert result.chat_type == "group"


def test_normalize_ignores_non_text_messages():
    assert normalize_feishu_message({
        "message": {"message_id": "om-1", "chat_id": "oc-1", "chat_type": "p2p", "message_type": "image"}
    }) is None


def test_normalize_defaults_thread_and_tenant():
    result = normalize_feishu_message({
        "sender": {"sender_id": {"open_id": "ou-user"}},
        "message": {
            "message_id": "om-2",
            "chat_id": "oc-2",
            "chat_type": "p2p",
            "message_type": "text",
            "root_id": "root-1",
            "content": json.dumps({"text": "你好"}),
        },
    })
    assert result is not None
    assert result.event_id == "om-2"  # 无 event_id 回退到 message_id
    assert result.thread_id == "root-1"
    assert result.tenant_key == "default"
    assert result.mentioned_bot is False
