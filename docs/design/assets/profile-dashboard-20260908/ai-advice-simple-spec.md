# AI 建议：三字段原型与提示词

- 状态：旧版参考，用户已取消表格并提出每次一个最值得知道的内容，请看 [11 单篇建议原型](ai-one-insight-spec.md)。本文件保留设计历史。
- 图片：[10-tab-ai-advice-simple-schema.png](10-tab-ai-advice-simple-schema.png)。
- 生成方式：内置 image_gen，沿用 09 的 Mona 应用外壳。
- JSON Schema：[ai-advice-simple.schema.json](ai-advice-simple.schema.json)。
- 用户最新要求优先于 09 及更早设计：最多三个知识点，各自含学习建议与资源 URL。取消额外产品字段和人为限定的分析过程。

## 数据与界面一一对应

| 字段 | 界面 |
|---|---|
| knowledge_items（最多 3 项） | 最多三行知识建议 |
| knowledge | “建议了解的知识”列 |
| learning_advice | “学习建议”列，说明从何入手 |
| resources[].title / url | “学习资料”列中的可点击链接；域名由 URL 计算 |

resources 的 title 只用来把 URL 显示成可读链接，不增加一种推荐内容。链接从实际搜索结果取得，找不到合适资料可以为空。schema 不强制推荐数量、资源数量、具体知识领域、会话数量或应用场景数量。

三列属于同一行数据，不是左侧导航。默认直接展示全部内容。窄面板按一项知识内的“知识 → 学习建议 → 资料”顺序换行；文字按实际内容自然展开，不给每一项写死像素高度，不截断学习建议。页面无需额外的来源面板、讲解区、应用场景、图解、评分、优先级、测试、反馈、聊天启动按钮或底部声明。

现有 Accordion 和旧 AdviceContent 字段不作为本版前端设计依据。后续若实施，应先对齐服务端与前端此 schema；运行状态和持久化需要的内部信息不要混入模型的三字段内容或占用页面展示区。当前仍运行旧代码，不将这次设计文档标成已实现。

## 拟用系统提示词

```text
请综合用户的历史交流、已有画像与目标，充分分析用户可能存在但尚未意识到的知识盲区，推荐不超过 3 项值得学习的知识。

为每项知识给出贴合用户的学习建议，说清从哪里入手、先学什么、怎样继续，并尽可能搜索相关学习资源。

资源 URL 必须来自实际搜索；没有合适资源时返回空数组。请只按提供的 JSON Schema 输出结果。
```

请求时把用户相关数据与上述 schema 作为输入即可。不给模型预设“因果推断、系统思考”等固定答案，也不固定“两阶段候选 + 两个会话 + 多个应用场景”的思考路线。搜索工具的执行由实现提供，提示词本身不代表已获得网络搜索能力。

## 原型中的资料

图片中的知识点和学习建议用于表达界面结构，不代表对真实用户的评估；生产内容由整体分析生成。说明留在设计文档，不放进产品页面。

