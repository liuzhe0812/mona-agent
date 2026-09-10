# AI 建议：一个值得知道的道理或知识

- 状态：已按 11 原型实现；运行时、前端和资源搜索统一使用本文件定义的单篇建议结构。
- 图片：[11-tab-ai-one-insight.png](11-tab-ai-one-insight.png)。
- 输出结构：[ai-one-insight.schema.json](ai-one-insight.schema.json)。
- 制作：内置 image_gen，以 10 的应用外壳为参考，重新设计单篇阅读界面。
- 用户当前核心问题为“基于我们最近的聊天内容，请告诉我一个你认为我非常有必要知道，但是我大概率还不知道或没有真正理解的道理或者知识”。
- 以最新“只选一个”的问法设计每次一条最值得了解的内容，补充怎么提升和参考资源。

## 唯一业务提示词

```text
基于我们最近的聊天内容，以及你对我的整体了解，请告诉我一个你认为我非常有必要知道，但我大概率还不知道或没有真正理解的道理或知识。

请结合我们的交流把它讲明白，说明为什么它对我重要，再告诉我可以怎么提升、从哪里开始学习，并搜索合适的参考资源，提供资料名称和真实 URL。

只选你认为最有价值的一项，用自然、具体、容易理解的语言回答，不要使用表格。
```

提示词不预设学科答案、不规定至少两个会话、不要求多个应用领域，不把思考过程拆成发现候选与二次编辑。系统向模型提供真实可访问的聊天上下文和已知用户信息；模型生成一次后，运行流程使用知识标题搜索并核对资源 URL。

结构化输出只约束三个内容部分：knowledge（标题和正文解释）、learning_advice（怎么提升）、resources（资料名称和 URL）。格式约束与业务问题分开，避免把字段扩展成更多产品功能或推理要求。

## 页面

采用单篇阅读结构：知识标题和解释在上，“怎么提升”在中，参考资源在下。正文自然说明与用户交流的关联和重要性，不另设分析依据面板或应用场景。

- 知识：一个清楚的标题、短段落解释；可在正文中突出一条关键句。
- 怎么提升：可执行的学习建议，根据内容使用短段落或普通编号。
- 参考资源：真实资料名称链接与从 URL 提取的域名；点击打开资料。
- 页面不使用表格、内部导航列、三条 Accordion、分数、进度、测验、模板预览、额外聊天按钮或底部原型声明。
- 沿用 Mona 外壳、并列页签、共享字号和中性操作按钮；知识标题要克制，不能做成营销页大标题。
- 长内容自然换行，在页面层滚动，避免每个区块内部出现滚动条。不要用固定高度撑开内容或把正文裁掉。

图中的内容用于展示信息组织方式，生产时由当前聊天和用户信息生成。此说明只保存在设计文件，不放入产品页面。

## 本图资料来源

