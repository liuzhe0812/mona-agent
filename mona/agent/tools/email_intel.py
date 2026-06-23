"""邮件 Agent 工具：搜索、读取、批量操作、日报周报、任务提取。

设计原则：
- 所有开关默认关闭，需用户在配置中启用 emailIntel.enabled
- email_search / email_read 是只读操作，启用后默认可用
- email_action 不自动执行，只返回操作建议，由前端确认后执行
- email_report 生成日报/周报，使用 LLM 生成自然语言摘要
- email_extract_tasks 从邮件分析结果中提取待办，创建日程任务
- 不包含 email_send，现阶段不允许 AI 自动回复邮件

工具自动被 ToolLoader 发现注册，无需修改 loop.py。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext, ToolContext
from mona.agent.tools.schema import (
    ArraySchema,
    BooleanSchema,
    IntegerSchema,
    ObjectSchema,
    StringSchema,
    tool_parameters_schema,
)


class _EmailToolBase(Tool):
    """邮件工具基类，共享 enabled 检查。"""

    _scopes = {"core"}
    _plugin_discoverable = True

    @classmethod
    def enabled(cls, ctx: ToolContext) -> bool:
        """所有邮件工具都依赖 emailIntel.enabled 开关。"""
        config = getattr(ctx.config, "email_intel", None)
        return bool(config and config.enabled)

    @classmethod
    def create(cls, ctx: ToolContext) -> Tool:
        return cls()


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
            "已读/星标状态等条件筛选。返回邮件列表（不含正文，节省 token）。"
            "用 email_read 读取具体邮件全文。"
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

        if not results:
            return "未找到匹配的邮件。"

        # 格式化为易读的文本
        lines = [f"找到 {len(results)} 封邮件：\n"]
        for i, msg in enumerate(results, 1):
            read_mark = " " if msg["isRead"] else "●"
            star = "★" if msg["isStarred"] else " "
            attach = "📎" if msg["hasAttachments"] else " "
            lines.append(
                f"{i}. [{read_mark}{star}{attach}] {msg['subject']}\n"
                f"   发件人: {msg.get('fromName') or msg['fromAddress']} <{msg['fromAddress']}>\n"
                f"   日期: {msg['date']}\n"
                f"   文件夹: {msg['folder']}\n"
                f"   UID: {msg['uid']} | 账号: {msg['accountId']}"
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
            "读取单封邮件的完整内容（主题、发件人、正文等）。"
            "如果邮件已被 AI 分析过，同时返回分析结果（摘要、分类、意图等）。"
            "先用 email_search 找到邮件，再用本工具读取全文。"
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

    @classmethod
    def enabled(cls, ctx: ToolContext) -> bool:
        """email_action 需要额外开启 allow_action。"""
        config = getattr(ctx.config, "email_intel", None)
        return bool(config and config.enabled and config.allow_action)

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


# ── 日报/周报 ──────────────────────────────────────────────────────────────

_DAILY_REPORT_PROMPT = """你是一个邮件助手。请根据以下邮件统计数据，生成一份简洁的中文日报。

日期：{date}
收到邮件：{received_count} 封
未读：{unread_count} 封
需要处理：{needs_action_count} 封

主要发件人：
{top_senders}

重要邮件：
{important_emails}

请按以下格式输出（不要包含 JSON 标记）：
1. 一句话概述今天的邮件情况
2. 列出需要重点关注的邮件（最多 3 封），说明为什么重要
3. 建议优先处理的事项
"""

_WEEKLY_REPORT_PROMPT = """你是一个邮件助手。请根据以下本周邮件统计数据，生成一份简洁的中文周报。

周期：{date_from} 至 {date_to}
收到邮件：{received_count} 封
发送邮件：{sent_count} 封
未读：{unread_count} 封
未回复（需处理）：{unreplied_count} 封

主要发件人：
{top_senders}

