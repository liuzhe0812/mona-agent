"""邮件 AI 日程提取：从邮件内容中识别日程信号并创建日程。

设计原则：
- 仅对新邮件触发（由 sync_folder_internal 调用），不批量扫描历史
- 单邮件 LLM 解析，不做缓存复用
- 去重基于 source_module + source_chat_id，不引入新表
- 创建模式由用户配置：auto 直接创建 / confirm 待确认队列
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from filelock import FileLock
from loguru import logger

from mona.email_intel.analyze import _build_sender, _clean_body, _extract_json
from mona.email_intel.config import EmailScheduleConfig
from mona.providers.base import LLMProvider
from mona.schedule.service import ScheduleService, create_schedule_item_id
from mona.schedule.types import ScheduleItem

# source_module 标识，用于去重
SOURCE_MODULE = "email_schedule_ai"

# 待确认队列：内存镜像，由 _PENDING_STORE_PATH 指向的 JSON 文件持久化
_pending_confirmations: list[PendingConfirmation] = []
_PENDING_STORE_PATH: Path | None = None
_PENDING_LOCK: FileLock | None = None

# LLM 解析 prompt
EXTRACT_PROMPT = """你是一个日程提取助手。从下面这封邮件中识别"用户需要记住并按时处理的时间相关事件"。

需要识别的信号：
- 会议/通话/预约的时间
- 截止日期（deadline）
- 活动报名确认
- 航班/火车/酒店时间
- 预约确认（医院、餐厅等）

不需要识别的信号：
- 邮件本身的发送时间
- 历史事件的回顾
- 已经过去的事件

当前时间：{now}
用户时区：{tz}

邮件主题：{subject}
发件人：{sender}
日期：{date}
正文：
{body}

