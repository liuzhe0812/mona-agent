"""邮件 SQLite 读取层。

直接读取 Rust 侧的 email.sqlite3，提供搜索和读取能力。
只读，不写入。所有写操作通过 Rust 命令（前端调用）完成。

数据库路径：get_data_dir() / "email.sqlite3"
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from loguru import logger

from mona.config.paths import get_data_dir

_EMAIL_DB_FILE = "email.sqlite3"


def _get_db_path() -> Path:
    """获取 email.sqlite3 路径。"""
    return get_data_dir() / _EMAIL_DB_FILE


def _connect() -> sqlite3.Connection:
    """打开只读连接。"""
    path = _get_db_path()
    if not path.exists():
        raise RuntimeError(f"邮件数据库不存在: {path}")
    # uri=True + mode=ro 确保只读
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _row_to_message(row: sqlite3.Row) -> dict[str, Any]:
    """将数据库行转换为邮件 dict（字段名与 EmailMessage 一致，camelCase）。"""
    import json

    attachments_json = row["attachments_json"] if "attachments_json" in row.keys() else None
    attachments = []
    if attachments_json:
        try:
            attachments = json.loads(attachments_json)
        except (json.JSONDecodeError, TypeError):
            attachments = []

    return {
        "uid": row["uid"],
        "accountId": row["account_id"],
        "folder": row["folder"],
        "subject": row["subject"],
        "fromAddress": row["from_address"],
        "fromName": row["from_name"],
        "toAddresses": row["to_addresses"],
        "ccAddresses": row["cc_addresses"],
        "date": row["date"],
        "bodyText": row["body_text"],
        "bodyHtml": row["body_html"],
        "hasAttachments": bool(row["has_attachments"]),
        "isRead": bool(row["is_read"]),
        "isStarred": bool(row["is_starred"]),
        "rawSize": row["raw_size"],
        "messageId": row["message_id"] if "message_id" in row.keys() else None,
        "attachments": attachments,
    }


def search_messages(
    *,
    account_id: str | None = None,
    folder: str | None = None,
    keyword: str | None = None,
    from_address: str | None = None,
    from_name: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    is_read: bool | None = None,
    is_starred: bool | None = None,
    has_attachments: bool | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """搜索邮件，返回匹配的邮件列表（不含正文，节省内存）。

    所有筛选条件为可选，None 表示不筛选。keyword 在 subject 和 body_text 上做 LIKE。
    返回结果按 date DESC 排序。

    Args:
        account_id: 限定账号
        folder: 限定文件夹
        keyword: 关键词（subject + body_text LIKE）
        from_address: 发件人邮箱（LIKE）
        from_name: 发件人名称（LIKE）
        date_from: 起始日期（ISO 格式，>=）
        date_to: 结束日期（ISO 格式，<=）
        is_read: 已读状态
        is_starred: 星标状态
        has_attachments: 是否有附件
        limit: 返回上限（默认 50，最大 200）
        offset: 偏移量

    Returns:
        邮件 dict 列表（字段名 camelCase，bodyText/bodyHtml 不返回以节省内存）
    """
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    conditions: list[str] = []
    params: list[Any] = []

    if account_id:
        conditions.append("account_id = ?")
        params.append(account_id)
    if folder:
        conditions.append("folder = ?")
        params.append(folder)
    if keyword:
        conditions.append("(subject LIKE ? OR body_text LIKE ?)")
        kw = f"%{keyword}%"
        params.extend([kw, kw])
    if from_address:
        conditions.append("from_address LIKE ?")
        params.append(f"%{from_address}%")
    if from_name:
        conditions.append("from_name LIKE ?")
        params.append(f"%{from_name}%")
    if date_from:
        conditions.append("date >= ?")
        params.append(date_from)
    if date_to:
        conditions.append("date <= ?")
        params.append(date_to)
    if is_read is not None:
        conditions.append("is_read = ?")
        params.append(1 if is_read else 0)
    if is_starred is not None:
        conditions.append("is_starred = ?")
        params.append(1 if is_starred else 0)
    if has_attachments is not None:
        conditions.append("has_attachments = ?")
        params.append(1 if has_attachments else 0)

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    sql = f"""
        SELECT uid, account_id, folder, subject, from_address, from_name,
               to_addresses, cc_addresses, date, has_attachments, is_read,
               is_starred, raw_size, message_id, attachments_json
        FROM messages
        {where_clause}
        ORDER BY date DESC
        LIMIT ? OFFSET ?
    """
    params.extend([limit, offset])

    logger.debug("Email search SQL: {} params: {}", sql, params)

    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()

    # 不返回 bodyText/bodyHtml，节省 token
    results = []
    for row in rows:
        msg = _row_to_message(row)
        msg.pop("bodyText", None)
        msg.pop("bodyHtml", None)
        results.append(msg)

    logger.info("Email search: {} results", len(results))
    return results


def get_message(
    uid: str,
    account_id: str,
    folder: str,
) -> dict[str, Any] | None:
    """读取单封邮件全文（含 bodyText）。

    Args:
        uid: 邮件 UID
        account_id: 账号 ID
        folder: 文件夹

    Returns:
        邮件 dict（含 bodyText），不存在返回 None
    """
    sql = """
        SELECT uid, account_id, folder, subject, from_address, from_name,
               to_addresses, cc_addresses, date, body_text, body_html,
               has_attachments, is_read, is_starred, raw_size, message_id,
               attachments_json
        FROM messages
        WHERE uid = ? AND account_id = ? AND folder = ?
    """

    with _connect() as conn:
        row = conn.execute(sql, [uid, account_id, folder]).fetchone()

    if row is None:
        return None
    return _row_to_message(row)


def get_analysis(
    uid: str,
    account_id: str,
    folder: str,
) -> dict[str, Any] | None:
    """读取邮件的 AI 分析结果。"""
    sql = """
        SELECT uid, account_id, folder, summary, category, intent,
               urgency, sentiment, key_info, analyzed_at
        FROM email_ai_analysis
        WHERE uid = ? AND account_id = ? AND folder = ?
    """

    with _connect() as conn:
        row = conn.execute(sql, [uid, account_id, folder]).fetchone()

    if row is None:
        return None

    return {
        "uid": row["uid"],
        "accountId": row["account_id"],
        "folder": row["folder"],
        "summary": row["summary"],
        "category": row["category"],
        "intent": row["intent"],
        "urgency": row["urgency"],
        "sentiment": row["sentiment"],
        "keyInfo": row["key_info"],
        "analyzedAt": row["analyzed_at"],
    }


def list_accounts() -> list[dict[str, Any]]:
    """列出所有邮件账号（从 messages 表的 account_id 去重）。"""
    sql = """
        SELECT DISTINCT account_id
        FROM messages
        ORDER BY account_id
    """

    with _connect() as conn:
        rows = conn.execute(sql).fetchall()

    return [{"accountId": row["account_id"]} for row in rows]


def get_daily_stats(date_str: str) -> dict[str, Any]:
    """获取某天的邮件统计，用于日报。

    Args:
        date_str: 日期字符串，ISO 格式如 "2026-06-20"

    Returns:
        dict: received_count, unread_count, needs_action_count, top_senders, important_subjects
    """
    date_prefix = date_str[:10]  # 取 YYYY-MM-DD
    like_pattern = f"{date_prefix}%"

    with _connect() as conn:
        # 收到的邮件数（INBOX 及其他收件文件夹）
        received_rows = conn.execute(
            """SELECT COUNT(*) as cnt FROM messages
               WHERE date LIKE ? AND folder NOT IN ('Sent', 'Drafts', 'Trash', 'Junk')""",
            [like_pattern],
        ).fetchone()
        received_count = received_rows["cnt"] if received_rows else 0

        # 未读数
        unread_rows = conn.execute(
            """SELECT COUNT(*) as cnt FROM messages
               WHERE date LIKE ? AND is_read = 0
               AND folder NOT IN ('Sent', 'Drafts', 'Trash', 'Junk')""",
            [like_pattern],
        ).fetchone()
        unread_count = unread_rows["cnt"] if unread_rows else 0

        # 需要处理的邮件（有 AI 分析且 intent 为 needs_reply 或 needs_action）
        needs_action_rows = conn.execute(
            """SELECT COUNT(*) as cnt FROM messages m
               JOIN email_ai_analysis a
                 ON m.uid = a.uid AND m.account_id = a.account_id AND m.folder = a.folder
               WHERE m.date LIKE ?
               AND a.intent IN ('needs_reply', 'needs_action', 'needs_approval')""",
            [like_pattern],
        ).fetchone()
        needs_action_count = needs_action_rows["cnt"] if needs_action_rows else 0

        # Top 发件人
        sender_rows = conn.execute(
            """SELECT from_name, from_address, COUNT(*) as cnt FROM messages
               WHERE date LIKE ? AND folder NOT IN ('Sent', 'Drafts', 'Trash', 'Junk')
               GROUP BY from_address ORDER BY cnt DESC LIMIT 5""",
            [like_pattern],
        ).fetchall()
        top_senders = [
            {"name": r["from_name"] or r["from_address"], "address": r["from_address"], "count": r["cnt"]}
            for r in sender_rows
        ]

        # 重要邮件（高紧急度或需要回复）
        important_rows = conn.execute(
            """SELECT m.subject, m.from_name, m.from_address, m.date, m.uid, m.account_id, m.folder
               FROM messages m
               JOIN email_ai_analysis a
                 ON m.uid = a.uid AND m.account_id = a.account_id AND m.folder = a.folder
               WHERE m.date LIKE ?
               AND (a.urgency = 'high' OR a.intent IN ('needs_reply', 'needs_approval'))
               ORDER BY m.date DESC LIMIT 5""",
            [like_pattern],
        ).fetchall()
        important_emails = [
            {
                "subject": r["subject"],
                "fromName": r["from_name"],
                "fromAddress": r["from_address"],
                "date": r["date"],
                "uid": r["uid"],
                "accountId": r["account_id"],
                "folder": r["folder"],
            }
            for r in important_rows
        ]

    return {
        "date": date_prefix,
        "receivedCount": received_count,
        "unreadCount": unread_count,
        "needsActionCount": needs_action_count,
        "topSenders": top_senders,
        "importantEmails": important_emails,
    }


def get_weekly_stats(date_from: str, date_to: str) -> dict[str, Any]:
    """获取一周的邮件统计，用于周报。

    Args:
        date_from: 起始日期 ISO 格式 "2026-06-16"
        date_to: 结束日期 ISO 格式 "2026-06-22"

    Returns:
        dict: received_count, sent_count, unread_count, needs_action_count,
              top_senders, unreplied_count, important_emails
    """
    with _connect() as conn:
        # 收到和发送的邮件数
        received_row = conn.execute(
            """SELECT COUNT(*) as cnt FROM messages
               WHERE date >= ? AND date <= ?
               AND folder NOT IN ('Sent', 'Drafts', 'Trash', 'Junk')""",
            [date_from, date_to + " 23:59:59"],
        ).fetchone()
        received_count = received_row["cnt"] if received_row else 0

        sent_row = conn.execute(
            """SELECT COUNT(*) as cnt FROM messages
               WHERE date >= ? AND date <= ? AND folder IN ('Sent', 'Sent Items')""",
            [date_from, date_to + " 23:59:59"],
        ).fetchone()
        sent_count = sent_row["cnt"] if sent_row else 0

        # 未读数
        unread_row = conn.execute(
            """SELECT COUNT(*) as cnt FROM messages
               WHERE date >= ? AND date <= ? AND is_read = 0
               AND folder NOT IN ('Sent', 'Drafts', 'Trash', 'Junk')""",
            [date_from, date_to + " 23:59:59"],
        ).fetchone()
        unread_count = unread_row["cnt"] if unread_row else 0

        # 需要处理但未回复的邮件数
        unreplied_row = conn.execute(
            """SELECT COUNT(*) as cnt FROM messages m
               JOIN email_ai_analysis a
                 ON m.uid = a.uid AND m.account_id = a.account_id AND m.folder = a.folder
               WHERE m.date >= ? AND m.date <= ?
               AND a.intent IN ('needs_reply', 'needs_action', 'needs_approval')
               AND m.is_read = 0""",
            [date_from, date_to + " 23:59:59"],
        ).fetchone()
        unreplied_count = unreplied_row["cnt"] if unreplied_row else 0

        # Top 发件人
        sender_rows = conn.execute(
            """SELECT from_name, from_address, COUNT(*) as cnt FROM messages
               WHERE date >= ? AND date <= ?
               AND folder NOT IN ('Sent', 'Drafts', 'Trash', 'Junk')
               GROUP BY from_address ORDER BY cnt DESC LIMIT 5""",
            [date_from, date_to + " 23:59:59"],
        ).fetchall()
        top_senders = [
            {"name": r["from_name"] or r["from_address"], "address": r["from_address"], "count": r["cnt"]}
            for r in sender_rows
        ]

        # 重要邮件
        important_rows = conn.execute(
            """SELECT m.subject, m.from_name, m.from_address, m.date, m.uid, m.account_id, m.folder,
                      a.summary, a.urgency, a.intent
               FROM messages m
               JOIN email_ai_analysis a
                 ON m.uid = a.uid AND m.account_id = a.account_id AND m.folder = a.folder
               WHERE m.date >= ? AND m.date <= ?
               AND (a.urgency = 'high' OR a.intent IN ('needs_reply', 'needs_approval'))
               ORDER BY m.date DESC LIMIT 10""",
            [date_from, date_to + " 23:59:59"],
        ).fetchall()
        important_emails = [
            {
                "subject": r["subject"],
                "fromName": r["from_name"],
                "fromAddress": r["from_address"],
                "date": r["date"],
                "summary": r["summary"],
                "urgency": r["urgency"],
                "intent": r["intent"],
            }
            for r in important_rows
        ]

    return {
        "dateFrom": date_from[:10],
        "dateTo": date_to[:10],
        "receivedCount": received_count,
        "sentCount": sent_count,
        "unreadCount": unread_count,
        "unrepliedCount": unreplied_count,
        "topSenders": top_senders,
        "importantEmails": important_emails,
    }


def get_emails_with_deadlines(
    *,
    account_id: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """获取有截止日期的已分析邮件，用于任务提取。

    Args:
        account_id: 限定账号（可选）
        limit: 返回上限

    Returns:
        list[dict]: 每项含 uid, accountId, folder, subject, fromName, fromAddress,
                    date, summary, intent, urgency, keyInfo (parsed dict)
    """
    conditions = ["a.key_info LIKE '%deadlines%'"]
    params: list[Any] = []

    if account_id:
        conditions.append("a.account_id = ?")
        params.append(account_id)

    where_clause = " AND ".join(conditions)

    sql = f"""
        SELECT m.uid, m.account_id, m.folder, m.subject, m.from_name, m.from_address,
               m.date, a.summary, a.intent, a.urgency, a.key_info
        FROM messages m
        JOIN email_ai_analysis a
          ON m.uid = a.uid AND m.account_id = a.account_id AND m.folder = a.folder
        WHERE {where_clause}
        ORDER BY m.date DESC
        LIMIT ?
    """
    params.append(limit)

    import json as _json

    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()

    results = []
    for row in rows:
        try:
            key_info = _json.loads(row["key_info"]) if row["key_info"] else {}
        except (_json.JSONDecodeError, TypeError):
            key_info = {}

        deadlines = key_info.get("deadlines") or []
        if not deadlines:
            continue

        results.append({
            "uid": row["uid"],
            "accountId": row["account_id"],
            "folder": row["folder"],
            "subject": row["subject"],
            "fromName": row["from_name"],
            "fromAddress": row["from_address"],
            "date": row["date"],
            "summary": row["summary"],
            "intent": row["intent"],
            "urgency": row["urgency"],
            "deadlines": deadlines,
        })

    return results


def list_folders(account_id: str) -> list[dict[str, Any]]:
    """列出指定账号的所有文件夹（从 messages 表去重）。"""
    sql = """
        SELECT folder, COUNT(*) as count, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread
        FROM messages
        WHERE account_id = ?
        GROUP BY folder
        ORDER BY folder
    """

    with _connect() as conn:
        rows = conn.execute(sql, [account_id]).fetchall()

    return [
        {
            "folder": row["folder"],
            "total": row["count"],
            "unread": row["unread"] or 0,
        }
        for row in rows
    ]
