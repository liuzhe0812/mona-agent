"""邮件 SQLite 读取层。

直接读取 Rust 侧的 email.sqlite3，提供搜索和读取能力。
只读，不写入。所有写操作通过 Rust 命令（前端调用）完成。

数据库路径优先级：
1. MONA_APP_DATA_DIR 环境变量（由 Rust gateway 启动时注入，与 Rust app_data_dir 一致）
2. get_data_dir() / "email.sqlite3"（默认 ~/.mona/email.sqlite3）
"""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any

from loguru import logger

from mona.config.paths import get_data_dir

_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


def _tokenize_query(query: str) -> list[str]:
    """查询分词：空白切分拉丁文，CJK 连续段切 2-gram。

    对齐 mona/kb/search.py 的实现，保证全项目检索分词一致。
    """
    tokens: list[str] = []
    for raw in query.split():
        if not raw.strip():
            continue
        if _CJK_RE.search(raw):
            for run in _CJK_RE.findall(raw):
                if len(run) == 1:
                    tokens.append(run.lower())
                else:
                    for i in range(len(run) - 1):
                        tokens.append(run[i : i + 2].lower())
            for part in _CJK_RE.split(raw):
                if part.strip():
                    tokens.append(part.lower())
        else:
            tokens.append(raw.lower())
    return tokens

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


def _mail_root() -> Path:
    """获取 mail 目录路径（与 Rust mail_root 一致）。"""
    app_data_dir = os.environ.get("MONA_APP_DATA_DIR")
    if app_data_dir:
        return Path(app_data_dir) / "mail"
    return get_data_dir() / "mail"


def _read_eml_body(eml_path: str) -> tuple[str, str | None]:
    """读取 .eml 文件并解析正文。

    与 Rust 侧 extract_bodies 对齐：优先取 text/plain，其次 text/html。
    处理 GBK/GB18030 编码的邮件（charset 声明为 gb2312 但含"喆"等扩展字符时回退 gb18030）。

    Returns:
        (body_text, body_html) — body_html 可能为 None
    """
    if not eml_path:
        return ("", None)

    abs_path = _mail_root() / eml_path
    if not abs_path.exists():
        return ("", None)

    try:
        raw = abs_path.read_bytes()
    except OSError as e:
        logger.warning("读取 .eml 失败: {} {}", abs_path, e)
        return ("", None)

    import email
    from email import policy

    try:
        msg = email.message_from_bytes(raw, policy=policy.default)
    except Exception as e:
        logger.warning("解析 .eml 失败: {} {}", abs_path, e)
        return ("", None)

    body_text = ""
    body_html: str | None = None

    # 遍历 multipart，提取 text/plain 和 text/html
    for part in msg.walk():
        content_type = part.get_content_type()
        if content_type not in ("text/plain", "text/html"):
            continue
        if part.is_multipart():
            continue
        try:
            payload = part.get_payload(decode=True)
        except Exception:
            continue
        if payload is None:
            continue

        # 尝试按声明的 charset 解码，gb2312/gbk 统一回退 gb18030（含"喆"等扩展字符）
        charset = part.get_content_charset() or "utf-8"
        text: str
        try:
            if charset.lower() in ("gb2312", "gbk", "gb18030"):
                text = payload.decode("gb18030", errors="replace")
            else:
                text = payload.decode(charset, errors="replace")
        except (LookupError, UnicodeDecodeError):
            try:
                text = payload.decode("utf-8", errors="replace")
            except Exception:
                text = payload.decode("gb18030", errors="replace")

        if content_type == "text/plain" and not body_text:
            body_text = text
        elif content_type == "text/html" and body_html is None:
            body_html = text

    if len(body_text) > 50000:
        body_text = body_text[:50000]
    return (body_text, body_html)


def _row_to_message(row: sqlite3.Row) -> dict[str, Any]:
    """将数据库行转换为邮件 dict（字段名与 EmailMessage 一致，camelCase）。

    messages 表已移除 body_text/body_html/attachments_json 列（Foxmail 模式：正文存 .eml 文件）。
    bodyText/bodyHtml 置空，需要正文时通过 email_fetch_body 命令读取 .eml。
    attachments 置空，需要附件信息时同样走 fetch_body。
    """
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
        "bodyText": "",
        "bodyHtml": None,
        "hasAttachments": bool(row["has_attachments"]),
        "isRead": bool(row["is_read"]),
        "isStarred": bool(row["is_starred"]),
        "rawSize": row["raw_size"],
        "messageId": row["message_id"] if "message_id" in row.keys() else None,
        "attachments": [],
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

    所有筛选条件为可选，None 表示不筛选。keyword 在 subject 上做 LIKE（CJK bigram 分词，OR 连接）。
    有关键词时按命中 token 数 DESC + date DESC 排序；无关键词时按 date DESC 排序。

    Args:
        account_id: 限定账号
        folder: 限定文件夹
        keyword: 关键词（subject LIKE）
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
    score_clauses: list[str] = []
    score_params: list[Any] = []

    if account_id:
        conditions.append("account_id = ?")
        params.append(account_id)
    if folder:
        conditions.append("folder = ?")
        params.append(folder)
    if keyword:
        # 多 token LIKE（CJK bigram 分词）：每个 token 独立匹配 subject，OR 连接。
        # 评分 = 命中 token 数，按评分 DESC + date DESC 排序，避免 AND 过严漏召回。
        tokens = _tokenize_query(keyword)
        if tokens:
            token_clauses = []
            for tok in tokens:
                pat = f"%{tok}%"
                token_clauses.append("subject LIKE ?")
                params.append(pat)
                score_clauses.append("CASE WHEN subject LIKE ? THEN 1 ELSE 0 END")
                score_params.append(pat)
            conditions.append(f"({' OR '.join(token_clauses)})")
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

    order_clause = (
        f"({' + '.join(score_clauses)}) DESC, date DESC" if score_clauses else "date DESC"
    )
    sql = f"""
        SELECT uid, account_id, folder, subject, from_address, from_name,
               to_addresses, cc_addresses, date, has_attachments, is_read,
               is_starred, raw_size, message_id
        FROM messages
        {where_clause}
        ORDER BY {order_clause}
        LIMIT ? OFFSET ?
    """
    params.extend(score_params)
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

    logger.debug("Email search: {} results", len(results))
    return results


def get_message(
    uid: str,
    account_id: str,
    folder: str,
) -> dict[str, Any] | None:
    """读取单封邮件全文（含正文，从 .eml 文件解析）。

    Args:
        uid: 邮件 UID
        account_id: 账号 ID
        folder: 文件夹

    Returns:
        邮件 dict（含 bodyText/bodyHtml），不存在返回 None
    """
    sql = """
        SELECT uid, account_id, folder, subject, from_address, from_name,
               to_addresses, cc_addresses, date, has_attachments, is_read,
               is_starred, raw_size, message_id, eml_path
        FROM messages
        WHERE uid = ? AND account_id = ? AND folder = ?
    """

    with _connect() as conn:
        row = conn.execute(sql, [uid, account_id, folder]).fetchone()

    if row is None:
        return None

    msg = _row_to_message(row)
    eml_path = row["eml_path"] if "eml_path" in row.keys() else ""
    body_text, body_html = _read_eml_body(eml_path)
    msg["bodyText"] = body_text
    msg["bodyHtml"] = body_html
    return msg


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
