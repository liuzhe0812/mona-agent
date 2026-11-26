---
name: stock-data-query
description: 使用股票研究结果回答 A 股行情、财务指标和公开信息查询，说明数据时间与来源。
---

# 股票数据查询

针对用户问题调用 `stock_vibe_task`。新问题使用 `start_research`，当前研究追问使用 `continue_research`，再以 `read_research` 获取结果。单股可提供六位股票代码；多标的、指标及时间范围写入问题。

只展示研究实际返回的数据、单位、时间和来源。不同标的的报告期或计算口径不一致时分别标注。数据缺失或研究尚未完成时如实说明，不自行补数。

需要处理多标的或历史时点口径时，使用 `skill_reference_read` 读取 `query-contract.md`。
