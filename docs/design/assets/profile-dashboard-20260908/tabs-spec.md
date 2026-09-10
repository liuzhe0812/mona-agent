# 用户画像：三个并列页签的原型

- 状态：三个页签已实施；AI 建议已按 11 单篇建议原型改造，运行时使用一个业务提示词和对应三部分内容结构。
- 生成方式：内置 image_gen，以用户提供的实际应用截图作为外壳参考。
- 视觉依据：`docs/design/mona-ui-design-system.md` 的字体、动作色、默认无边框、应用外壳与洞察模板规则。
- 原截图中的大文字卡片、编辑设置和多层边框是被否定的内容，不作为设计参考。
- 三个并列页签分别为：我的画像、变化轨迹、AI 建议；没有总分关系。
- 第一页签以 `06-tab-my-profile.png` 取代此前总览原型，完整提示词见 [my-profile-spec.md](my-profile-spec.md)。实际 Mona 外壳、居中红线页签、炭黑操作和无嵌套卡片样式保持统一。
- `04`、`05` 图片中的旧页签文字在实施时统一为新名称；不将图中旧名称视为新的信息架构。
- 之前的 `02-focus-map.png`、`03-change-trends.png` 是未采用的总览候选，不能当成另外两个页签。
- 图中记录、日期、计数、图表与建议均为示例数据；实施时按真实数据和准确图表刻度绘制。

| 页签 | 本次图片 | 内容重点 |
|---|---|---|
| 我的画像 | [06-tab-my-profile.png](06-tab-my-profile.png) | 关注领域、主题关联、协作类型、交付物、领域与任务矩阵 |
| 变化轨迹 | [04-tab-focus-changes.png](04-tab-focus-changes.png) | 话题趋势、前后对比、雷达、活动日历、新接触主题 |
| AI 建议 | [11-tab-ai-one-insight.png](11-tab-ai-one-insight.png) | 每次一条最值得了解的道理或知识，接着说明怎么提升和参考资源；详见 [提示词与设计说明](ai-one-insight-spec.md) |

`05`、`07`、`08`、`09` 和 `10` 图片保留为旧方案。11 原型依据用户的自然问题设计，只使用一个业务提示词；取消表格，采用单篇阅读布局。

## 完整生成提示词

### 关注变化