重要邮件：
{important_emails}

请按以下格式输出（不要包含 JSON 标记）：
1. 一句话概述本周的邮件情况
2. 本周邮件趋势分析（收到/发送对比）
3. 需要跟进的未回复邮件（最多 5 封）
4. 下周建议关注的事项
"""


@tool_parameters(
    tool_parameters_schema(
        report_type=StringSchema(
            "报告类型: daily（日报）或 weekly（周报）",
            enum=["daily", "weekly"],
        ),
        date=StringSchema(
            "日报的日期（ISO 格式如 2026-06-20），不填则默认昨天。周报忽略此参数，自动取本周一到周日。",
        ),
    )
)
class EmailReportTool(_EmailToolBase):
    """生成邮件日报或周报。"""

    @property
    def name(self) -> str:
        return "email_report"

    @property
    def description(self) -> str:
        return (
            "生成邮件日报或周报。日报统计指定日期的邮件情况，"
            "周报统计本周的邮件趋势。使用 LLM 生成自然语言摘要。"
            "适合定时任务调用，如每天早上生成昨天的日报。"
        )

    @property
    def read_only(self) -> bool:
        return True

    @classmethod
    def enabled(cls, ctx: ToolContext) -> bool:
        config = getattr(ctx.config, "email_intel", None)
        return bool(config and config.enabled and getattr(config, "allow_report", True))

    @classmethod
    def create(cls, ctx: ToolContext) -> Tool:
        tool = cls()
        tool._ctx = ctx  # type: ignore[attr-defined]
        return tool

    async def execute(
        self,
        report_type: str = "daily",
        date: str | None = None,
        **kwargs: Any,
    ) -> str:
        from mona.email_intel.db import get_daily_stats, get_weekly_stats

        # 确定日期范围
        now = datetime.now()
        if report_type == "daily":
            if date:
                target_date = date[:10]
            else:
                target_date = (now - timedelta(days=1)).strftime("%Y-%m-%d")
            try:
                stats = get_daily_stats(target_date)
            except Exception as e:
                logger.exception("email_report daily failed")
                return f"Error: 获取日报数据失败 - {e}"

            top_senders_text = "\n".join(
                f"  - {s['name']} ({s['address']}): {s['count']} 封"
                for s in stats["topSenders"]
            ) or "  (无)"

            important_text = "\n".join(
                f"  - {e['subject']} (来自 {e.get('fromName') or e['fromAddress']}, {e['date']})"
                for e in stats["importantEmails"]
            ) or "  (无)"

            prompt = _DAILY_REPORT_PROMPT.format(
                date=stats["date"],
                received_count=stats["receivedCount"],
                unread_count=stats["unreadCount"],
                needs_action_count=stats["needsActionCount"],
                top_senders=top_senders_text,
                important_emails=important_text,
            )
        else:
            # 周报：本周一到今天
            today = now.date()
            monday = today - timedelta(days=today.weekday())
            sunday = monday + timedelta(days=6)
            date_from = monday.strftime("%Y-%m-%d")
            date_to = sunday.strftime("%Y-%m-%d")
            try:
                stats = get_weekly_stats(date_from, date_to)
            except Exception as e:
                logger.exception("email_report weekly failed")
                return f"Error: 获取周报数据失败 - {e}"

            top_senders_text = "\n".join(
                f"  - {s['name']} ({s['address']}): {s['count']} 封"
                for s in stats["topSenders"]
            ) or "  (无)"

            important_text = "\n".join(
                f"  - {e['subject']} (来自 {e.get('fromName') or e['fromAddress']}, {e['date']})"
                f"  摘要: {e.get('summary', '(无)')}"
                for e in stats["importantEmails"]
            ) or "  (无)"

            prompt = _WEEKLY_REPORT_PROMPT.format(
                date_from=stats["dateFrom"],
                date_to=stats["dateTo"],
                received_count=stats["receivedCount"],
                sent_count=stats["sentCount"],
                unread_count=stats["unreadCount"],
                unreplied_count=stats["unrepliedCount"],
                top_senders=top_senders_text,
                important_emails=important_text,
            )

        # 调用 LLM 生成报告
        ctx: ToolContext = self._ctx  # type: ignore[attr-defined]
        if not ctx.provider_snapshot_loader:
            return "Error: LLM provider 不可用"

        try:
            snapshot = ctx.provider_snapshot_loader()
            provider = snapshot.provider
            model = snapshot.model

            response = await provider.chat(
                messages=[{"role": "user", "content": prompt}],
                model=model,
                max_tokens=1024,
                temperature=0.3,
            )

            report_text = response.content or "(生成失败)"

            # 附上原始统计数据
            header = f"📊 邮件{'日' if report_type == 'daily' else '周'}报\n{'=' * 40}\n\n"
            return header + report_text

        except Exception as e:
            logger.exception("email_report LLM call failed")
            return f"Error: 生成报告失败 - {e}"


# ── 任务自动提取 ────────────────────────────────────────────────────────────

@tool_parameters(
    tool_parameters_schema(
        account_id=StringSchema("限定账号 ID（可选，不填则扫描所有账号）"),
        limit=IntegerSchema(20, description="扫描邮件上限（默认 20）", minimum=1, maximum=100),
    )
)
class EmailTaskExtractTool(_EmailToolBase, ContextAware):
    """从邮件分析结果中提取待办任务，自动创建日程项。"""

    def __init__(self) -> None:
        self._ctx: ToolContext | None = None
        self._chat_id: str = ""

    @property
    def name(self) -> str:
        return "email_extract_tasks"

    @property
    def description(self) -> str:
        return (
            "从已分析的邮件中提取待办事项（截止日期），自动创建日程任务。"
            "扫描邮件 AI 分析结果中的 deadlines 字段，为每个截止日期创建一条日程。"
            "适合在邮件分析后调用，或定时扫描提取任务。"
        )

    @property
    def read_only(self) -> bool:
        return False

    @classmethod
    def enabled(cls, ctx: ToolContext) -> bool:
        config = getattr(ctx.config, "email_intel", None)
        return bool(
            config
            and config.enabled
            and getattr(config, "allow_task_extract", True)
            and ctx.schedule_service is not None
        )

    @classmethod
    def create(cls, ctx: ToolContext) -> Tool:
        tool = cls()
        tool._ctx = ctx  # type: ignore[attr-defined]
        return tool

    def set_context(self, ctx: RequestContext) -> None:
        self._chat_id = ctx.chat_id

    async def execute(
        self,
        account_id: str | None = None,
        limit: int = 20,
        **kwargs: Any,
    ) -> str:
        from mona.email_intel.db import get_emails_with_deadlines
        from mona.schedule import ScheduleItem, create_schedule_item_id

        ctx: ToolContext = self._ctx  # type: ignore[attr-defined]
        if not ctx.schedule_service:
            return "Error: 日程服务不可用"

        try:
            emails = get_emails_with_deadlines(account_id=account_id, limit=limit)
        except Exception as e:
            logger.exception("email_extract_tasks query failed")
            return f"Error: 查询邮件待办失败 - {e}"

        if not emails:
            return "未找到含截止日期的邮件。请先对邮件进行内容分析。"

        created_items: list[str] = []
        skipped = 0
        now_ms = int(datetime.now().timestamp() * 1000)

        # 获取已有日程标题，避免重复创建
        existing_items = await ctx.schedule_service.list_items()
        existing_titles = {
            it.title for it in existing_items if it.source_module == "email_task"
        }

        for email in emails:
            for deadline in email.get("deadlines", []):
                task_desc = deadline.get("task", "").strip()
                deadline_date = deadline.get("date", "").strip()
                if not task_desc:
                    continue

                title = f"邮件待办: {task_desc}"
                if title in existing_titles:
                    skipped += 1
                    continue

                # 尝试解析截止日期
                start_ms = now_ms
                try:
                    # 尝试 ISO 格式
                    if deadline_date:
                        dt = datetime.fromisoformat(deadline_date)
                        start_ms = int(dt.timestamp() * 1000)
                except (ValueError, TypeError):
                    # 自然语言日期无法解析，用当前时间占位
                    pass

                description = (
                    f"来源邮件: {email['subject']}\n"
                    f"发件人: {email.get('fromName') or email['fromAddress']}\n"
                    f"邮件日期: {email['date']}\n"
                    f"截止日期: {deadline_date}\n"
                    f"邮件摘要: {email.get('summary', '(无)')}"
                )

                item = ScheduleItem(
                    id=create_schedule_item_id(),
                    title=title,
                    start_at_ms=start_ms,
                    description=description,
                    kind="personal",
                    source_module="email_task",
                    source_chat_id=self._chat_id or None,
                    color="orange",
                )
                try:
                    saved = await ctx.schedule_service.add_item(item)
                    created_items.append(f"  - {saved.title} (截止: {deadline_date})")
                except Exception as e:
                    logger.warning("Failed to create schedule item: {}", e)
                    skipped += 1

        if not created_items:
            return f"没有新任务需要创建（跳过 {skipped} 个已存在的任务）。"

        lines = [
            f"从 {len(emails)} 封邮件中提取了 {len(created_items)} 个待办任务，已创建日程：",
            "",
            *created_items,
        ]
        if skipped:
            lines.append(f"\n（跳过 {skipped} 个已存在的任务）")
        return "\n".join(lines)


# ── 自动归档 ────────────────────────────────────────────────────────────────

_ARCHIVE_PROMPT = """你是一个邮件归档助手。请根据每封邮件的内容，决定它应该归入哪个文件夹。

