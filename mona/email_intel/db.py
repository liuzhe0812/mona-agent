"""邮件 SQLite 读取层。

直接读取 Rust 侧的 email.sqlite3，提供搜索和读取能力。
只读，不写入。所有写操作通过 Rust 命令（前端调用）完成。

数据库路径优先级：
1. MONA_APP_DATA_DIR 环境变量（由 Rust gateway 启动时注入，与 Rust app_data_dir 一致）
2. get_data_dir() / "email.sqlite3"（默认 ~/.mona/email.sqlite3）
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any

from loguru import logger

from mona.config.paths import get_data_dir

_EMAIL_DB_FILE = "email.sqlite3"


def _get_db_path() -> Path:
    """获取 email.sqlite3 路径。

    优先用 MONA_APP_DATA_DIR（Rust 注入），回退到 get_data_dir()。
    Rust 把 email.sqlite3 写在 app_data_dir()（Windows 上是 AppData\\Roaming\\mona），
    Python 默认在 ~/.mona 找，路径不一致会导致 "邮件数据库不存在" 错误。
    """
    app_data_dir = os.environ.get("MONA_APP_DATA_DIR")
    if app_data_dir:
        return Path(app_data_dir) / _EMAIL_DB_FILE
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
        # 多 token LIKE：query 按空格切分，每个 token 独立匹配 subject/body_text。
        # WHERE 子句用 AND 连接（所有 token 都需命中），保证结果相关性。
        tokens = [t for t in keyword.split() if t.strip()]
        if tokens:
            token_clauses = []
            for tok in tokens:
                pat = f"%{tok}%"
                token_clauses.append("(subject LIKE ? OR body_text LIKE ?)")
                params.extend([pat, pat])
            conditions.append(f"({' AND '.join(token_clauses)})")
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
