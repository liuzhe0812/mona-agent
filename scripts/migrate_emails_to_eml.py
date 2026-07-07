#!/usr/bin/env python3
"""邮件存储迁移脚本：从旧 SQLite（body_text 内嵌）迁移到 Foxmail 风格（.eml 文件 + 索引）。

用法：
    python scripts/migrate_emails_to_eml.py

功能：
1. 检测 email.sqlite3 是否存在 body_text 列（旧 schema）
2. 为每封有 body_text 的邮件重建 RFC822 .eml 文件
3. 在 messages 表新增 eml_path 列，写入 .eml 相对路径
4. 将 body_fetched 置为 1（标记已落盘）

注意：必须在启动新版 Mona 之前运行此脚本。新版 schema 迁移会丢弃 body_text 列，
届时将无法从本地重建 .eml。

如果 body_text 列已不存在（schema 已迁移），脚本会提示并退出。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

# ---------------------------------------------------------------------------
# 路径常量（与 Rust 侧 settings.rs 保持一致）
# ---------------------------------------------------------------------------

APP_DATA_DIR = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "mona"
DB_PATH = APP_DATA_DIR / "email.sqlite3"
MAIL_ROOT = APP_DATA_DIR / "mail"


def sanitize_path_segment(s: str) -> str:
    """与 Rust 侧 sanitize_path_segment 保持一致：替换文件系统非法字符为下划线。"""
    return "".join("_" if c in '/\\:*?"<>|' else c for c in s).strip()


def eml_relative_path(account_id: str, folder: str, uid: str) -> str:
    return f"{sanitize_path_segment(account_id)}/{sanitize_path_segment(folder)}/{sanitize_path_segment(uid)}.eml"


def eml_absolute_path(relative_path: str) -> Path:
    return MAIL_ROOT / relative_path


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cur = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cur.fetchall())


def reconstruct_eml(row: sqlite3.Row) -> bytes:
    """从 SQLite 记录重建 RFC822 .eml 字节。

    重建的 .eml 包含基本头字段 + text/plain + text/html。
    原始邮件中的附件内容未存储在 SQLite，无法恢复。
    """
    msg = EmailMessage()

    subject = row["subject"] or ""
    from_addr = row["from_address"] or ""
    to_addr = row["to_addresses"] or ""
    cc_addr = row["cc_addresses"] or "" if "cc_addresses" in row.keys() else ""
    date_str = row["date"] or ""
    message_id = row["message_id"] if "message_id" in row.keys() and row["message_id"] else None

    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    if cc_addr:
        msg["Cc"] = cc_addr
    if date_str:
        msg["Date"] = date_str
    else:
        msg["Date"] = formatdate(localtime=True)
    if message_id:
        msg["Message-ID"] = message_id
    else:
        msg["Message-ID"] = make_msgid()

    body_text = row["body_text"] if "body_text" in row.keys() else None
    body_html = row["body_html"] if "body_html" in row.keys() else None

    if body_html:
        # 多部分消息：text/plain + text/html
        msg.set_content(body_text or "")
        msg.add_alternative(body_html, subtype="html")
    elif body_text:
        msg.set_content(body_text)
    else:
        msg.set_content("")

    return msg.as_bytes()


def main() -> int:
    if not DB_PATH.exists():
        print(f"[错误] 数据库文件不存在: {DB_PATH}")
        print("请确认 Mona 已运行过至少一次（会自动创建 email.sqlite3）")
        return 1

    if not column_exists_sqlite_check():
        return 1

    print(f"[信息] 数据库路径: {DB_PATH}")
    print(f"[信息] 邮件根目录: {MAIL_ROOT}")
    print()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # 检查 body_text 列是否存在（旧 schema）
    has_body_text = column_exists(conn, "messages", "body_text")
    if not has_body_text:
        print("[警告] messages 表没有 body_text 列。")
        print("       可能已经执行过新版 schema 迁移（body_text 已被丢弃）。")
        print("       .eml 文件无法从本地重建，需要从 IMAP 重新拉取。")
        print("       新版 Mona 在用户点击邮件时会自动拉取并落盘 .eml，无需手动迁移。")
        conn.close()
        return 0

    # 确保 eml_path 列存在
    if not column_exists(conn, "messages", "eml_path"):
        print("[信息] 添加 eml_path 列到 messages 表...")
        conn.execute("ALTER TABLE messages ADD COLUMN eml_path TEXT NOT NULL DEFAULT ''")
        conn.commit()

    # 查询所有有 body_text 的邮件
    total = conn.execute(
        "SELECT COUNT(*) FROM messages WHERE body_text IS NOT NULL AND body_text != ''"
    ).fetchone()[0]
    already_migrated = conn.execute(
        "SELECT COUNT(*) FROM messages WHERE eml_path != ''"
    ).fetchone()[0]
    print(f"[信息] 有 body_text 的邮件总数: {total}")
    print(f"[信息] 已有 eml_path 的邮件数: {already_migrated}")
    print()

    if total == 0:
        print("[完成] 没有需要迁移的邮件。")
        conn.close()
        return 0

    # 分批查询并迁移
    batch_size = 200
    migrated = 0
    failed = 0
    cursor = conn.execute(
        "SELECT account_id, folder, uid, subject, from_address, to_addresses, "
        "cc_addresses, date, message_id, body_text, body_html, eml_path "
        "FROM messages WHERE body_text IS NOT NULL AND body_text != '' "
        "AND (eml_path IS NULL OR eml_path = '')"
    )

    for row in cursor:
        account_id = row["account_id"]
        folder = row["folder"]
        uid = row["uid"]
        if not account_id or not folder or not uid:
            print(f"[跳过] 缺少关键字段: account={account_id} folder={folder} uid={uid}")
            failed += 1
            continue

        try:
            eml_bytes = reconstruct_eml(row)
            rel_path = eml_relative_path(account_id, folder, uid)
            abs_path = eml_absolute_path(rel_path)
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            abs_path.write_bytes(eml_bytes)

            conn.execute(
                "UPDATE messages SET eml_path = ?1, body_fetched = 1 "
                "WHERE uid = ?2 AND account_id = ?3 AND folder = ?4",
                (rel_path, uid, account_id, folder),
            )
            migrated += 1
            if migrated % 50 == 0:
                conn.commit()
                print(f"  已迁移 {migrated}/{total}...")
        except Exception as e:
            print(f"[失败] account={account_id} folder={folder} uid={uid}: {e}")
            failed += 1

    conn.commit()
    conn.close()

    print()
    print("=" * 60)
    print(f"[完成] 迁移成功: {migrated}")
    print(f"[完成] 迁移失败: {failed}")
    print(f"[完成] .eml 文件目录: {MAIL_ROOT}")
    print()
    print("下一步：")
    print("  1. 启动新版 Mona，schema 迁移会自动处理表结构")
    print("  2. body_text 列将被丢弃（数据已迁移到 .eml 文件）")
    print("  3. 点击邮件时会优先读取本地 .eml，未落盘的邮件会自动从 IMAP 拉取")
    return 0


def column_exists_sqlite_check() -> bool:
    """检查数据库是否能正常打开（版本兼容性）。"""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute("SELECT 1 FROM messages LIMIT 1")
        conn.close()
        return True
    except sqlite3.OperationalError as e:
        print(f"[错误] 无法读取 messages 表: {e}")
        print("       请确认 Mona 已关闭，数据库未被锁定。")
        return False
    except Exception as e:
        print(f"[错误] 打开数据库失败: {e}")
        return False


if __name__ == "__main__":
    sys.exit(main())
