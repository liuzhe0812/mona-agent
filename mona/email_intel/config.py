"""邮件智能体配置。

所有工具默认开启，对齐 notes 工具设计。
写操作（email_action）只返回建议，由前端确认后执行，AI 不会自动执行。
"""

from __future__ import annotations

from mona.config.schema import Base


class EmailIntelConfig(Base):
    """邮件 AI 智能体配置。"""

    # 搜索结果上限
    search_limit: int = 50
