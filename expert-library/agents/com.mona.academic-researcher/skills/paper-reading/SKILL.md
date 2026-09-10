---
name: paper-reading
description: 阅读、比较并提取一篇或多篇论文中的方法、结果和证据；不用于首次建立文献候选集或核验参考文献真伪
metadata:
  mona:
    runtime:
      packs:
        - python-base@3.13.15
        - python-academic@1.0.0
---

# 论文阅读与证据提取

## 适用边界

用于用户提供论文/PDF/链接，或指定已知论文，要求总结、精读、比较、提取方法与结果、整理证据表或解释局限时。只要求发现更多候选文献使用 `literature-search`；要核验 DOI、参考文献身份或论据支持关系使用 `citation-audit`。不因一次阅读请求扩展成领域综述。

用 `skill_reference_read` 先读取本 Skill 的 `resource-map.md`。全文阅读按来源格式加载 Nature Reader 资源；明确要求深度研究卡片时加载 Nature Paper Card 资源。PDF/公式/卡片质量检查使用已集成脚本，不用一次性代码替代。

## 阅读工作流

1. 先确认每篇材料的稳定标识符、版本（正式论文、修订版或预印本）、可访问范围和用户关注的问题。只读实际提供或成功获取的材料，不把搜索结果摘要当作全文。
2. 按论文原文提取：研究问题/假设、研究设计、对象或数据、纳入排除条件、变量/终点、方法与统计口径、主要结果、作者结论、局限、复现信息和利益/伦理信息（原文有记录时）。比较多篇论文时使用相同字段，保留人群、数据、方法和终点差异。
3. 每一项事实都保留证据定位。全文证据记录页码、章节、段落、图、表或补充材料；只有摘要时使用 `locator.kind=abstract`，明确“仅摘要可得”。无法定位原文的内容标为 `insufficient_evidence`，不得补写页码、数值、方法细节或作者未说过的结论。
4. 区分作者陈述、文中报告的事实、Agent 推断和待验证假设。推断必须说明依据和替代解释，假设保持待验证；不同论文冲突时并列原文和口径，不按论文数量投票。
5. 来源或全文不可达时保留真实的 `source_unavailable`/`fulltext_unavailable` 状态，说明已读取的范围和不能判断的字段。访问控制、登录和验证码需要用户操作时返回 `user_action`，不绕过权限。

## 记录与交付

用户要求研究记录或可交付成果时，使用 `research_record` 保存新来源及关键声明。关键声明写入 `claims.jsonl`，字段至少包括：

```text
claim_id
claim_type: fact | inference | hypothesis
claim_text
source_ids
evidence_text
locator
supports
limitations
verified_at
```

`fact` 必须有真实来源和定位；`inference` 必须有 `basis` 或证据文本；`hypothesis` 保持 `pending`。来源元数据写入 `sources.jsonl`，并保留 provider、版本和获取时间。

交付按用户需要选择阅读笔记、结构化证据表或论文比较表，但至少说明：阅读范围、论文身份/版本、研究问题、方法、结果、局限、可复现性信息、冲突与未确认项。结论中的数字、样本量和统计结果必须来自实际原文定位；没有全文时不要伪装成全文精读。

## 诚信边界

- 论文标题或摘要不能证明全文细节、因果关系、优越性或研究空白。
- 不把作者推测、相关性或方案预期写成已证实因果结论。
- 不伪造论文、作者、期刊、日期、DOI、PMID、引用、页码、图表数值或复现结果。
- “这条引用是否支持某个具体论据”属于引用审计，应使用 `citation-audit`；本 Skill 只提取实际读到的证据。