- [LangChain Memory overview](https://docs.langchain.com/oss/python/concepts/memory)：短期与长期记忆、用户信息的保存与调用。
- [Anthropic Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)：上下文组织。

## 图像生成提示词

```text
Use case: ui-mockup. Edit the reference Mona screenshot to show ONE personal insight with practical learning advice and resources, as an elegant short reading page. Preserve native Mona shell and active AI 建议 top tab. Replace the table completely.

The user requests a UI based on one simple question: “基于我们最近的聊天内容，请告诉我一个你认为我非常有必要知道，但是我大概率还不知道或没有真正理解的道理或者知识。” Then add how to improve and reference resource URLs.
Render ONE coherent insightful response, followed by how to improve, followed by resource links. All data displayed belongs to this one answer. DO NOT show a table, three-column comparison, catalogue, accordion list, separate left navigation, scores, explanation workflow, application-area cards, quiz, progress tracking or extra buttons.

SHELL: Match supplied screenshot's slim native Mona titlebar and narrow left MODULE rail. Gray icons and Chinese module labels; thin red selected marker at 画像. White content surface on neutral warm gray exterior. The 44 logical px toolbar has left 用户画像, centered 我的画像 / 变化轨迹 / AI 建议 with thin red underline under AI 建议, right refresh icon and one small charcoal 更新画像 button. No second toolbar.
BODY VISUAL DESIGN: polished editorial reading surface in a productivity app. Single continuous article spanning a comfortable reading width, 36px logical horizontal padding from the white surface, tidy 20–24px vertical gaps, clear aligned left edges. Largest title 20px logical semibold, main Chinese body 14px logical with 23px line-height. Section headings 16px. Resource link text 13px. Maintain calm whitespace with enough content to use most of the available screen, without a huge empty lower area. Only short paragraphs; no repetitive long prose. Black charcoal and muted gray text, subtle blue only for actual links. Flat layout, no enclosing cards, no shadows, no decorative images, no badges or circular number tiles.
OUTPUT: one front-on realistic high-fidelity 2048x1280 landscape desktop screenshot, legible Chinese system sans-serif. The complete article fits one screen at normal 1280x800 logical size.

EXACT ARTICLE:
At top, small quiet category AI 给你的一个建议
Main title AI 能否真正了解你，取决于它看到了什么
Under title two short paragraphs of normal body:
你希望 AI 从长期交流中，看出用户自己没察觉的知识欠缺。这件事要成立，有一个容易忽略的前提：关于你的判断，必须建立在真正送入模型的相关信息上。
聊天记录已经保存，并不意味着模型每次都能用到。理解“上下文、长期记忆和检索”的关系，才能让全面分析有实际依据。
Keep paragraphs modest in width so Chinese reading is comfortable, but do NOT put them into a bordered box.

An understated text callout with ONLY a short thin charcoal vertical line, not a card:
先弄清 AI 看到了什么，再判断它是否真的了解了你。
This is one useful concise takeaway, not a visual flowchart.

Next section heading 怎么提升
Three readable simple numbered TEXT lines, not checklist controls and not a table:
1. 先分清：当前对话、长期保存的信息，以及检索补回的相关内容。
2. 看一次真实分析的输入，确认它包含哪些经历、目标与纠正。
3. 从一段熟悉的连续讨论开始，梳理哪些信息值得保留，以及何时再提供给模型。
Use standard simple numbering with no circles, no colored blocks, natural wrapping.

Next section heading 参考资源
Two plain linked reading entries, stacked vertically and separated by normal whitespace:
LangChain：短期与长期记忆 ↗
docs.langchain.com
Anthropic：上下文工程 ↗
anthropic.com
The underlying real URL targets are:
https://docs.langchain.com/oss/python/concepts/memory
https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
Show titles and muted domains, no long raw URLs and no cards. The only in-article interactions are opening these resource links. Reading text is read-only.

NO footer, disclaimer, prototype/sample text, checked/verified label, model metadata, fake dates, mastery or confidence scores, “为什么这样建议” extra drawer, or “结合我聊聊” buttons. There must be absolutely no table anywhere. The upper knowledge and relevance are a natural explanation, not repetitive labels or JSON fields. This should feel like a thoughtful colleague wrote one meaningful insight for you and showed how to begin, within the existing Mona visual language.
```

### 字号和间距微调

```text
Edit this Mona AI-advice prototype with ONE targeted refinement: make the typography and spacing appropriate for the native productivity app. Keep all exact Chinese text, the single insight, how-to-improve section, resource links and application shell unchanged. Do not make a table.

The main headline is currently too large and heavy. Reduce its size by about 35%, to approximately 20 logical px semibold. Section titles 怎么提升 and 参考资源 should be 16 logical px semibold, about the same size as ordinary body text with stronger weight, NOT giant headings. Body should stay clearly readable at 14 logical px with 22px line height. Small category label is 12px. Resource links 13px. Use regular system Chinese typography throughout. Bring the article left edge closer to the main surface edge, approximately 40 logical px inside the white surface; keep a readable maximum text width around 1000 logical px, horizontally centered. Moderate vertical gaps 20–24px, no huge gaps. Avoid newspaper or marketing-article styling. The page should feel calm and compact enough for everyday use, with one meaningful explanation followed by practical steps and links.

Maintain everything else, no footer/disclaimer, no extra buttons, no added diagrams, no extra knowledge items, no internal sidebar. Render a realistic front-on desktop screenshot in the same aspect ratio.
```
