"""Exercise identity and recipient context through both extraction endpoints."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from email.message import EmailMessage
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.api import server as api
from mona.email_intel import db
from mona.email_intel.config import EmailScheduleConfig
from mona.providers.base import LLMResponse
from mona.schedule.service import ScheduleService
from mona.schedule.todo_service import TodoService


@pytest.mark.parametrize("mode", ["automatic", "manual", "automatic_retry"])
async def test_extraction_routes_preserve_recipient_identity_and_save_task(
    tmp_path, monkeypatch, mode,
):
    address = "owner@example.test"
    subject = "适配材料交付"
    body = "请 owner@example.test 于2035年10月14日前提交适配材料。"
    mail_root = tmp_path / "mail"
    mail_root.mkdir()
    message = EmailMessage()
    message.set_content(body)
    (mail_root / "1.eml").write_bytes(message.as_bytes())
    db_path = tmp_path / "email.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.executescript("""
            CREATE TABLE accounts (id TEXT, from_address TEXT, from_name TEXT);
            CREATE TABLE messages (
                uid TEXT, account_id TEXT, folder TEXT, subject TEXT,
                from_address TEXT, from_name TEXT, to_addresses TEXT,
                cc_addresses TEXT, date TEXT, has_attachments INTEGER,
                is_read INTEGER, is_starred INTEGER, raw_size INTEGER,
                message_id TEXT, eml_path TEXT
            );
        """)
        conn.execute("INSERT INTO accounts VALUES (?, ?, ?)", ("acc", address, "测试用户"))
        conn.execute(
            "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "1", "acc", "INBOX", subject, "sender@example.test", "发件人",
                "其他负责人 <other@example.test>", "测试用户 <OWNER@example.test>",
                "2035-10-10T10:00:00+08:00", 0, 0, 0, 100,
                "<synthetic-message@example.test>", "1.eml",
            ),
        )
    monkeypatch.setattr(db, "_get_db_path", lambda: db_path)
    monkeypatch.setattr(db, "_mail_root", lambda: mail_root)
    monkeypatch.setattr("mona.usage.record_provider_usage", lambda *args: None)

    result = LLMResponse(content=json.dumps({
        "has_schedule": True,
        "intent": "task",
        "user_relation": "required",
        "action_evidence": body,
        "time_evidence": "2035年10月14日前",
        "title": "提交适配材料",
        "start_at": "2035-10-14T00:00:00+08:00",
        "all_day": True,
        "confidence": 0.95,
    }))
    responses = [asyncio.TimeoutError(), result] if mode == "automatic_retry" else [result]
    provider = SimpleNamespace(chat=AsyncMock(side_effect=responses))
    monkeypatch.setattr(
        "mona.providers.factory.load_provider_snapshot",
        lambda: SimpleNamespace(provider=provider),
    )
    config = SimpleNamespace(
        tools=SimpleNamespace(email_intel=SimpleNamespace(schedule=EmailScheduleConfig(
            enabled=True, folders=["acc:INBOX"], create_mode="auto",
        ))),
        timezone="Asia/Shanghai",
        model="test-model",
    )
    monkeypatch.setattr("mona.config.loader.load_config", lambda: config)

    schedule_svc = ScheduleService(tmp_path / "schedule" / "items.json")
    todo_svc = TodoService(tmp_path / "schedule" / "todos.json")
    app = web.Application()
    app["schedule_service"] = schedule_svc
    app["todo_service"] = todo_svc
    app.router.add_post("/email/schedule/extract", api.handle_email_schedule_extract)
    app.router.add_post("/email/schedule/extract-manual", api.handle_email_schedule_extract_manual)
    manual = mode == "manual"
    endpoint = "/email/schedule/extract-manual" if manual else "/email/schedule/extract"
    payload = {"accountId": "acc", "folder": "INBOX", **({"uid": "1"} if manual else {"uids": ["1"]})}

    async with TestClient(TestServer(app)) as client:
        response = await client.post(endpoint, json=payload)
        assert response.status == 200
        data = await response.json()
        if manual:
            assert data["result"] == "pending"
        else:
            assert data["pending"] == 1
            assert data["created"] == 0
            assert data["error"] == 0

    todos = await todo_svc.list_items()
    assert len(todos) == 1
    assert todos[0].state == "suggestion"
    assert todos[0].source_locator == {
        "accountId": "acc", "folder": "INBOX", "uid": "1",
        "messageId": "<synthetic-message@example.test>",
    }
    assert todos[0].due_at_ms == 2075904000000
    assert await schedule_svc.list_items() == []
    for call in provider.chat.call_args_list:
        prompt = call.kwargs["messages"][0]["content"]
        assert f"用户邮箱：{address}" in prompt
        assert "用户姓名：测试用户" in prompt
        assert "用户在此邮件中的角色：仅抄送人" in prompt
        assert "收件人（To）：其他负责人 <other@example.test>" in prompt
        assert "抄送人（Cc）：测试用户 <OWNER@example.test>" in prompt
    schedule_svc.stop()
