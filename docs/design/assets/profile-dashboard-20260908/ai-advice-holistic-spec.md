# AI 建议：跨交流整体分析原型

- 日期：2026-09-08。
- 状态：旧版已实现；用户要求改为 [10 三字段原型](ai-advice-simple-spec.md)。此处保留历史，不再作为后续 schema 或提示词依据。
- 图片：[09-tab-ai-advice-holistic.png](09-tab-ai-advice-holistic.png)。
- 生成方式：内置 image_gen；08 作为应用外壳与单栏交互参考。
- 本图替代 07 的左右列表和 08 的单次问题诊断方式。

## 定稿价值

AI 建议综合用户长期画像、多次独立交流、已有工作方式和当前目标，寻找一个能解释多个表面问题、可以迁移到不同场景的知识。建议不依附于某一段对话，也不把“没有提到”当作用户不会。

每条建议至少由两个不同会话中的真实用户消息支持。标题说明学会后能改善的判断，展开后提供：

1. 把多次交流放在一起看到的共同模式。
2. 值得系统了解的具体知识。
3. 这项知识在用户真实涉及的多个领域分别有什么用。
4. 从实际搜索结果中选择的少量资料和具体阅读重点。
5. 带着多个交流依据继续请 Mona 讲解的入口。

用户不需要旧答案推荐、出题检查、能力评分和画像设置。页面不显示设计说明、示例声明或资料核验状态占位行。

## 落地交互

- AI 建议使用单栏 Accordion。优先级最高的一条默认展开，用户可以收起或切换其他条目。
- “为什么会这样建议”打开实际引用的有限来源摘要，并可跳到原会话。来源属于证明判断的证据，不作为页面信息架构。
- 讲解使用安全 Markdown；多个应用场景使用普通响应式分栏；资源使用真实外部链接和系统打开入口。
- AI 建议使用完整历史范围，因此顶栏不显示“近 30 天”；我的画像和变化轨迹继续显示该统计窗口。
- 没有两段独立交流共同支持时返回空状态，不生成凑数建议。
- 资源搜索只使用通用知识名称拼接固定资料查询，不发送对话原文、姓名、路径或项目机密。搜索失败时保留自包含讲解。
- 点击“结合我的经历讲讲”时，起步请求包含知识名称、推荐理由、已有讲解、应用场景、资源和最多五条可访问的相关交流摘要。

## 实现契约

建议增加 kind=holistic_learning、knowledge_area、application_areas 和 resources。资源由服务端把模型选择的 resource_id 映射回实际搜索结果，模型不能生成 URL。历史建议保留旧字段兼容显示；新算法指纹带版本，避免复用旧的一小步任务结果。

生成分两次模型调用：第一步只找跨会话共同知识；服务端用知识名称搜索公开资料；第二步结合实际搜索结果写讲解和阅读重点。候选必须通过来源存在性和不同会话数量校验。

## 完整生成提示词

