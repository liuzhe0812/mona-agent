"""Personal planning sync projection and compare-before-write in its owning service.

Only personal calendar items and todos are portable. Credentials, source-system
locators, AI jobs, notification queues and cron bindings are never imported.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_STORE = 16 * 1024 * 1024
MAX_ITEMS = 10_000
KINDS = ("todo", "calendar_event")
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_COMMON = {"title": "", "createdAtMs": 0, "updatedAtMs": 0}
_TODO = {**_COMMON, "state": "open", "bucket": "inbox", "notes": "", "dueAtMs": None,
         "priority": "normal", "focusRank": None, "sourceType": "manual", "sourceSnapshot": {},
         "confidence": None, "completedAtMs": None}
_CALENDAR = {**_COMMON, "startAtMs": 0, "description": "", "endAtMs": None, "allDay": False,
             "recurrence": "none", "cronExpr": None, "tz": None, "done": False, "enabled": True, "color": None}


class PlanningSyncError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def encoded(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def fingerprint(value) -> str:
    return hashlib.sha256(encoded(value)).hexdigest()


def normalize_item(kind: str, value: dict, *, incoming: bool = False) -> dict:
    if kind not in KINDS or not isinstance(value, dict):
        raise PlanningSyncError("planning_invalid", "日程或待办格式无效，原有数据保持不变。")
    defaults = _TODO if kind == "todo" else _CALENDAR
    if incoming and set(value) != set(defaults):
        raise PlanningSyncError("planning_invalid", "同步记录包含未允许的字段。")
    if kind == "calendar_event" and value.get("kind", "personal") != "personal":
        raise PlanningSyncError("planning_scope", "AI 自动任务不参与日程同步。")
    result = {name: value.get(name, default) for name, default in defaults.items()}
    for name in ("title", "notes" if kind == "todo" else "description"):
        limit = 1000 if name == "title" else 60_000
        if not isinstance(result[name], str) or len(result[name]) > limit or "\x00" in result[name]:
            raise PlanningSyncError("planning_invalid", "日程或待办文字过长或格式无效。")
    if not result["title"].strip():
        raise PlanningSyncError("planning_invalid", "日程或待办缺少标题。")
    required_times = ("createdAtMs", "updatedAtMs") + (("startAtMs",) if kind == "calendar_event" else ())
    if any(type(result[name]) is not int for name in required_times):
        raise PlanningSyncError("planning_invalid", "日程或待办缺少有效时间。")
    for name in ("createdAtMs", "updatedAtMs", "dueAtMs", "completedAtMs", "startAtMs", "endAtMs"):
        if name in result and result[name] is not None and (type(result[name]) is not int or not 0 <= result[name] <= 253_402_300_799_000):
            raise PlanningSyncError("planning_invalid", "日程或待办时间无效。")
    if kind == "todo":
        for name, choices in (("state", ("suggestion", "open", "done")), ("bucket", ("inbox", "today", "next", "waiting", "someday")),
                              ("priority", ("low", "normal", "high")), ("sourceType", ("manual", "email", "chat", "note"))):
            if result[name] not in choices:
                raise PlanningSyncError("planning_invalid", "待办状态无效。")
        rank = result["focusRank"]
        if rank is not None and (type(rank) is not int or rank not in (1, 2, 3) or result["state"] != "open" or result["bucket"] != "today"):
            raise PlanningSyncError("planning_invalid", "待办重点排序无效。")
        snapshot = result["sourceSnapshot"]
        if not isinstance(snapshot, dict):
            raise PlanningSyncError("planning_invalid", "待办来源摘要无效。")
        if incoming and set(snapshot).difference({"title", "evidence"}):
            raise PlanningSyncError("planning_invalid", "待办来源摘要包含未允许的字段。")
        result["sourceSnapshot"] = {k: v for k, v in snapshot.items() if k in {"title", "evidence"}}
        if any(not isinstance(v, str) or len(v) > 20_000 for v in result["sourceSnapshot"].values()):
            raise PlanningSyncError("planning_invalid", "待办来源摘要过长。")
        confidence = result["confidence"]
        if confidence is not None and (type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0 <= confidence <= 1):
            raise PlanningSyncError("planning_invalid", "待办来源信息无效。")
    else:
        if any(type(result[field]) is not bool for field in ("allDay", "done", "enabled")):
            raise PlanningSyncError("planning_invalid", "日程状态无效。")
        if result["endAtMs"] is not None and result["endAtMs"] < result["startAtMs"]:
            raise PlanningSyncError("planning_invalid", "日程结束时间早于开始时间。")
        if result["recurrence"] not in ("none", "daily", "weekly", "monthly", "cron_expr"):
            raise PlanningSyncError("planning_invalid", "日程重复规则无效。")
        for field, limit in (("cronExpr", 200), ("tz", 100), ("color", 64)):
            if result[field] is not None and (not isinstance(result[field], str) or len(result[field]) > limit):
                raise PlanningSyncError("planning_invalid", "日程选项无效。")
        if result["tz"]:
            try:
                ZoneInfo(result["tz"])
            except (ZoneInfoNotFoundError, ValueError):
                raise PlanningSyncError("planning_invalid", "日程时区无效。") from None
        if result["recurrence"] == "cron_expr":
            from croniter import croniter
            if not isinstance(result["cronExpr"], str) or not croniter.is_valid(result["cronExpr"]):
                raise PlanningSyncError("planning_invalid", "日程重复表达式无效。")
    if len(encoded(result)) > 128 * 1024:
        raise PlanningSyncError("planning_too_large", "单项记录过大，未截断内容。")
    return result


def _read(service) -> dict:
    path = service.store_path
    if path.is_symlink():
        raise PlanningSyncError("planning_storage", "日程存储位置异常，未同步。")
    if not path.exists():
        return {"version": 1, "items": []}
    if path.stat().st_size > MAX_STORE:
        raise PlanningSyncError("planning_too_large", "日程数据过大，未截断内容。")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        items = value["items"]
        if value.get("version") != 1 or not isinstance(items, list) or len(items) > MAX_ITEMS:
            raise ValueError("Invalid store")
        ids = set()
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not IDENTIFIER.fullmatch(item["id"]) or item["id"] in ids:
                raise ValueError("Invalid identity")
            ids.add(item["id"])
        return value
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise PlanningSyncError("planning_storage", "日程或待办文件损坏，未用空数据覆盖。") from None


def list_sync_items(service, kind: str) -> list[dict]:
    if kind not in KINDS:
        raise PlanningSyncError("planning_scope", "不支持的同步类型。")
    with service._lock.acquire(timeout=3):
        store = _read(service)
        return [{"id": item["id"], "data": normalize_item(kind, item)} for item in store["items"]
                if kind == "todo" or item.get("kind", "personal") == "personal"]


def apply_sync_item(service, kind: str, item_id: str, expected: str, data: dict | None) -> dict:
    if kind not in KINDS or not IDENTIFIER.fullmatch(item_id) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise PlanningSyncError("planning_invalid", "同步目标无效。")
    data = normalize_item(kind, data, incoming=True) if data is not None else None
    with service._lock.acquire(timeout=3):
        store = _read(service)
        raw = next((row for row in store["items"] if row["id"] == item_id), None)
        before = normalize_item(kind, raw) if raw is not None else None
        if fingerprint(before) != expected:
            if before == data:
                return {"applied": True, "reused": True, "data": before}
            raise PlanningSyncError("planning_conflict", "本机日程已变化，已保留修改并等待重新同步。")
        if before == data:
            return {"applied": True, "reused": True, "data": before}
        if data is None:
            store["items"] = [row for row in store["items"] if row["id"] != item_id]
        else:
            updated = {**(raw or {}), **data, "id": item_id}
            if kind == "calendar_event":
                updated["kind"] = "personal"
            # Preserve local source links/timer observations but never import them.
            if raw is None:
                store["items"].append(updated)
            else:
                store["items"][store["items"].index(raw)] = updated
            if kind == "todo" and data["focusRank"] is not None:
                for item in store["items"]:
                    if item["id"] != item_id and item.get("state") == "open" and item.get("bucket") == "today" and item.get("focusRank") == data["focusRank"]:
                        item["focusRank"] = None
        payload = encoded(store)
        if len(payload) > MAX_STORE or len(store["items"]) > MAX_ITEMS:
            raise PlanningSyncError("planning_too_large", "日程数据过大，未修改本地内容。")
        service.store_path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".planning-sync-", dir=service.store_path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            Path(name).replace(service.store_path)
        finally:
            Path(name).unlink(missing_ok=True)
    return {"applied": True, "reused": False, "data": data}