请返回以下 JSON 结构（只返回 JSON，不要包含 ```json 标记或其他文字）：
{{
  "has_schedule": true/false,
  "title": "日程标题，简洁（≤50字）",
  "start_at": "ISO 8601 格式，含时区偏移，如 2026-07-15T15:00:00+08:00",
  "end_at": "ISO 8601 格式或 null",
  "all_day": true/false,
  "description": "详细描述，含原始邮件片段",
  "confidence": 0.0-1.0
}}

如果邮件中没有需要识别的日程信号，返回 {{"has_schedule": false}}。
"""


@dataclass
class ExtractedSchedule:
    """LLM 从邮件中提取的日程信息。"""

    title: str
    start_at: str  # ISO 8601
    end_at: str | None = None
    all_day: bool = False
    description: str = ""
    confidence: float = 0.0
    has_schedule: bool = False


@dataclass
class PendingConfirmation:
    """待用户确认的日程提取结果。"""

    id: str
    item: ScheduleItem
    email_subject: str
    email_from: str
    email_uid: str
    email_account_id: str
    email_folder: str
    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "item": self.item.to_dict(),
            "email_subject": self.email_subject,
            "email_from": self.email_from,
            "email_uid": self.email_uid,
            "email_account_id": self.email_account_id,
            "email_folder": self.email_folder,
            "created_at_ms": self.created_at_ms,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "PendingConfirmation":
        return cls(
            id=str(raw["id"]),
            item=ScheduleItem.from_dict(raw["item"]),
            email_subject=str(raw.get("email_subject", "")),
            email_from=str(raw.get("email_from", "")),
            email_uid=str(raw.get("email_uid", "")),
            email_account_id=str(raw.get("email_account_id", "")),
            email_folder=str(raw.get("email_folder", "")),
            created_at_ms=int(raw.get("created_at_ms", 0)),
        )


def init_pending_store(store_path: Path) -> None:
    """初始化 pending 持久化路径并从磁盘加载已有数据。由 services 进程启动时调用。"""
    global _PENDING_STORE_PATH, _PENDING_LOCK
    _PENDING_STORE_PATH = store_path
    _PENDING_LOCK = FileLock(str(store_path) + ".lock")
    _load_pending_from_disk()


def _load_pending_from_disk() -> None:
    """从磁盘加载 pending 列表到内存（启动时调用）。"""
    if _PENDING_STORE_PATH is None or not _PENDING_STORE_PATH.exists():
        return
    if _PENDING_LOCK is None:
        return
    try:
        with _PENDING_LOCK:
            data = json.loads(_PENDING_STORE_PATH.read_text(encoding="utf-8"))
            raw_list = data.get("items", []) if isinstance(data, dict) else []
            _pending_confirmations.clear()
            for raw in raw_list:
                try:
                    _pending_confirmations.append(PendingConfirmation.from_dict(raw))
                except Exception:
                    logger.exception("Skipping malformed pending confirmation: {}", raw)
    except (json.JSONDecodeError, OSError):
        logger.exception("Failed to load pending confirmations; starting empty")


def _save_pending_to_disk() -> None:
    """原子写入 pending 列表到磁盘。失败仅记日志，不阻塞业务。"""
    if _PENDING_STORE_PATH is None or _PENDING_LOCK is None:
        return
    try:
        with _PENDING_LOCK:
            _PENDING_STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": 1,
                "items": [p.to_dict() for p in _pending_confirmations],
            }
            tmp = _PENDING_STORE_PATH.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            tmp.replace(_PENDING_STORE_PATH)
    except Exception:
        logger.exception("Failed to persist pending confirmations")


async def extract_schedule_from_email(
    provider: LLMProvider,
    *,
    subject: str,
    from_address: str,
    from_name: str | None,
    date: str,
    body_text: str,
    body_html: str | None = None,
    now_iso: str,
    tz: str,
    model: str | None = None,
    timeout_seconds: int = 30,
) -> ExtractedSchedule | None:
    """从单封邮件中提取日程信息。

    Args:
        provider: LLM provider 实例
        subject: 邮件主题
        from_address: 发件人邮箱
        from_name: 发件人名称
        date: 邮件日期
        body_text: 邮件纯文本正文
        body_html: 邮件 HTML 正文（可选）
        now_iso: 当前时间 ISO 字符串
        tz: 用户时区
        model: 指定模型
        timeout_seconds: LLM 调用超时秒数

    Returns:
        ExtractedSchedule 或 None。None 表示超时、网络错误或模型输出无法解析
        （调用方应计为 error 并可重试）；has_schedule=False 表示 AI 正常完成
        但邮件没有日程信号（调用方应计为 skipped，不重试）。
    """
    sender = _build_sender(from_name, from_address)
    body = _clean_body(body_text, body_html)

    prompt = EXTRACT_PROMPT.format(
        now=now_iso,
        tz=tz,
        subject=subject or "(无主题)",
        sender=sender,
        date=date or "(未知)",
        body=body,
    )

    messages = [{"role": "user", "content": prompt}]

    try:
        response = await asyncio.wait_for(
            provider.chat(
                messages=messages,
                model=model,
                max_tokens=512,
                temperature=0.3,
            ),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError:
        logger.warning("Schedule extract timeout: subject={!r}", subject[:50] if subject else "")
        return None
    except Exception as e:
        logger.warning("Schedule extract LLM call failed: {}", e)
        return None

    content = response.content or ""
    try:
        raw = _extract_json(content)
    except ValueError as e:
        logger.warning("Schedule extract JSON parse failed: {}", e)
        return None

    if not raw.get("has_schedule", False):
        return ExtractedSchedule(title="", start_at="", has_schedule=False)

    return ExtractedSchedule(
        title=str(raw.get("title") or "").strip()[:50],
        start_at=str(raw.get("start_at") or "").strip(),
        end_at=str(raw.get("end_at") or "").strip() or None,
        all_day=bool(raw.get("all_day", False)),
        description=str(raw.get("description") or "").strip(),
        confidence=float(raw.get("confidence") or 0.0),
        has_schedule=True,
    )


def _build_schedule_item(
    extracted: ExtractedSchedule,
    account_id: str,
    uid: str,
    lead_minutes: int,
    tz: str,
) -> ScheduleItem | None:
    """将 LLM 提取结果转为 ScheduleItem。

    Args:
        extracted: LLM 提取的日程信息
        account_id: 邮件账号 ID
        uid: 邮件 UID
        lead_minutes: 提醒提前量（分钟）
        tz: 时区

    Returns:
        ScheduleItem 或 None（时间解析失败）
    """
    start_at_ms = _parse_iso_to_ms(extracted.start_at, tz)
    if start_at_ms is None:
        logger.warning("Schedule extract: failed to parse start_at={!r}", extracted.start_at)
        return None

    # 减去提前提醒量
    if lead_minutes > 0 and not extracted.all_day:
        start_at_ms -= lead_minutes * 60 * 1000

    end_at_ms: int | None = None
    if extracted.end_at:
        end_at_ms = _parse_iso_to_ms(extracted.end_at, tz)

    return ScheduleItem(
        id=create_schedule_item_id(),
        title=extracted.title,
        start_at_ms=start_at_ms,
        end_at_ms=end_at_ms,
        all_day=extracted.all_day,
        description=extracted.description,
        recurrence="none",
        tz=tz,
        kind="personal",
        source_module=SOURCE_MODULE,
        source_chat_id=f"{account_id}:{uid}",
    )


def _parse_iso_to_ms(iso_str: str, tz: str) -> int | None:
    """将 ISO 8601 时间字符串转为毫秒时间戳。

    支持含时区偏移的格式（如 2026-07-15T15:00:00+08:00）和不含时区的格式。
    不含时区时使用传入的 tz 参数。
    """
    if not iso_str:
        return None
    try:
        # 尝试直接解析（含时区偏移的情况）
        dt = datetime.fromisoformat(iso_str)
        if dt.tzinfo is None:
            # 不含时区，尝试用 tz 参数
            try:
                from zoneinfo import ZoneInfo

                dt = dt.replace(tzinfo=ZoneInfo(tz))
            except Exception:
                dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception as e:
        logger.warning("Parse ISO time failed: {!r} error={}", iso_str, e)
        return None


async def _already_extracted(svc: ScheduleService, source_chat_id: str) -> bool:
    """检查同 source_chat_id 的日程是否已存在（去重）。"""
    try:
        items = await svc.list_items()
        return any(
            it.source_module == SOURCE_MODULE and it.source_chat_id == source_chat_id
            for it in items
        )
    except Exception as e:
        logger.warning("Schedule dedup check failed: {}", e)
        return False


def _should_skip_sender(from_address: str, skip_senders: list[str]) -> bool:
    """检查发件人是否在跳过列表中。"""
    if not skip_senders or not from_address:
        return False
    addr_lower = from_address.lower()
    for skip in skip_senders:
        if skip and skip.lower() in addr_lower:
            return True
    return False


async def process_email_for_schedule(
    provider: LLMProvider,
    svc: ScheduleService,
    config: EmailScheduleConfig,
    *,
    account_id: str,
    uid: str,
    folder: str,
    subject: str,
    from_address: str,
    from_name: str | None,
    date: str,
    body_text: str,
    body_html: str | None,
    now_iso: str,
    tz: str,
    model: str | None = None,
) -> str | None:
    """处理单封邮件的日程提取流程。

    Returns:
        - "created": auto 模式下成功创建日程
        - "pending": confirm 模式下放入待确认队列
        - "skipped": 无日程信号或发件人被跳过或已存在
        - "error": 解析失败
    """
    # 跳过发件人检查
    if _should_skip_sender(from_address, config.skip_senders):
        return "skipped"

    # 去重检查
    source_chat_id = f"{account_id}:{uid}"
    if await _already_extracted(svc, source_chat_id):
        return "skipped"

    # LLM 解析
    # None 表示超时、网络错误或模型输出无法解析（计为 error，调用方重试）
    # has_schedule=False 表示 AI 正常完成但邮件没有日程信号（计为 skipped，不重试）
    extracted = await extract_schedule_from_email(
        provider,
        subject=subject,
        from_address=from_address,
        from_name=from_name,
        date=date,
        body_text=body_text,
        body_html=body_html,
        now_iso=now_iso,
        tz=tz,
        model=model,
        timeout_seconds=config.parse_timeout_seconds,
    )

    if extracted is None:
        return "error"
    if not extracted.has_schedule:
        return "skipped"

    # 构造 ScheduleItem
    item = _build_schedule_item(extracted, account_id, uid, config.lead_minutes, tz)
    if item is None:
        return "error"

    # 根据创建模式处理
    if config.create_mode == "auto":
        try:
            await svc.add_item(item)
            logger.info(
                "Schedule auto-created: title={!r} from email uid={}",
                item.title,
                uid,
            )
            return "created"
        except Exception as e:
            logger.exception("Schedule auto-create failed: {}", e)
            return "error"
    else:
        # confirm 模式：放入待确认队列
        pending = PendingConfirmation(
            id=str(uuid.uuid4()),
            item=item,
            email_subject=subject,
            email_from=from_address,
            email_uid=uid,
            email_account_id=account_id,
            email_folder=folder,
        )
        _pending_confirmations.append(pending)
        _save_pending_to_disk()
        logger.info("Schedule pending confirmation: title={!r} uid={}", item.title, uid)
        return "pending"


def list_pending_confirmations() -> list[dict[str, Any]]:
    """返回待确认队列（前端轮询用）。"""
    return [
        {
            "id": p.id,
            "item": p.item.to_dict(),
            "emailSubject": p.email_subject,
            "emailFrom": p.email_from,
            "emailUid": p.email_uid,
            "emailAccountId": p.email_account_id,
            "emailFolder": p.email_folder,
            "createdAtMs": p.created_at_ms,
        }
        for p in _pending_confirmations
    ]


async def confirm_pending_confirmation(svc: ScheduleService, confirmation_id: str) -> bool:
    """确认待确认的日程：创建 ScheduleItem 并从队列移除。"""
    for i, p in enumerate(_pending_confirmations):
        if p.id == confirmation_id:
            try:
                await svc.add_item(p.item)
                _pending_confirmations.pop(i)
                _save_pending_to_disk()
                logger.info("Schedule confirmed and created: title={!r}", p.item.title)
                return True
            except Exception as e:
                logger.exception("Schedule confirm failed: {}", e)
                return False
    return False


def discard_pending_confirmation(confirmation_id: str) -> bool:
    """丢弃待确认的日程（用户拒绝）。"""
    for i, p in enumerate(_pending_confirmations):
        if p.id == confirmation_id:
            _pending_confirmations.pop(i)
            _save_pending_to_disk()
            logger.info("Schedule discarded: title={!r}", p.item.title)
            return True
    return False
