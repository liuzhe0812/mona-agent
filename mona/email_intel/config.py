"""邮件智能体配置。

所有开关默认关闭，符合"AI 不默认介入邮箱"红线。
"""

from __future__ import annotations

from pydantic import Field

from mona.config.schema import Base


class EmailIntelConfig(Base):
    """邮件 AI 智能体配置。

    所有开关默认关闭，用户必须主动开启。
    """

    # 总开关：启用邮件 Agent 工具（email_search / email_read / email_action）
    enabled: bool = False

    # 允许 AI 执行的操作类型（即使 enabled=true，也只允许以下显式开启的操作）
    # 注意：所有操作都需要用户在前端确认，AI 不会自动执行
    allow_search: bool = True  # 搜索是只读操作，默认允许
    allow_read: bool = True  # 读取是只读操作，默认允许
    allow_action: bool = False  # 操作类（标记/移动/删除）默认禁止，需用户开启
    allow_report: bool = True  # 日报/周报生成，默认允许
    allow_task_extract: bool = True  # 任务自动提取，默认允许

    # 搜索结果上限
    search_limit: int = Field(default=50, ge=1, le=200)
