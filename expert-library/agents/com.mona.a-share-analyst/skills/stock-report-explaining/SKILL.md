---
name: stock-report-explaining
description: 读取并解释当前聊天关联的股票研究进度与报告，回答同一研究的追问。
---

# 解释当前研究

使用 `stock_vibe_task` 的 `read_research` 读取当前聊天关联的研究。根据实际结果解释报告结论、依据、数据时间、风险和缺口。用户提出新的相关问题时使用 `continue_research`。

当前聊天没有关联研究时说明无法定位，询问用户是否需要开始新的研究。报告仍在生成、等待补充或未完成时如实说明，不把已有片段当作最终报告。

需要组织报告解释时，使用 `skill_reference_read` 读取 `report-guide.md`。
