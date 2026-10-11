"""Regression tests for email schedule and task extraction boundaries."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

import mona.email_intel.schedule_extract as schedule_extract_module
import mona.usage
from mona.email_intel.config import EmailScheduleConfig
from mona.email_intel.schedule_extract import (
    SOURCE_MODULE,
    ExtractedSchedule,
    init_pending_store,
    list_pending_confirmations,
    process_email_for_schedule,
)
from mona.providers.base import LLMResponse
from mona.schedule.service import ScheduleService
from mona.schedule.todo_service import TodoService


def _make_config(**overrides) -> EmailScheduleConfig:
    defaults = dict(
        enabled=True,
        folders=["acc:INBOX"],
        create_mode="auto",
        lead_minutes=0,
        skip_senders=[],
        parse_timeout_seconds=30,
    )
    defaults.update(overrides)
    return EmailScheduleConfig(**defaults)


def _make_provider_with_response(content: str | None) -> MagicMock:
    provider = MagicMock()
    provider.chat = AsyncMock(return_value=LLMResponse(content=content))
    return provider


def _candidate_response(**overrides) -> str:
    payload = {
        "has_schedule": True,
        "intent": "event",
        "user_relation": "required",
        "action_evidence": "请你参加项目评审会议",
        "time_evidence": "2026年10月20日15:00",
        "title": "项目评审会议",
        "start_at": "2026-10-20T15:00:00+08:00",
        "end_at": None,
        "all_day": False,
        "description": "请参加项目评审会议",
        "confidence": 0.95,
    }
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


def _common_kwargs(**overrides):
    defaults = dict(
        account_id="acc",
        uid="100",
        folder="INBOX",
        subject="项目评审会议",
        from_address="boss@example.com",
        from_name="Boss",
        date="2026-10-10T10:00:00+08:00",
        body_text="请你参加项目评审会议，时间为2026年10月20日15:00。",
        body_html=None,
        now_iso="2026-10-10T10:00:00+08:00",
        tz="Asia/Shanghai",
        model="test-model",
        user_address="wang@example.com",
        user_name="王明",
        to_addresses="王明 <wang@example.com>",
        cc_addresses="",
    )
    defaults.update(overrides)
    return defaults


@pytest.fixture
def email_services(tmp_path, monkeypatch):
    """Use real schedule/todo persistence while isolating pending and usage data."""
    monkeypatch.setattr(schedule_extract_module, "_pending_confirmations", [])
    monkeypatch.setattr(schedule_extract_module, "_PENDING_STORE_PATH", None)
    monkeypatch.setattr(schedule_extract_module, "_PENDING_LOCK", None)
    init_pending_store(tmp_path / "email-pending.json")
    monkeypatch.setattr(mona.usage, "record_provider_usage", lambda *args, **kwargs: None)

    schedule_svc = ScheduleService(tmp_path / "schedule" / "items.json")
    todo_svc = TodoService(tmp_path / "schedule" / "todos.json")
    yield schedule_svc, todo_svc
    schedule_svc.stop()


async def _assert_no_plan_items(schedule_svc, todo_svc):
    assert await schedule_svc.list_items() == []
    assert await todo_svc.list_items(source_type="email") == []
    assert list_pending_confirmations() == []


async def test_returns_skipped_when_llm_says_no_schedule(email_services):
    schedule_svc, todo_svc = email_services
    provider = _make_provider_with_response('{"has_schedule": false}')

    result = await process_email_for_schedule(
        provider, schedule_svc, _make_config(), todo_svc=todo_svc, **_common_kwargs()
    )

    assert result == "skipped"
    await _assert_no_plan_items(schedule_svc, todo_svc)


async def test_returns_error_on_invalid_json(email_services):
    schedule_svc, todo_svc = email_services
    provider = _make_provider_with_response("not a json")

    result = await process_email_for_schedule(
        provider, schedule_svc, _make_config(), todo_svc=todo_svc, **_common_kwargs()
    )

    assert result == "error"
    await _assert_no_plan_items(schedule_svc, todo_svc)


async def test_returns_error_when_has_schedule_is_not_a_json_boolean(email_services):
    schedule_svc, todo_svc = email_services
    provider = _make_provider_with_response('{"has_schedule": "false"}')

    result = await process_email_for_schedule(
        provider, schedule_svc, _make_config(), todo_svc=todo_svc, **_common_kwargs()
    )

    assert result == "error"
    await _assert_no_plan_items(schedule_svc, todo_svc)


async def test_returns_error_on_timeout(email_services):
    schedule_svc, todo_svc = email_services
    provider = MagicMock()
    provider.chat = AsyncMock(side_effect=asyncio.TimeoutError())

    result = await process_email_for_schedule(
        provider, schedule_svc, _make_config(), todo_svc=todo_svc, **_common_kwargs()
    )

    assert result == "error"
    await _assert_no_plan_items(schedule_svc, todo_svc)


async def test_retry_after_error_creates_single_schedule(email_services):
    """A provider retry may create once; a duplicate email is then skipped."""
    schedule_svc, todo_svc = email_services
    failing_provider = MagicMock()
    failing_provider.chat = AsyncMock(side_effect=asyncio.TimeoutError())
    success_provider = _make_provider_with_response(_candidate_response())
    kwargs = _common_kwargs()

    first = await process_email_for_schedule(
        failing_provider, schedule_svc, _make_config(), todo_svc=todo_svc, **kwargs
    )
    second = await process_email_for_schedule(
        success_provider, schedule_svc, _make_config(), todo_svc=todo_svc, **kwargs
    )
    duplicate = await process_email_for_schedule(
        success_provider, schedule_svc, _make_config(), todo_svc=todo_svc, **kwargs
    )

    assert (first, second, duplicate) == ("error", "created", "skipped")
    items = await schedule_svc.list_items()
    assert len(items) == 1
    assert items[0].source_module == SOURCE_MODULE
    assert items[0].source_chat_id == "acc:100"
    assert items[0].title == "项目评审会议"
    assert success_provider.chat.await_count == 1
    assert await todo_svc.list_items(source_type="email") == []


async def test_personal_meeting_is_created(email_services):
    schedule_svc, todo_svc = email_services
    provider = _make_provider_with_response(_candidate_response())

    result = await process_email_for_schedule(
        provider, schedule_svc, _make_config(), todo_svc=todo_svc,
        **{**_common_kwargs(), "uid": "meeting-1"},
    )

    assert result == "created"
    items = await schedule_svc.list_items()
    assert len(items) == 1
    assert items[0].title == "项目评审会议"
    assert items[0].source_chat_id == "acc:meeting-1"
    assert await todo_svc.list_items(source_type="email") == []


async def test_registration_confirmation_is_created(email_services):
    schedule_svc, todo_svc = email_services
    body = "您的报名已成功，活动时间为2026年10月20日09:00。"
    provider = _make_provider_with_response(
        _candidate_response(
            action_evidence="您的报名已成功",
            time_evidence="2026年10月20日09:00",
            title="ISACA 活动",
            start_at="2026-10-20T09:00:00+08:00",
            description=body,
        )
    )

    result = await process_email_for_schedule(
        provider,
        schedule_svc,
        _make_config(),
        todo_svc=todo_svc,
        **_common_kwargs(subject="ISACA 活动报名确认", body_text=body, uid="registered-1"),
    )

    assert result == "created"
    items = await schedule_svc.list_items()
    assert len(items) == 1
    assert items[0].title == "ISACA 活动"
    assert await todo_svc.list_items(source_type="email") == []


async def test_cc_other_person_delivery_is_not_added_to_plan(email_services):
    """Recipient identity reaches the classifier, and an unrelated task stays out."""
    schedule_svc, todo_svc = email_services
    subject = "河南科技大学海光C86-4G统信UOS适配任务交付截止"
    body = "本任务由张工负责，截止2026年10月14日完成。请知悉。"
    provider = _make_provider_with_response(
        _candidate_response(
            intent="task",
            user_relation="none",
            action_evidence="本任务由张工负责",
            time_evidence="截止2026年10月14日",
            title="统信UOS适配任务交付截止",
            start_at="2026-10-14T23:59:00+08:00",
        )
    )

    result = await process_email_for_schedule(
        provider,
        schedule_svc,
        _make_config(),
        todo_svc=todo_svc,
        **_common_kwargs(
            uid="cc-other-task",
            subject=subject,
            body_text=body,
            to_addresses="张工 <zhang@example.com>",
            cc_addresses="王明 <wang@example.com>",
        ),
    )

    assert result == "skipped"
    prompt = provider.chat.await_args.kwargs["messages"][0]["content"]
    assert "用户邮箱：wang@example.com" in prompt
    assert "用户姓名：王明" in prompt
    assert "用户在此邮件中的角色：仅抄送人" in prompt
    assert "收件人（To）：张工 <zhang@example.com>" in prompt
    assert "抄送人（Cc）：王明 <wang@example.com>" in prompt
    await _assert_no_plan_items(schedule_svc, todo_svc)


async def test_cc_user_explicitly_named_task_becomes_suggestion_without_due_date(
    email_services,
):
    schedule_svc, todo_svc = email_services
    subject = "请王明负责统信UOS适配协调"
    body = "王明，请你接手河南科技大学统信UOS适配协调工作。"
    provider = _make_provider_with_response(
        _candidate_response(
            intent="task",
            action_evidence="王明，请你接手",
            time_evidence="",
            title="统信UOS适配协调",
            start_at=None,
            description=body,
        )
    )

    result = await process_email_for_schedule(
        provider,
        schedule_svc,
        _make_config(),
        todo_svc=todo_svc,
        **_common_kwargs(
            uid="cc-explicit-task",
            subject=subject,
            body_text=body,
            to_addresses="项目组 <team@example.com>",
            cc_addresses="王明 <wang@example.com>",
            message_id="<task-1@example.com>",
        ),
    )

    assert result == "pending"
    assert await schedule_svc.list_items() == []
    suggestions = await todo_svc.list_items(source_type="email")
    assert len(suggestions) == 1
    assert suggestions[0].title == "统信UOS适配协调"
    assert suggestions[0].state == "suggestion"
    assert suggestions[0].due_at_ms is None
    assert suggestions[0].source_locator == {
        "accountId": "acc",
        "folder": "INBOX",
        "uid": "cc-explicit-task",
        "messageId": "<task-1@example.com>",
    }


async def test_isaca_promotion_with_registration_required_is_ignored(email_services):
    schedule_svc, todo_svc = email_services
    body = (
        "ISACA Member Experience Leadership Series live event featuring Sarah Robb "
        "O'Hagan. Topic: creating 'extreme teams,' navigating intergenerational dynamics "
        "and embracing diversity. Earn 1 Free CPE Credit. DATE: 14 October 2026. "
        "Registration required."
    )
    provider = _make_provider_with_response(
        _candidate_response(
            intent="promotion",
            action_evidence="Registration required",
            time_evidence="14 October 2026",
            title="ISACA Member Experience Leadership Series",
            start_at="2026-10-14T09:00:00+08:00",
            description=body,
            confidence=0.99,
        )
    )

    result = await process_email_for_schedule(
        provider,
        schedule_svc,
        _make_config(),
        todo_svc=todo_svc,
        **_common_kwargs(
            uid="isaca-promotion",
            subject="ISACA Member Experience Leadership Series",
            body_text=body,
        ),
    )

    assert result == "skipped"
    await _assert_no_plan_items(schedule_svc, todo_svc)


@pytest.mark.parametrize(
    ("case", "response_overrides"),
    [
        ("low confidence", {"confidence": 0.69}),
        (
            "past event",
            {
                "time_evidence": "2026年10月9日15:00",
                "start_at": "2026-10-09T15:00:00+08:00",
            },
        ),
        ("fabricated action evidence", {"action_evidence": "您已确认参加"}),
        ("no user relation", {"user_relation": "none"}),
    ],
)
async def test_invalid_or_unrelated_candidates_are_not_created(
    case, response_overrides, email_services
):
    schedule_svc, todo_svc = email_services
    body = "请你参加项目评审会议，时间为2026年10月20日15:00。"
    if case == "past event":
        body = "请你参加项目评审会议，时间为2026年10月9日15:00。"
    provider = _make_provider_with_response(_candidate_response(**response_overrides))

    result = await process_email_for_schedule(
        provider,
        schedule_svc,
        _make_config(),
        todo_svc=todo_svc,
        **_common_kwargs(uid=f"invalid-{case}", body_text=body),
    )

    assert result == "skipped"
    await _assert_no_plan_items(schedule_svc, todo_svc)


async def test_uncertain_event_is_pending_for_confirmation(email_services):
    schedule_svc, todo_svc = email_services
    provider = _make_provider_with_response(
        _candidate_response(user_relation="uncertain", confidence=0.98)
    )

    result = await process_email_for_schedule(
        provider,
        schedule_svc,
        _make_config(),
        todo_svc=todo_svc,
        **_common_kwargs(uid="uncertain-event"),
    )

    assert result == "pending"
    assert await schedule_svc.list_items() == []
    assert await todo_svc.list_items(source_type="email") == []
    pending = list_pending_confirmations()
    assert len(pending) == 1
    assert pending[0]["emailUid"] == "uncertain-event"
    assert pending[0]["item"]["title"] == "项目评审会议"


@pytest.mark.parametrize(
    "identity_overrides",
    [{"user_address": ""}, {"to_addresses": "other@example.com", "cc_addresses": ""}],
)
async def test_required_event_with_unknown_recipient_identity_is_pending(email_services, identity_overrides):
    schedule_svc, todo_svc = email_services
    provider = _make_provider_with_response(_candidate_response())

    result = await process_email_for_schedule(
        provider,
        schedule_svc,
        _make_config(),
        todo_svc=todo_svc,
        **_common_kwargs(uid="unknown-recipient", **identity_overrides),
    )

    assert result == "pending"
    assert await schedule_svc.list_items() == []
    assert len(list_pending_confirmations()) == 1


async def test_all_day_event_today_is_allowed(email_services):
    schedule_svc, todo_svc = email_services
    body = "请你参加全天培训，日期为2026年10月10日。"
    provider = _make_provider_with_response(
        _candidate_response(
            action_evidence="请你参加全天培训",
            time_evidence="2026年10月10日",
            title="全天培训",
            start_at="2026-10-10T00:00:00+08:00",
            all_day=True,
            description=body,
        )
    )

    result = await process_email_for_schedule(
        provider,
        schedule_svc,
        _make_config(),
        todo_svc=todo_svc,
        **_common_kwargs(uid="all-day-today", body_text=body),
    )

    assert result == "created"
    items = await schedule_svc.list_items()
    assert len(items) == 1
    assert items[0].all_day is True
    assert items[0].title == "全天培训"


async def test_returns_skipped_when_sender_in_skip_list(email_services):
    schedule_svc, todo_svc = email_services
    provider = _make_provider_with_response(_candidate_response())

    result = await process_email_for_schedule(
        provider, schedule_svc, _make_config(skip_senders=["boss@example.com"]),
        todo_svc=todo_svc, **_common_kwargs(),
    )

    assert result == "skipped"
    provider.chat.assert_not_awaited()
    await _assert_no_plan_items(schedule_svc, todo_svc)


def test_extracted_schedule_dataclass_defaults():
    sched = ExtractedSchedule(title="t", start_at="2026-10-20T15:00:00+08:00")
    assert sched.has_schedule is False
    assert sched.confidence == 0.0
    assert sched.end_at is None
    assert sched.all_day is False
