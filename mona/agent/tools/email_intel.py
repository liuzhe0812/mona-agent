"""邮件 Agent 工具：搜索、读取、批量操作。

设计原则（对齐 notes 工具）：
- 所有工具默认开启，无需配置
- email_action 只返回操作建议，由前端确认后执行，AI 不会自动执行
- 不包含 email_send，现阶段不允许 AI 自动回复邮件

工具自动被 ToolLoader 发现注册，无需修改 loop.py。
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ToolContext
from mona.agent.tools.schema import (
    ArraySchema,
    BooleanSchema,
    IntegerSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)

# ---------------------------------------------------------------------------
# Gateway URL helper (lightweight, cached) for Tauri IPC calls
# ---------------------------------------------------------------------------

_gateway_url_cache: str | None = None


def _get_gateway_url() -> str:
    """获取 gateway HTTP 地址（轻量读 config.json，模块级缓存）。"""
    global _gateway_url_cache
    if _gateway_url_cache:
        return _gateway_url_cache
    port = 17173  # 默认端口
    try:
        from mona.config.loader import get_config_path

        path = get_config_path()
        if path.exists():
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            port = int(data.get("gateway", {}).get("port", port))
    except Exception as e:  # noqa: BLE001
        logger.debug("Failed to read gateway port from config, using default: {}", e)
    _gateway_url_cache = f"http://127.0.0.1:{port}"
    return _gateway_url_cache


def _fetch_body_via_tauri(account_id: str, uid: str, folder: str) -> str:
    """通过 Tauri IPC 调用 email_fetch_body 命令补全邮件正文。

    Rust 侧 email_fetch_body 会：
    1. 先尝试本地 .eml 解析（body_fetched=0 时为空）
    2. 本地为空则回退 IMAP 拉完整 RFC822，落盘 .eml 并返回正文

    返回纯文本正文（优先 text/plain，为空时从 HTML 提取）。
    失败时返回空字符串（由调用方处理）。
    """
    from mona.agent.tools.tauri_ipc import tauri_invoke

    result = tauri_invoke(
        "email_fetch_body",
        {
            "gatewayUrl": _get_gateway_url(),
            "accountId": account_id,
            "uid": uid,
            "mailbox": folder,
        },
    )
    if not isinstance(result, dict):
        return ""
    body_text = result.get("bodyText") or ""
    if body_text:
        return body_text
    body_html = result.get("bodyHtml") or ""
    if body_html:
        from mona.email_intel.analyze import _html_to_text

        return _html_to_text(body_html)
    return ""


async def _fetch_body_via_tauri_async(account_id: str, uid: str, folder: str) -> str:
    """Async counterpart that keeps the IPC request cancellable by the loop."""
    from mona.agent.tools.tauri_ipc import tauri_invoke_async

    result = await tauri_invoke_async(
        "email_fetch_body",
        {
            "gatewayUrl": _get_gateway_url(),
            "accountId": account_id,
            "uid": uid,
            "mailbox": folder,
        },
    )
    if not isinstance(result, dict):
        return ""
    body_text = result.get("bodyText") or ""
    if body_text:
        return body_text
    body_html = result.get("bodyHtml") or ""
    if body_html:
        from mona.email_intel.analyze import _html_to_text

        return _html_to_text(body_html)
    return ""


class _EmailToolBase(Tool):
    """邮件工具基类。所有邮件工具默认开启。"""

    _scopes = {"core"}
    _plugin_discoverable = True
    # All email tools (search/read/action) require an active subscription.
    subscription_required = True

    @classmethod
    def enabled(cls, ctx: ToolContext) -> bool:
        return True

    @classmethod
    def create(cls, ctx: ToolContext) -> Tool:
        return cls()


def _read_email_scope() -> tuple[set[str], bool]:
    """读取全局 Agent 搜索范围中邮件的配置。

    返回 (allowed_folders, is_all)：
    - is_all=True 表示全部允许，allowed_folders 为空集（调用方应跳过过滤）。
    - is_all=False 时 allowed_folders 为允许集合（可能为空，表示全部不允许）。
    """
    try:
        from mona.agent.tools.tauri_ipc import tauri_invoke

        scope = tauri_invoke("get_agent_search_scope")
        if isinstance(scope, dict):
            email_scope = scope.get("email") or {}
            mode = str(email_scope.get("mode") or "all").lower()
            folders = email_scope.get("allowedFolders") or []
            if mode == "all":
                return set(), True
            if mode == "none":
                return set(), False
            # specific
            return {str(f) for f in folders}, False
    except Exception as e:
        logger.debug(f"[email_search] could not load email scope: {e}")
    return set(), True


async def _read_email_scope_async() -> tuple[set[str], bool]:
    """Async counterpart that avoids blocking the agent event loop."""
    try:
        from mona.agent.tools.tauri_ipc import tauri_invoke_async

        scope = await tauri_invoke_async("get_agent_search_scope")
        if isinstance(scope, dict):
            email_scope = scope.get("email") or {}
            mode = str(email_scope.get("mode") or "all").lower()
            folders = email_scope.get("allowedFolders") or []
            if mode == "all":
                return set(), True
            if mode == "none":
                return set(), False
            return {str(f) for f in folders}, False
    except Exception as e:
        logger.debug(f"[email_search] could not load email scope: {e}")
    return set(), True


@tool_parameters(
    tool_parameters_schema(
        account_id=StringSchema("Account ID; omit for all"),
        folder=StringSchema("Mailbox, e.g. INBOX or Sent"),
        keyword=StringSchema("Subject/body keyword"),
        from_address=StringSchema("Fuzzy sender address"),
        from_name=StringSchema("Fuzzy sender name"),
        date_from=StringSchema("ISO start date, e.g. 2025-01-01"),
        date_to=StringSchema("ISO end date, e.g. 2025-12-31"),
        is_read=BooleanSchema(description="Filter read state"),
        is_starred=BooleanSchema(description="Filter starred state"),
        has_attachments=BooleanSchema(description="Filter attachments"),
        limit=IntegerSchema(50, description="Result limit (default 50, max 200)", minimum=1, maximum=200),
        offset=IntegerSchema(0, description="Pagination offset", minimum=0),
    )
)
class EmailSearchTool(_EmailToolBase):
    """搜索邮件。支持关键词、发件人、日期、文件夹等多条件筛选。"""

    @property
    def name(self) -> str:
        return "email_search"

    @property
    def description(self) -> str:
        return (
            "Search local email by text, sender, date, mailbox, or state. Results omit "
            "bodies and include #mona-email links. Cite email as "
            "[label](#mona-email:...) so it opens in Mona; never cite only a UID."
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
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
        **kwargs: Any,
    ) -> str:
        from mona.email_intel.db import search_messages

        try:
            results = search_messages(
                account_id=account_id,
                folder=folder,
                keyword=keyword,
                from_address=from_address,
                from_name=from_name,
                date_from=date_from,
                date_to=date_to,
                is_read=is_read,
                is_starred=is_starred,
                has_attachments=has_attachments,
                limit=limit,
                offset=offset,
            )
        except Exception as e:
            logger.exception("email_search failed")
            return f"Error: 搜索邮件失败 - {e}"

        # Apply Agent search scope.
        # If the user explicitly specified a folder, respect that choice (even if
        # the folder is not in the allowed list). Otherwise, filter to allowed folders.
        if not folder:
            allowed, is_all = await _read_email_scope_async()
            if not is_all:
                results = [m for m in results if m.get("folder") in allowed]

        if not results:
            return "未找到匹配的邮件。"

        # 格式化为易读的文本
        lines = [f"找到 {len(results)} 封邮件：\n"]
        for i, msg in enumerate(results, 1):
            read_mark = " " if msg["isRead"] else "●"
            star = "★" if msg["isStarred"] else " "
            attach = "📎" if msg["hasAttachments"] else " "
            # 生成可点击的邮件链接，用 hash 锚点格式（sanitize 不会剥离）
            # 参数需 URL 编码，避免中文 folder 导致 markdown 解析失败
            link = (
                f"#mona-email:accountId={quote(msg['accountId'], safe='')}"
                f"&uid={quote(str(msg['uid']), safe='')}"
                f"&folder={quote(msg['folder'], safe='')}"
            )
            lines.append(
                f"{i}. [{read_mark}{star}{attach}] {msg['subject']}\n"
                f"   发件人: {msg.get('fromName') or msg['fromAddress']} <{msg['fromAddress']}>\n"
                f"   日期: {msg['date']}\n"
                f"   文件夹: {msg['folder']}\n"
                f"   UID: {msg['uid']} | 账号: {msg['accountId']}\n"
                f"   链接: {link}"
            )
        lines.append(
            "\n提示：在回复中引用邮件时，用 [显示文字](链接) 格式的 markdown 链接，"
            "链接直接使用上面的 #mona-email:... 格式，"
            "用户点击后会在新窗口预览邮件内容。"
        )
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        uid=StringSchema("邮件 UID"),
        account_id=StringSchema("账号 ID"),
        folder=StringSchema("文件夹"),
        include_analysis=BooleanSchema(
            description="是否同时返回 AI 分析结果（如果已分析过）", default=True
        ),
    )
)
class EmailReadTool(_EmailToolBase):
    """读取单封邮件全文及 AI 分析结果。"""

    @property
    def name(self) -> str:
        return "email_read"

    @property
    def description(self) -> str:
        return (
            "读取单封邮件的完整内容（主题、发件人、正文等），末尾返回一个 #mona-email: 链接。"
            "如果邮件已被 AI 分析过，同时返回分析结果（摘要、分类、意图等）。"
            "先用 email_search 找到邮件，再用本工具读取全文。"
            "重要：回复用户时，必须用 [显示文字](链接) 格式输出邮件链接，"
            "链接直接使用工具返回的 #mona-email:... 格式，"
            "让用户点击后在新窗口预览。不要只复述正文内容。"
        )

    @property
    def read_only(self) -> bool:
        return True

    async def execute(
        self,
        uid: str,
        account_id: str,
        folder: str,
        include_analysis: bool = True,
        **kwargs: Any,
    ) -> str:
        from mona.email_intel.db import get_analysis, get_message

        try:
            msg = get_message(uid, account_id, folder)
        except Exception as e:
            logger.exception("email_read failed")
            return f"Error: 读取邮件失败 - {e}"

        if msg is None:
            return f"未找到邮件: uid={uid}, account_id={account_id}, folder={folder}"

        lines = [
            f"主题: {msg['subject']}",
            f"发件人: {msg.get('fromName') or ''} <{msg['fromAddress']}>",
            f"收件人: {msg['toAddresses']}",
        ]
        if msg.get("ccAddresses"):
            lines.append(f"抄送: {msg['ccAddresses']}")

        # 正文：优先 text/plain，为空时从 HTML 提取纯文本（很多邮件只有 HTML part）
        body = msg.get("bodyText") or ""
        body_html = msg.get("bodyHtml") or ""
        if not body and body_html:
            from mona.email_intel.analyze import _html_to_text

            body = _html_to_text(body_html)

        # 同步时只拉 HEADER 落盘 .eml（省流量），用户未点开的邮件 body_fetched=0，
        # 本地 .eml 没有正文。此处检测到正文为空时，通过 Tauri IPC 触发
        # email_fetch_body 命令：Rust 侧会自动回退 IMAP 拉完整 RFC822、落盘并返回正文。
        if not body:
            try:
                body = await _fetch_body_via_tauri_async(account_id, uid, folder)
            except Exception as e:  # noqa: BLE001
                logger.warning("email_read: fetch_body fallback failed for uid={}: {}", uid, e)

        lines.extend([
            f"日期: {msg['date']}",
            f"文件夹: {msg['folder']}",
            f"已读: {'是' if msg['isRead'] else '否'}",
            f"星标: {'是' if msg['isStarred'] else '否'}",
            f"附件: {'有' if msg['hasAttachments'] else '无'}",
            "",
            "--- 正文 ---",
            body or "(无正文)",
        ])

        if include_analysis:
            try:
                analysis = get_analysis(uid, account_id, folder)
            except Exception:
                analysis = None
            if analysis:
                lines.extend([
                    "",
                    "--- AI 分析 ---",
                    f"摘要: {analysis['summary']}",
                    f"分类: {analysis['category']}",
                    f"意图: {analysis['intent']}",
                    f"紧急度: {analysis['urgency']}",
                    f"情绪: {analysis['sentiment']}",
                ])

        link = (
            f"#mona-email:accountId={quote(account_id, safe='')}"
            f"&uid={quote(uid, safe='')}"
            f"&folder={quote(folder, safe='')}"
        )
        lines.extend([
            "",
            "--- 邮件链接 ---",
            link,
            "提示：回复用户时，用 [显示文字](链接) 格式引用此邮件，链接直接使用上面的 #mona-email:... 格式，用户点击后会在新窗口预览。必须输出链接，不要只复述正文。",
        ])
        return "\n".join(lines)


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "操作类型: mark_read | mark_unread | star | unstar | move | delete",
        ),
        uids=ArraySchema(
            items=ObjectSchema(properties={
                "uid": StringSchema("邮件 UID"),
                "accountId": StringSchema("账号 ID"),
                "folder": StringSchema("文件夹"),
            }),
            description="要操作的邮件列表",
        ),
        dest_folder=StringSchema("目标文件夹（仅 move 操作需要）"),
    )
)
class EmailActionTool(_EmailToolBase):
    """批量操作邮件：标记已读/未读、星标、移动、删除。

    重要：本工具不自动执行操作，只返回操作建议。
    实际操作由前端用户确认后执行。
    """

    @property
    def name(self) -> str:
        return "email_action"

    @property
    def description(self) -> str:
        return (
            "批量操作邮件：标记已读/未读、加/取消星标、移动到指定文件夹、删除。"
            "本工具返回操作建议（JSON 格式），前端用户确认后执行。"
            "AI 不会自动执行任何操作。"
        )

    @property
    def read_only(self) -> bool:
        # 虽然不自动执行，但语义上是写操作
        return False

    async def execute(
        self,
        action: str,
        uids: list[dict[str, str]],
        dest_folder: str | None = None,
        **kwargs: Any,
    ) -> str:
        valid_actions = {"mark_read", "mark_unread", "star", "unstar", "move", "delete"}
        if action not in valid_actions:
            return f"Error: 无效操作 '{action}'，支持: {', '.join(sorted(valid_actions))}"

        if not uids:
            return "Error: 邮件列表为空"

        if action == "move" and not dest_folder:
            return "Error: move 操作需要指定 dest_folder"

        # 返回操作建议，前端确认后执行
        suggestion = {
            "action": action,
            "destFolder": dest_folder,
            "messages": uids,
            "count": len(uids),
            "requires_confirmation": True,
        }

        action_labels = {
            "mark_read": "标记为已读",
            "mark_unread": "标记为未读",
            "star": "加星标",
            "unstar": "取消星标",
            "move": f"移动到 {dest_folder}",
            "delete": "删除",
        }

        lines = [
            f"操作建议（需用户确认）：{action_labels.get(action, action)} {len(uids)} 封邮件",
            "",
            "邮件列表：",
        ]
        for i, m in enumerate(uids, 1):
            lines.append(f"  {i}. uid={m.get('uid')} account={m.get('accountId')} folder={m.get('folder')}")

        lines.extend([
            "",
            "请用户在前端确认后执行。AI 不会自动执行此操作。",
            "",
            "操作详情（JSON）:",
            json.dumps(suggestion, ensure_ascii=False, indent=2),
        ])

        return "\n".join(lines)