```text
Use case: ui-mockup. Generate one high-fidelity, implementable raster desktop UI prototype of Mona.
Reference image 1 is a REJECTED current implementation. Reuse ONLY its actual application shell: thin gray Windows titlebar with small 'Mona', narrow left icon rail, one white main content surface, and the single COMPACT centered tab toolbar. The screenshot's large rounded text cards, nested borders, settings forms, empty-state paragraphs and giant identity titles are the rejected elements and MUST ALL BE REPLACED.
Output a complete front-on screenshot, landscape 2048x1216, no perspective/device/presentation board. Preserve the screenshot's shell geometry. Left app rail exactly 64 logical px with gray outline icons and Chinese names 会话, 笔记, 文档, 终端, 邮件, 计划, 数据库, 系统, 股票, 画像. A slim RED vertical 2px mark selects 画像; NO colored selection block, no extra cat mascot. Titlebar about 36 logical px. Main white surface fills the rest, with only its OUTER 12px corners.
MANDATORY MONA UI SPEC: warm neutral gray #F2F2ED exterior, white data canvas, charcoal #1A1A1A text and #6B6B67 secondary text. DEFAULT BORDERLESS content sections: use aligned edges, 16/24px space, occasional ONE subtle separator line; never nested cards or outlined card walls. No shadows or gradients. No colored panel backgrounds. Readable regular system Chinese font. Toolbar/tabs/buttons 12 logical px; data labels 13px; main text 14px; section headings 16px semibold; scarce KPI numerals 28px. No huge 40px headings.
Top toolbar 44px: left '用户画像 · 近 30 天'; CENTER tabs '总览' '关注变化' 'AI 建议' in identical small size; active tab uses dark text + thin RED underline, inactive muted. Right refresh icon and one small charcoal '更新画像' button with white text and 8px corners. NO second header strip or coverage settings line below it. No green navigation underline.
Charts use restrained GREEN and BLUE with amber only when a third data series is necessary. UI controls stay neutral/charcoal, NOT green, orange or blue solid buttons. All readable copy Chinese except technical names RAG, AI. NO settings, edit/pencil icons, forms, biographies, avatars, 'AI眼中的我' cards, confidence gauges, skills grades, or block paragraphs. A very small footer '示例数据 · 近 30 天' identifies data as fictional prototype examples.

THIS IS TAB TWO: '关注变化' is active with RED underline. '总览' and 'AI 建议' inactive. The page visual purpose is to see what CHANGED, rather than repeat a profile summary.
Use the full content width with compact charts, generous readable chart plot area, NO giant blank card spacing. About 80% of content is data visualization.
Top an inline four-stat ribbon, borderless, 75 logical px high:
'对话' 64, tiny '上期 56 · +8'
'生成成果' 27, tiny '上期 20 · +7'
'活跃日期' 18, tiny '上期 15 · +3'
'新关注话题' 2, tiny '本期首次出现'
Neutral gray secondary text, numbers charcoal; do not color every numeral.
Main upper graph row: left 64% '话题变化趋势', three thin clean lines colored green / blue / amber, with small legend 'AI 编程' '产品设计' '知识检索'. X axis four weekly checkpoints '第1周' '第2周' '第3周' '第4周'. Y axis '记录数' from 0 to 12. Quiet sparse dashed grid, no framed card.
Right 33% '本期与上期': horizontal paired thin bars, gray previous / colored current, four labels and exact count comparisons:
'AI 编程' 20 → 28
'产品设计' 26 → 24
'知识检索' 8 → 16
'内容创作' 10 → 12.
Use same topic colors as main trend graph and clear direct count labels. No fake ranking score.
Lower main row split 3 unequal columns:
Left 36% '关注结构对比': legible six-axis radar, current green with very light fill, previous gray dashed, axes 'AI应用' '产品' '开发' '设计' '写作' '研究'. Note tiny '话题记录数', NEVER ability score. Include understated current/previous legend.
Center 38% '活动日历': August/September compact calendar heatmap with 30 data-day squares, green intensities for active days, gray blank for inactive days, weekday labels and small low/high legend. Small caption '18 个活跃日期'. Chart only, not a scheduling/calendar settings app.
Right 22% '本期新接触': two small data rows, not cards: 'RAG 评估' '首次记录 08/21 · 9 条', and '知识图谱' '首次记录 08/29 · 6 条'; tiny local sparklines beside each.
A final very shallow summary line at bottom includes three short data observations separated by space: '知识检索 +8 条' '产品设计 −2 条' '生成成果 +7 份'. Avoid long analytical paragraphs.
Render Chinese accurately and keep all chart legends clearly within their panels. The result must feel like the user's native Mona app, with refined borderless information design, not a standalone generic SaaS webpage.
```

### AI 建议