```text
Use case: ui-mockup. EDIT the supplied Mona prototype into a substantially deeper, cross-conversation PERSONAL LEARNING ADVICE page. Preserve the existing Mona shell, single-column expandable row layout, and active AI 建议 tab. Replace ALL recommendation copy, remove the footer completely, and show the whole-person analysis clearly in the content.

PRODUCT PURPOSE, VERY IMPORTANT:
This page synthesizes a user's demonstrated knowledge, repeated ways of reasoning across multiple projects and domains, and longer-term goals. It identifies underlying knowledge worth learning that could improve MANY decisions. It is NOT a checklist for a particular conversation, NOT isolated debugging tips, and NOT recommendations derived from the last message. The recommendation is one underlying gap connecting multiple domains, not three unrelated issue reports.
The fictional persona used only for this mockup works across product building, course design, and AI agent projects. They are experienced at proposing implementations, but across several separate discussions explicitly attributed improved results to their changes even when comparison conditions also changed. This supports a possible gap in causal reasoning. This is invented prototype content, NOT an assessment of the real requesting user. Do not put that meta explanation in the image; it will be explained outside the product.

STRICT USER CONSTRAINT: no footer, disclaimer, 原型示例, 示例数据, 对话为示例, 资料已核实, or other meta/design/verification text anywhere in the image. The page ends naturally after the last recommendation. NO wasted strip for these phrases.

SHELL:
Thin native Mona titlebar; existing narrow outer module rail with icons and labels 会话、笔记、文档、终端、邮件、计划、数据库、系统、股票、画像. Keep red mark on 画像. One white main surface, neutral-gray outer app background. Top 44 logical px toolbar, left 用户画像 (REMOVE 近30天 from this advice screen because it uses accumulated understanding), center exact tabs 我的画像 / 变化轨迹 / AI 建议 with thin RED selected underline under AI 建议, right refresh icon and charcoal 更新画像. No internal left list/sidebar. No score/KPI strip, no identity/biography card, no settings, no cognitive map decoration.

STYLE:
One front-on realistic screenshot, 2048x1280 landscape, dense desktop information design implementable with ordinary UI components. Chinese system sans-serif at logical 14px body, 12px metadata, largest suggestion title 18px semibold. White background, charcoal text, gray secondary text. Small neutral text links and restrained blue resource links. One charcoal primary action. No giant typography, shadows, card walls, tinted status banners or huge margins. Use fine horizontal separators and 12–16px inner spacing. Maintain readability. No abstract product labels such as 认知缺口、认知雷达、认知杠杆、元认知画像. Actual knowledge names such as 因果推断 are appropriate because they are what the user is invited to learn.

CONTENT STRUCTURE:
Single-column list of THREE recommendations. Highest priority one is expanded and occupies around 400 logical px. Other two compact collapsed rows around 70 logical px each. A small quiet heading at very top of body 学懂之后，能用在很多地方, right 更新于 09/08. This is NOT a user biography summary.

FIRST EXPANDED RECOMMENDATION:
small plain label 建议优先了解
bold title 结果变好了，怎样判断真的是方案起了作用？
Far right up-chevron 收起.
Two or three short introductory lines:
把产品设计、课程迭代和 Agent 调优的交流放在一起看，
你能提出完整的实施方案，但几次把调整后的好结果直接归因于调整本身。
值得补上的，是区分“结果相关”与“真正原因”的判断方法。
This paragraph EXPLICITLY explains a common recurring reasoning issue across fields, rather than citing one dialogue. Keep regular 14px, not giant prose.
One compact text disclosure link 为什么会这样建议 ›. It would expand multiple pieces of evidence from different discussions in place. Do NOT display 来自「某次对话」 anywhere.

Knowledge heading 建议系统了解：实验设计与因果推断
A compact simple two-row comparison, implementable with text and thin arrows, around 65 logical px:
看到前后变化 → 知道结果不同了
设置合理对照 → 帮助判断差异是否来自方案
A small explanatory sentence 同时考虑样本、环境和时间的变化，才能减少误判。
No fabricated percentages, causal certainty scores, or large diagrams.

A narrow 3-column strip within the SAME recommendation, not three cards and not navigation. Header 这项知识能同时帮你:
Column 产品设计 — 判断改版是否有效
Column 课程教学 — 区分学会了与题目变简单
Column Agent 调优 — 在相同任务上比较方案
Use plain short text with subtle vertical dividers. This shows transfer of one underlying knowledge area across a person's work. Avoid abstract connector labels or separate actions per domain.

Resources section small 推荐资料.
Two compact unboxed clickable rows:
Causal Inference: What If ↗    免费英文书 · 从前两章理解因果与对照
微软研究院：在线对照实验 ↗    英文 · 看实验怎样帮助判断产品效果
These refer to verified resources:
https://www.hsph.harvard.edu/miguel-hernan/wp-content/uploads/sites/1268/2024/04/hernanrobins_WhatIf_26apr24.pdf
https://www.microsoft.com/en-us/research/publication/online-experimentation-at-microsoft/
Show actual resource titles, NOT the long URLs. Do not say these resources are newly released. No fake checkmark or 资料已核实 metadata.
One modest charcoal button 结合我的经历讲讲 →. This continues existing Mona chat with the accumulated profile and selected supported examples, not just one conversation. No quiz or old-answer retrieval.

SECOND COLLAPSED ROW:
bold title 遇到复杂问题，先找真正限制结果的环节
short explanation 在产品、流程和团队安排中，你常同时改动多个环节。系统思考能帮助你辨认瓶颈与相互影响。
small knowledge text 建议了解：系统思考与瓶颈分析
Far right down-chevron 展开.
Keep this a compact row, not a full bordered card. No single-chat provenance.

THIRD COLLAPSED ROW:
bold title 做选择时，把成功的可能性也算进去
short explanation 综合技术选型与项目规划的交流，你会比较收益，但几次用一个成功案例代表普遍结果。
small knowledge text 建议了解：概率思维与样本偏差
Far right down-chevron 展开.
Again a compact flat row. Do not assign personality diagnoses or claim the user has fixed traits.

NO FOOTER OF ANY KIND. No lower status strip or extra row. No 原型 / 示例 / 已核实 / 全面掌握 metadata.
The final image must show deeper transferable recommendations based on a holistic accumulated understanding of the person, in plain and respectful language. It must be practically implementable with accordion rows, safe markdown/text, simple optional diagrams, evidence disclosures and links. Preserve sufficient space to read, but no large empty cards.
```
