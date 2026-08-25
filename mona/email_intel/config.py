"""邮件智能体配置。

所有工具默认开启，对齐 notes 工具设计。
写操作（email_action）只返回建议，由前端确认后执行，AI 不会自动执行。
"""

from __future__ import annotations

from typing import Literal

from mona.config.schema import Base


class EmailScheduleConfig(Base):
    """邮件 AI 日程提取配置。

    配置驱动：用户可配置哪些文件夹的新邮件由 AI 自动分析生成日程。
    颗粒度到每个邮箱账号的每个文件夹（accountId:folderName 格式）。
    """

    # 总开关
    enabled: bool = False

    # 启用 AI 提取的文件夹列表，格式为 "{accountId}:{folderName}"
    # 如 ["37bd0f8c-...:INBOX", "37bd0f8c-...:会议预约"]
    # 空列表表示不启用任何文件夹（即使 enabled=True 也不触发）
    folders: list[str] = []

    # 创建模式：
    #   "auto"    —— 不进入收集箱，LLM 解析成功后直接创建日程
    #   "confirm" —— 进入计划收集箱，待用户确认后再创建日程
    create_mode: Literal["auto", "confirm"] = "confirm"

    # 提醒提前量（分钟）。仅对 personal 类型日程生效。
    # 实际日程的 start_at_ms = 邮件中提到的事件时间 - lead_minutes
    # 例如邮件说"周五下午 3 点开会"，lead_minutes=15，则日程 start_at = 周五 14:45
    lead_minutes: int = 15

    # 跳过的发件人（避免自动化邮件反复触发）
    # 匹配发件人邮箱地址，如 ["noreply.github.com", "notifications@slack.com"]
    skip_senders: list[str] = []

    # 单邮件解析超时（秒），防止 LLM 卡住整个同步流程
    parse_timeout_seconds: int = 30


class EmailIntelConfig(Base):
    """邮件 AI 智能体配置。"""

    # 搜索结果上限
    search_limit: int = 50

    # AI 日程提取配置
    schedule: EmailScheduleConfig = EmailScheduleConfig()