```text
Use case: ui-mockup. Generate one high-fidelity, implementable raster desktop UI prototype of Mona.
Reference image 1 is a REJECTED current implementation. Reuse ONLY its actual application shell: thin gray Windows titlebar with small 'Mona', narrow left icon rail, one white main content surface, and the single COMPACT centered tab toolbar. The screenshot's large rounded text cards, nested borders, settings forms, empty-state paragraphs and giant identity titles are the rejected elements and MUST ALL BE REPLACED.
Output a complete front-on screenshot, landscape 2048x1216, no perspective/device/presentation board. Preserve the screenshot's shell geometry. Left app rail exactly 64 logical px with gray outline icons and Chinese names 会话, 笔记, 文档, 终端, 邮件, 计划, 数据库, 系统, 股票, 画像. A slim RED vertical 2px mark selects 画像; NO colored selection block, no extra cat mascot. Titlebar about 36 logical px. Main white surface fills the rest, with only its OUTER 12px corners.
MANDATORY MONA UI SPEC: warm neutral gray #F2F2ED exterior, white data canvas, charcoal #1A1A1A text and #6B6B67 secondary text. DEFAULT BORDERLESS content sections: use aligned edges, 16/24px space, occasional ONE subtle separator line; never nested cards or outlined card walls. No shadows or gradients. No colored panel backgrounds. Readable regular system Chinese font. Toolbar/tabs/buttons 12 logical px; data labels 13px; main text 14px; section headings 16px semibold; scarce KPI numerals 28px. No huge 40px headings.
Top toolbar 44px: left '用户画像 · 近 30 天'; CENTER tabs '总览' '关注变化' 'AI 建议' in identical small size; active tab uses dark text + thin RED underline, inactive muted. Right refresh icon and one small charcoal '更新画像' button with white text and 8px corners. NO second header strip or coverage settings line below it. No green navigation underline.
Charts use restrained GREEN and BLUE with amber only when a third data series is necessary. UI controls stay neutral/charcoal, NOT green, orange or blue solid buttons. All readable copy Chinese except technical names RAG, AI. NO settings, edit/pencil icons, forms, biographies, avatars, 'AI眼中的我' cards, confidence gauges, skills grades, or block paragraphs. A very small footer '示例数据 · 近 30 天' identifies data as fictional prototype examples.

THIS IS TAB THREE: 'AI 建议' is active with RED underline. The other two tabs inactive. This is a visually structured PERSONAL ADVICE DISPLAY, not a settings panel, a task-management app or a long article.
Under toolbar a single small line '本期 3 条建议' with neutral adjacent '围绕近期问题，给你一个具体起点'. No usage KPI ribbon repeated here.
Information architecture: ONE FEATURED suggestion on top and TWO compact secondary suggestions side by side below, all BORDERLESS white sections. Use white space and ONE horizontal separation, not rounded card outlines. Text is tightly limited: category, action title, one evidence sentence, diagram/template preview, one action. Never prose paragraphs longer than 20 Chinese characters per line.
Featured suggestion occupies about 42% content height and full width:
Left 43% shows small plain category '学习补充', semibold heading '用 10 条问题验证 RAG 召回效果', concise supporting fact '依据：近期 6 次检索相关讨论'. Below that a tiny three-step horizontal diagram, thin charcoal arrows connecting short labels '选问题 → 标答案 → 记命中', without enclosing rounded boxes. One starting sentence '先挑 10 条真实问题，跑一轮检索'. Footer tiny '预计 20 分钟 · 得到一张召回评估表'. ONE small charcoal solid button '开始这个练习 →'.
Right 53% shows a clean READ-ONLY miniature document/table preview titled '召回评估表 · 示例', with subtle rows and column headers '问题' '目标文档' '命中'. Three filled sample rows 'Q1 / 架构说明 / ✓', 'Q2 / 接口约定 / ✓', 'Q3 / 部署指南 / —'. Under the table one quiet line '先看漏掉了什么，再调整检索'. The preview is a visual artifact, no input boxes, no editable controls, no fake confidence score.
Below a single subtle horizontal rule, two side-by-side suggestion zones with generous column gap, optional one faint vertical divider:
Lower left: category '方法改进'; title '把需求写成 5 条验收条件'; one fact '依据：3 次返工涉及验收不清'. A small read-only two-row example visual, row 1 '切换页签 → 保留日期范围', row 2 '没有记录 → 展示空状态'. Bottom '第一步：从最近一次返工开始', '预计 15 分钟 · 一张验收清单', and small neutral outlined button '开始整理 →'.
Lower right: category '成果沉淀'; title '从 3 份报告提炼通用模板'; fact '依据：4 份报告结构相似'. Show three miniature charcoal-line document icons feeding through a fine arrow into one concise template outline with readable labels '背景 / 结论 / 依据 / 下一步'. Bottom '第一步：找出重复出现的栏目', '预计 15 分钟 · 一份报告模板', neutral outlined button '开始提炼 →'.
Near bottom a slim source-reference strip '相关记录' and three compact unboxed links 'RAG 检索优化 · 08/29', '需求验收讨论 · 09/02', '报告结构整理 · 09/05'. This is evidence navigation, not feedback/settings.
No checkbox lists, progress trackers, completion badges, pencil icons, editable profile fields, settings text, or oversized icons. Only one solid main action in whole content; secondary actions are neutral. Detailed content is communicated by small diagrams and document previews, not text walls. Precisely match the native Mona shell and restrained UI specification in the reference.
```
