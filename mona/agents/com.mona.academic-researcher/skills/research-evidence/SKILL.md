---
name: research-evidence
description: 领域调研、学术检索、论文阅读、证据提取、冲突核验和知识地图整理
---

# 研究证据

## 适用范围

当用户要调研领域、查找文献、阅读一篇或多篇论文、追踪引用、比较结论、寻找研究空白、生成知识地图或形成可交付证据报告时使用本 Skill。普通简短问答不强制创建完整研究目录。

## 证据工作流

严格按以下顺序执行，必要时循环补检索：

1. 明确研究问题、对象/人群、时间范围、语言、研究类型和输出边界；不清楚时先列出假设并向用户确认关键缺口。
2. 将问题拆成可检索的概念与同义词，记录每个查询式、筛选条件、数据源、时间和结果状态。
3. 用 `academic_search` 查询适用的 OpenAlex、Crossref、Europe PMC、arXiv 或 ClinicalTrials.gov 等学术源；必要时用 `web_search` 发现官方来源，用 `web_fetch`/`http_request` 读取公开页面。不要只凭搜索摘要写结论。
4. 按 DOI、PMID/PMCID、arXiv ID、NCT ID 优先去重；没有稳定标识时按规范化标题和年份核对。保留来源类型、版本和 provider，不把预印本无依据地当作正式论文。
5. 使用 `research_record` 写入 `search_log.jsonl` 和 `sources.jsonl`。源不可用、限流或全文缺失时记录失败原因，不能改写成“没有相关研究”。
6. 对每篇关键论文提取：研究问题、设计、样本/数据、方法、统计口径、主要结果、作者结论、局限和复现信息。全文证据必须记录页码、章节、图表或表格；只有摘要时定位为 `abstract`，不得补写全文细节。
7. 为关键陈述用 `research_record` 写入 `claims.jsonl`。每条声明包含 `claim_id`、`claim_type`（`fact`/`inference`/`hypothesis`）、`claim_text`、`source_ids`、`evidence_text`、`locator`、`supports`、`limitations` 和 `verified_at`。`fact` 必须有真实来源和定位；`inference` 必须说明推理依据；`hypothesis` 必须标记待验证。
8. 主动查找反证、未复现结果、后续研究和方法差异。多视角只使用真实支持、冲突、方法差异、适用边界和开放问题；没有反方证据时说明检索范围，不生成角色扮演式反方。
9. 对知识地图使用真实节点（论文、概念、方法、数据集、假设）和真实关系（`supports`、`conflicts`、`uses`、`extends`、`gap`），每条边保留 `source_ids` 和相关 claim ID。交付 `knowledge_map.json` 和 `knowledge_map.md` 时先校验无悬空节点。
10. 综合结论时按原始论文/指南/注册/官方数据库、系统综述、机构报告、普通网页的优先级说明证据强度；冲突证据并列呈现，不能按引用数量投票。

## 记录与交付

请求深度研究或可交付成果时，研究任务目录至少包含：

```text
research/<task_id>/
  manifest.json
  search_log.jsonl
  sources.jsonl
  claims.jsonl
  knowledge_map.json       # 需要知识地图时
  knowledge_map.md          # 需要知识地图时
```

最终回答应包含：问题和范围、检索式与数据源、检索时间、去重/纳入边界、主要发现、支持与冲突证据、研究空白、全文/工具缺口和下一步。通过 `deliver_file` 交付报告、来源清单、证据表和知识地图；不要把只有模型摘要的内容伪装成已核验全文。

## 失败与诚信规则

- 学术源失败：保留 provider 错误并继续可用来源；不要声称“无相关研究”。
- 找不到全文、页码、图表或原文：明确写 `missing_reason` 或 `insufficient_evidence`，不得编造引文、页码、数值和方法细节。
- 来源冲突：并列原文和口径差异，不能选择看起来更符合用户期待的一方。
- 无法识别的图表或扫描文本：标记未确认，不猜测数字。
- 普通网页只能发现线索，不能独立支撑关键学术结论。
- 严禁编造文献、作者、日期、DOI、PMID、实验结果或“已验证”的研究空白。