现有文件夹列表：
{existing_folders}

待归档邮件：
{emails_json}

请为每封邮件选择最合适的归档目标文件夹。规则：
1. 优先归入现有文件夹中语义最匹配的
2. 如果没有合适的现有文件夹{allow_create_hint}，则归入"其他"
3. 返回 JSON 数组，每个元素包含 uid、accountId、folder（源文件夹）、destFolder（目标文件夹）

返回格式（只返回 JSON，不要包含 ```json 标记）：
[
  {{"uid": "...", "accountId": "...", "folder": "...", "destFolder": "..."}}
]
"""


@tool_parameters(
    tool_parameters_schema(
        account_id=StringSchema("限定账号 ID（可选，不填则处理所有账号）"),
        folder=StringSchema("源文件夹（默认 INBOX）"),
        limit=IntegerSchema(50, description="单次处理邮件上限（默认 50）", minimum=1, maximum=200),
        allow_create_folder=BooleanSchema(
            description="允许 AI 自动创建新文件夹。默认 false，不匹配的邮件归入「其他」文件夹。",
        ),
    )
)
class EmailAutoArchiveTool(_EmailToolBase, ContextAware):
    """AI 智能归档邮件：读取邮件内容，自动归入最合适的文件夹。"""

    def __init__(self) -> None:
        self._ctx: ToolContext | None = None
        self._chat_id: str = ""

    @property
    def name(self) -> str:
        return "email_auto_archive"

    @property
    def description(self) -> str:
        return (
            "AI 读取邮件内容（摘要、分类、意图等），智能判断每封邮件应归入的文件夹。"
            "返回 move 操作建议（需用户确认）。"
            "例如：发票归入「财务」，会议纪要归入「项目A」，通知归入「通知」。"
        )

    @property
    def read_only(self) -> bool:
        return False

    @classmethod
    def enabled(cls, ctx: ToolContext) -> bool:
        config = getattr(ctx.config, "email_intel", None)
        return bool(config and config.enabled and getattr(config, "allow_action", False))

    @classmethod
    def create(cls, ctx: ToolContext) -> Tool:
        tool = cls()
        tool._ctx = ctx  # type: ignore[attr-defined]
        return tool

    def set_context(self, ctx: RequestContext) -> None:
        self._chat_id = ctx.chat_id

    async def execute(
        self,
        account_id: str | None = None,
        folder: str = "INBOX",
        limit: int = 50,
        allow_create_folder: bool = False,
        **kwargs: Any,
    ) -> str:
        from mona.email_intel.db import _connect, list_accounts, list_folders

        ctx: ToolContext = self._ctx  # type: ignore[attr-defined]

        # 收集所有账号
        if account_id:
            accounts = [{"accountId": account_id}]
        else:
            try:
                accounts = list_accounts()
            except Exception as e:
                return f"Error: 获取账号列表失败 - {e}"

        if not accounts:
            return "未找到任何邮件账号。"

        # 收集所有账号的已有文件夹
        all_folders: set[str] = set()
        account_folders: dict[str, set[str]] = {}
        for acct in accounts:
            aid = acct["accountId"]
            try:
                folders = {f["folder"] for f in list_folders(aid)}
            except Exception:
                folders = set()
            account_folders[aid] = folders
            all_folders |= folders

        # 查询已分析的邮件
        emails_to_archive: list[dict[str, Any]] = []
        for acct in accounts:
            aid = acct["accountId"]
            sql = """
                SELECT m.uid, m.account_id, m.folder, m.subject, m.from_name,
                       m.from_address, m.date, a.category, a.intent, a.summary
                FROM messages m
                JOIN email_ai_analysis a
                  ON m.uid = a.uid AND m.account_id = a.account_id AND m.folder = a.folder
                WHERE m.account_id = ? AND m.folder = ?
                ORDER BY m.date DESC
                LIMIT ?
            """
            try:
                with _connect() as conn:
                    rows = conn.execute(sql, [aid, folder, limit]).fetchall()
            except Exception as e:
                logger.warning("auto_archive query failed for account %s: %s", aid, e)
                continue

            for row in rows:
                emails_to_archive.append({
                    "uid": row["uid"],
                    "accountId": row["account_id"],
                    "folder": row["folder"],
                    "subject": row["subject"],
                    "fromName": row["from_name"],
                    "fromAddress": row["from_address"],
                    "date": row["date"],
                    "category": row["category"],
                    "intent": row["intent"],
                    "summary": row["summary"],
                })

        if not emails_to_archive:
            return "没有需要归档的邮件。请先对邮件进行内容分析。"

        # 用 LLM 决定归档目标
        emails_for_llm = [
            {
                "uid": e["uid"],
                "accountId": e["accountId"],
                "folder": e["folder"],
                "subject": e["subject"],
                "from": e.get("fromName") or e["fromAddress"],
                "category": e["category"],
                "intent": e["intent"],
                "summary": e["summary"],
            }
            for e in emails_to_archive
        ]

        allow_create_hint = (
            "，可以创建新文件夹（给出新文件夹名）" if allow_create_folder else ""
        )

        prompt = _ARCHIVE_PROMPT.format(
            existing_folders=", ".join(sorted(all_folders)) or "(无)",
            emails_json=json.dumps(emails_for_llm, ensure_ascii=False, indent=2),
            allow_create_hint=allow_create_hint,
        )

        if not ctx.provider_snapshot_loader:
            return "Error: LLM provider 不可用"

        try:
            snapshot = ctx.provider_snapshot_loader()
            provider = snapshot.provider
            model = snapshot.model

            response = await provider.chat(
                messages=[{"role": "user", "content": prompt}],
                model=model,
                max_tokens=2048,
                temperature=0.2,
            )

            content = response.content or "[]"
            # 解析 LLM 返回的 JSON 数组
            text = content.strip()
            fence_match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
            if fence_match:
                text = fence_match.group(1).strip()
            try:
                archive_decisions = json.loads(text)
            except json.JSONDecodeError:
                start = text.find("[")
                end = text.rfind("]")
                if start != -1 and end != -1 and end > start:
                    archive_decisions = json.loads(text[start : end + 1])
                else:
                    raise

            if not isinstance(archive_decisions, list):
                archive_decisions = []

        except Exception as e:
            logger.exception("email_auto_archive LLM call failed")
            return f"Error: AI 归档决策失败 - {e}"

        if not archive_decisions:
            return "AI 未能生成归档建议。"

        # 构建归档计划
        archive_plan: list[dict[str, Any]] = []
        new_folders_needed: set[str] = set()
        fallback_count = 0

        for decision in archive_decisions:
            uid = decision.get("uid")
            aid = decision.get("accountId")
            src_folder = decision.get("folder")
            dest_folder = (decision.get("destFolder") or "").strip()

            if not uid or not aid or not dest_folder:
                continue

            # 查找原始邮件信息
            email_info = next(
                (e for e in emails_to_archive if e["uid"] == uid and e["accountId"] == aid),
                None,
            )
            if not email_info:
                continue

            # 源和目标相同则跳过
            if dest_folder == src_folder:
                continue

            # 检查目标文件夹是否存在
            existing = account_folders.get(aid, set())
            if dest_folder not in existing:
                if allow_create_folder:
                    new_folders_needed.add(dest_folder)
                else:
                    # 不允许创建新文件夹，归入"其他"
                    dest_folder = "其他"
                    fallback_count += 1
                    if "其他" not in existing:
                        new_folders_needed.add("其他")

            archive_plan.append({
                "uid": uid,
                "accountId": aid,
                "folder": src_folder,
                "subject": email_info["subject"],
                "fromName": email_info.get("fromName"),
                "destFolder": dest_folder,
                "category": email_info.get("category", ""),
            })

        if not archive_plan:
            return "没有需要归档的邮件。"

        # 按目标文件夹分组
        folder_counts: dict[str, int] = {}
        for item in archive_plan:
            folder_counts[item["destFolder"]] = folder_counts.get(item["destFolder"], 0) + 1

        lines = [
            f"自动归档建议：共 {len(archive_plan)} 封邮件可归档",
            "",
            "归档分布：",
        ]
        for dest, count in sorted(folder_counts.items(), key=lambda x: -x[1]):
            marker = " (新建)" if dest in new_folders_needed else ""
            lines.append(f"  → {dest}{marker}: {count} 封")

        if fallback_count > 0:
            lines.append(f"\n（{fallback_count} 封邮件未匹配到合适文件夹，归入「其他」）")

        lines.extend(["", "邮件明细："])
        for i, item in enumerate(archive_plan, 1):
            lines.append(
                f"  {i}. {item['subject']}\n"
                f"     发件人: {item.get('fromName') or '(未知)'}\n"
                f"     归档到: {item['destFolder']}"
            )

        # 生成 move 操作建议（按目标文件夹分组）
        suggestions: list[dict[str, Any]] = []
        for dest_folder in sorted(folder_counts.keys()):
            targets = [
                {"uid": item["uid"], "accountId": item["accountId"], "folder": item["folder"]}
                for item in archive_plan
                if item["destFolder"] == dest_folder
            ]
            suggestions.append({
                "action": "move",
                "destFolder": dest_folder,
                "messages": targets,
                "count": len(targets),
                "requires_confirmation": True,
                "need_create_folder": dest_folder in new_folders_needed,
            })

        lines.extend([
            "",
            "请用户在前端确认后执行。AI 不会自动执行此操作。",
            "",
            "操作详情（JSON）：",
            json.dumps(suggestions, ensure_ascii=False, indent=2),
        ])

        return "\n".join(lines)
