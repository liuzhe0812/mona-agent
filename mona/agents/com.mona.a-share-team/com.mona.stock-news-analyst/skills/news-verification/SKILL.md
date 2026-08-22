---
name: news-verification
description: Verify announcements and news by source quality, timing, cross-checking and fact-versus-opinion separation.
---

# 资讯核验

先用 `stock_evidence_read`，传入
`sections=["industry_context", "policy_context", "cycle_context", "event_calendar"]`，读取带来源记录的四个分区及公告和新闻；需要原文时只用
`stock_source_open` 打开当前运行的 `source_id`。不得把模型记忆、搜索摘要或无来源
传闻写成事实。

## 核验顺序

1. 以 `research_cutoff_at` 过滤未来发布或时间异常的记录，并将其与
   `market_as_of` 分开记录。
2. 来源分级：监管/交易所/公司披露 > 主流财经媒体 > 自媒体/论坛；低等级来源
   只能作为“未经证实”的风险提示。
3. 同一事件合并多来源，保留全部 `source_id`；来源冲突要分别陈述。
4. 分离事实、来源原文可支持的影响判断和仍待验证的推断，标注事件持续性。

## 输出约束

按影响和时效排序，把事件写入 `event_calendar`，政策/行业/周期判断分别写入对应命名数组。每个 point 声明 `claim_type`：事实带 `source_ids`，
推断带 `source_ids` 和 `basis`，假设只进入待验证问题；没有可核验资讯时仍提交
`stance=insufficient_data` 并说明本期缺失，不用“无消息=利好/利空”。不得因缺失
数据补写因果、WACC、目标价或确定性价格/比例门槛。