- [看见统计：基础概率论](https://seeing-theory.brown.edu/basic-probability/cn.html)
- [看见统计：章节总览](https://seeing-theory.brown.edu/cn.html)
- [微软研究院：在线对照实验](https://www.microsoft.com/en-us/research/publication/online-experimentation-at-microsoft/)
- [Causal Inference: What If](https://www.hsph.harvard.edu/miguel-hernan/wp-content/uploads/sites/1268/2024/04/hernanrobins_WhatIf_26apr24.pdf)
- [Leverage Points: Places to Intervene in a System](https://donellameadows.org/archives/leverage-points-places-to-intervene-in-a-system/)

## 完整图像生成提示词

```text
Use case: ui-mockup. EDIT the attached Mona AI-advice screenshot into a clean, polished, realistic desktop UI that directly renders a SIMPLE THREE-FIELD SCHEMA. Keep only the native Mona shell and top toolbar from the reference. Replace every piece of body content and remove the old accordion/action/application-area layout.

PRODUCT DATA CONTRACT, authoritative:
{
  "knowledge_items": [
    {
      "knowledge": "name of knowledge the user may need to learn",
      "learning_advice": "personalized advice about where to begin and how to learn it",
      "resources": [{"title": "resource title", "url": "real URL"}]
    }
  ]
}
knowledge_items contains at most 3 items. The interface displays EXACTLY these three concepts. No extra reasoning/why panels, no application areas, no source citations to conversations, no confidence/priority/scores, no learning progress, no training plans, no generated diagrams, no quizzes, no chat buttons or evaluation tools. Internal AI reasoning uses the whole user profile and accumulated conversations; do not render this reasoning as a new field. This image uses illustrative content; do NOT put any prototype/example/verification disclaimers in the product screen.

COMPOSITION:
One full front-facing app screenshot, 2048x1280 landscape, suitable for implementation at ordinary desktop sizes. Keep the existing narrow outer Mona module rail with icons/text 会话、笔记、文档、终端、邮件、计划、数据库、系统、股票、画像. Thin red indicator at 画像.
Native top titlebar Mona, existing window controls. One white main surface on warm neutral gray exterior.
Top toolbar 44 logical px: left 用户画像; centered exact three tabs 我的画像 / 变化轨迹 / AI 建议 with thin RED underline beneath AI 建议; right small refresh icon and charcoal 更新画像 button.
No internal left navigation. No explanatory banner or extra title band under toolbar.

BODY:
An elegant flat editorial table with THREE broad, generously readable rows, one per knowledge item. A shallow muted header row has exact labels 建议了解的知识 / 学习建议 / 学习资料.
Three aligned columns sized about 21% / 49% / 30%, with comfortable 24px gutters. The left column is NOT a selectable sidebar or list: it contains the knowledge label within each full-width horizontal row. The rows have only faint horizontal separators, no grid cell borders and no rounded card boxes. All THREE rows are fully visible, none collapsed. Balanced content density: each row roughly 155 logical px, body text line-height 22px, no cramped mini-text and no giant empty cards. Knowledge titles 16px semibold; learning advice 14px regular Chinese; resources 13px links. Align title, advice and first resource to the top baseline in each row. Resource links show a tiny external-link icon and muted source hostname beneath, derived from URL. No language badges or metadata statuses. The last row ends naturally; no footer.

EXACT CONTENT:
ROW 1:
Knowledge title 概率与统计
Learning advice:
先从概率、期望和方差入手，理解结果为什么会波动。
再学习条件概率和贝叶斯更新，掌握怎样根据新证据调整判断。
可以先用右侧的交互教程建立直觉，再回看你做过的方案比较。
Resources:
看见统计：基础概率论 ↗
seeing-theory.brown.edu
URL target https://seeing-theory.brown.edu/basic-probability/cn.html
看见统计：章节总览 ↗
seeing-theory.brown.edu
URL target https://seeing-theory.brown.edu/cn.html

ROW 2:
Knowledge title 实验设计与因果推断
Learning advice:
先分清“两个现象一起变化”和“一个因素造成另一个结果”。
接着了解对照组、随机分组和混杂因素，学习怎样判断方案是否有效。
从微软的产品实验案例开始，再深入阅读因果推断的基础章节。
Resources:
微软研究院：在线对照实验 ↗
microsoft.com
URL target https://www.microsoft.com/en-us/research/publication/online-experimentation-at-microsoft/
Causal Inference: What If ↗
hsph.harvard.edu
URL target https://www.hsph.harvard.edu/miguel-hernan/wp-content/uploads/sites/1268/2024/04/hernanrobins_WhatIf_26apr24.pdf

ROW 3:
Knowledge title 系统思考
Learning advice:
先了解反馈回路和时间延迟，理解为什么局部改进可能带来意外结果。
阅读右侧文章时，重点看“规则、信息流和目标”怎样改变系统行为。
再选一个熟悉的工作流程，画出各环节之间的影响关系。
Resources:
Leverage Points：系统的干预点 ↗
donellameadows.org
URL target https://donellameadows.org/archives/leverage-points-places-to-intervene-in-a-system/

Use the visible titles above rather than printing long bare URLs. All resource URLs provided here are actual source URLs; never invent more links.
NO extra learner biography, pseudo-analysis statements about the user, achievement badges, '为什么推荐', '这项知识能同时帮你', '结合我的经历讲讲', resource cards, giant source buttons, huge typography, ornamental illustrations, decorative knowledge map or lengthy footer.
COLOR: white background, charcoal text, muted gray labels and rules, restrained blue text for real links only. Neutral charcoal toolbar action. Crisp professional Chinese typography, balanced whitespace, calm and believable native Mona UI. The key is direct one-to-one mapping between the data schema and each visual row.
```
