---
name: market-briefing
description: 根据股票研究结果整理市场、板块或用户指定标的的简报。
---

# 市场简报

将用户要求的市场、板块或标的及时间范围写入问题，通过 `stock_vibe_task` 开始研究或继续当前研究，再用 `read_research` 确认进度和结果。

只整理实际返回的变化、来源与数据时间，区分事实、可能影响、风险和未覆盖内容。研究未完成时说明进度；不虚构盘前、盘中或盘后实时数据。

需要正式简报结构时，使用 `skill_reference_read` 读取 `output-template.md`。
