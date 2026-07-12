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


class _EmailToolBase(Tool):
    """邮件工具基类。所有邮件工具默认开启。"""

    _scopes = {"core"}
    _plugin_discoverable = True

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


@tool_parameters(
    tool_parameters_schema(
        account_id=StringSchema("限定账号 ID（可选，不填则搜索所有账号）"),
        folder=StringSchema("限定文件夹，如 INBOX、Sent（可选）"),
        keyword=StringSchema("关键词，在主题和正文中搜索（可选）"),
        from_address=StringSchema("发件人邮箱筛选，支持模糊匹配（可选）"),
        from_name=StringSchema("发件人名称筛选，支持模糊匹配（可选）"),
        date_from=StringSchema("起始日期，ISO 格式如 2025-01-01（可选）"),
        date_to=StringSchema("结束日期，ISO 格式如 2025-12-31（可选）"),
        is_read=BooleanSchema(description="已读状态筛选（可选）"),
        is_starred=BooleanSchema(description="星标状态筛选（可选）"),
        has_attachments=BooleanSchema(description="是否有附件（可选）"),
        limit=IntegerSchema(50, description="返回上限（默认 50，最大 200）", minimum=1, maximum=200),
        offset=IntegerSchema(0, description="偏移量，用于分页", minimum=0),
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
            "搜索本地邮件数据库。支持按关键词、发件人、日期范围、文件夹、"
            "已读/星标状态等条件筛选。返回邮件列表（不含正文，节省 token），"
            "每封邮件附带一个 #mona-email: 链接。"
            "重要：在回复中引用邮件时，必须用 [显示文字](链接) 格式的 markdown 链接，"
            "链接直接使用工具返回的 #mona-email:... 格式，"
            "用户点击后会在新窗口预览邮件内容。不要只输出 UID 或纯文本。"
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
            allowed, is_all = _read_email_scope()
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
        lines.extend([
            f"日期: {msg['date']}",
            f"文件夹: {msg['folder']}",
            f"已读: {'是' if msg['isRead'] else '否'}",
            f"星标: {'是' if msg['isStarred'] else '否'}",
            f"附件: {'有' if msg['hasAttachments'] else '无'}",
            "",
            "--- 正文 ---",
            msg.get("bodyText") or "(无正文)",
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
