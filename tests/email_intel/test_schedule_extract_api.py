"""Exercise identity and recipient context through both extraction endpoints."""

from __future__ import annotations

import asyncio
import json
import sqlite3
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
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


def test_draft_message_preserves_bcc_mime_parts_display_names_and_attachments():
    message = api._build_draft_message(
        {
            "imapUsername": "sender@example.test",
            "fromAddress": "sender@example.test",
            "to": ["Doe, Jane <jane@example.test>"],
            "cc": [],
            "bcc": ["private@example.test"],
            "subject": "Draft",
            "bodyText": "plain body",
            "bodyHtml": "<p>html body</p><img src=\"cid:inline-image-1\">",
            "inReplyTo": "<original@example.test>",
            "attachments": [
                {
                    "filename": "file.txt",
                    "contentType": "text/plain",
                    "data": "eA==",
                },
                {
                    "filename": "inline.png",
                    "contentType": "image/png",
                    "data": "eA==",
                    "contentId": "inline-image-1",
                },
            ],
        },
        "draft-request-123456",
    )
    parsed = BytesParser(policy=policy.default).parsebytes(message.as_bytes())

    assert str(parsed["To"]) == '"Doe, Jane" <jane@example.test>'
    assert parsed["Bcc"] == "private@example.test"
    assert parsed["In-Reply-To"] == "<original@example.test>"
    assert parsed["X-Mona-Draft-Request-ID"] == "draft-request-123456"
    assert parsed.get_body(preferencelist=("plain",)).get_content().strip() == "plain body"
    assert "html body" in parsed.get_body(preferencelist=("html",)).get_content()

    attachments = [
        part for part in parsed.walk()
        if part.get_content_disposition() in {"attachment", "inline"}
    ]
    assert [part.get_filename() for part in attachments] == ["file.txt", "inline.png"]
    assert attachments[0].get_payload(decode=True) == b"x"
    assert attachments[1]["Content-ID"] == "<inline-image-1>"
    assert attachments[1].get_content_disposition() == "inline"


class _DraftImap:
    capabilities = (b"IMAP4rev1", b"UIDPLUS")

    def __init__(self) -> None:
        self.messages = {"10": "old-draft-request-id"}
        self.append_calls = 0
        self.selected = ""
        self.lose_first_append_response = True

    def select(self, mailbox: str):
        self.selected = mailbox
        return "OK", [b"1"]

    def uid(self, command: str, *args):
        if command == "SEARCH":
            request_id = str(args[-1])
            found = [uid.encode() for uid, value in self.messages.items() if value == request_id]
            return "OK", [b" ".join(found)]
        if command == "STORE":
            return "OK", [b"stored"]
        if command == "EXPUNGE":
            self.messages.pop(str(args[0]), None)
            return "OK", [b"expunged"]
        raise AssertionError(f"unexpected UID command: {command}")

    def append(self, mailbox: str, flags: str, date_time, raw_bytes: bytes):
        self.append_calls += 1
        message = BytesParser(policy=policy.default).parsebytes(raw_bytes)
        self.messages["100"] = str(message["X-Mona-Draft-Request-ID"])
        if self.lose_first_append_response:
            self.lose_first_append_response = False
            raise api.imaplib.IMAP4.abort("connection lost after APPEND")
        return "OK", [b"[APPENDUID 1 100] APPEND completed"]


def test_existing_draft_retry_finds_appended_uid_without_duplicate_append(monkeypatch):
    fake_imap = _DraftImap()
    monkeypatch.setattr(api, "_validate_mail_host", lambda *args: None)

    def run_with_connection_retry(body, op):
        try:
            return op(fake_imap)
        except (api.imaplib.IMAP4.abort, TimeoutError, ConnectionError, OSError):
            return op(fake_imap)

    monkeypatch.setattr(api.imap_pool_manager, "run", run_with_connection_retry)
    body = {
        "imapHost": "imap.example.test",
        "imapUsername": "sender@example.test",
        "fromAddress": "sender@example.test",
        "draftUid": "10",
        "draftFolder": "Drafts",
        "draftRequestId": "draft-request-123456",
        "to": ["jane@example.test"],
        "subject": "Updated draft",
        "bodyText": "plain",
        "bodyHtml": "<p>html</p>",
    }

    with pytest.raises(RuntimeError, match="结果尚未确认"):
        api._imap_save_draft(body)
    assert fake_imap.append_calls == 1

    retry = api._imap_save_draft(body)

    assert retry == {"draftUid": "100", "draftFolder": "Drafts"}
    assert fake_imap.append_calls == 1
    assert "10" not in fake_imap.messages
    assert fake_imap.messages["100"] == "draft-request-123456"


async def test_save_draft_route_returns_new_uid_without_outer_retry(monkeypatch):
    calls = {}

    async def run_locked(body, func, max_retries):
        calls["max_retries"] = max_retries
        return {"draftUid": "100", "draftFolder": "Drafts"}

    monkeypatch.setattr(api, "_run_imap_locked", run_locked)
    request = SimpleNamespace(
        json=AsyncMock(return_value={"draftRequestId": "draft-request-123456"})
    )

    response = await api.handle_email_save_draft(request)

    assert calls["max_retries"] == 0
    assert json.loads(response.text) == {
        "status": "ok",
        "draftUid": "100",
        "draftFolder": "Drafts",
    }
