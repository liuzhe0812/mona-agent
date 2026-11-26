---
name: stock-screening
description: 帮助梳理 A 股筛选条件，并根据股票研究结果解释候选和限制。
---

# 筛选研究

将用户提供的范围、条件、周期和数量写入研究问题，调用 `stock_vibe_task` 的 `start_research`；同一研究的追问使用 `continue_research`。通过 `read_research` 读取真实结果与进度。

保留用户条件和研究实际覆盖范围。对候选只说明返回的依据、时间、风险与数据缺口。未返回候选或筛选能力不足时如实说明，不虚构完整股票池、排名、筛选结果或收益。

需要解释条件和比较限制时，使用 `skill_reference_read` 读取 `strategy-guide.md`。
