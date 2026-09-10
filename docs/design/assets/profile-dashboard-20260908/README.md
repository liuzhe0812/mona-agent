# 用户画像仪表盘：三种原型方案

- 状态：最新三个并列页签见 [tabs-spec.md](tabs-spec.md)，第一个页签已重生成 [我的画像](06-tab-my-profile.png)。以下三种总览候选保留作历史对照。
- 生成方式：内置 image_gen。
- 最新方向：信息展示与图表优先；首页不放设置表单、编辑卡片、大段说明或“AI 眼中的我”身份摘要卡。
- 所有图中数字、曲线、日期与建议均为原型示例，不是用户真实统计；本轮评审信息结构和视觉层级。

| 文件 | 方向 | 视觉重点 |
|---|---|---|
| [01-panorama.png](01-panorama.png) | 全景总览 | 紧凑指标、趋势、分布、雷达与主题关联；底部短建议栏 |
| [02-focus-map.png](02-focus-map.png) | 关注地图 | 大面积主题矩形树图；右侧变化与短建议 |
| [03-change-trends.png](03-change-trends.png) | 变化趋势 | 本期/上期主趋势图；主题迁移、活动日历与短建议 |

## 生成提示词

### 方案一 · 全景总览

```text
Use case: ui-mockup.
Create a single high-fidelity raster screenshot of the Mona Chinese desktop application's USER PROFILE DATA DASHBOARD. This is a shippable, polished desktop analytics interface, completely front-on and full bleed, landscape 16:10, high resolution, razor-sharp readable Chinese typography, no surrounding device, no perspective, no presentation board.
Style: quiet precision, calm personal workspace. Light warm-gray application chrome #F2F2ED, pure/near white main data surface, charcoal text, subtle #E4E4DF dividers. Data colors chiefly emerald #0E9F6E, blue #4F9DE8, restrained amber. Hairline borders, consistent 8px corner radius, subtle grouping not many nested cards. Compact contemporary Chinese sans serif (PingFang/Inter-like). Information-rich but readable: prioritize chart area and clear numbers.
Shared app shell: narrow 60px left rail with Mona black cat mark at top, a few small monochrome icons and labels for 会话, 笔记, 资料, 画像. 画像 selected with a very small red brand marker. Thin app titlebar with 'Mona' and Windows controls. Main header '用户画像' in modest 22px type, tabs '总览' '关注变化' 'AI 建议', right '近 30 天' and tiny refresh icon. No giant hero, no avatar card, no biography or welcoming paragraph.
Use the same plausible SYNTHETIC values: '对话 64', '用户消息 312', '生成成果 27', '活跃日期 18'. A small footer reads '示例数据 · 近 30 天'. Do not imply real user data.
All user visible language Chinese, apart from common technical names like RAG or AI. Charts describe records, topics and activity, NEVER skill mastery, personality, confidence percentage, productivity score, saved hours, or “needs strengthening”. No 'AI眼中的我' card. No settings, pencil/edit icons, forms, save buttons, toggles, feedback controls, explanatory text walls or task checklists. Each observation under 16 Chinese characters. Advice compact and secondary; maximum two short lines per recommendation, with a small text link '开始 →'. No modal, no empty states.

Composition: an elegantly aligned panoramic analytical dashboard. Top KPI ribbon is four compact columns with large numerals and tiny 30-day sparklines, no individual floating giant metric cards.
Main section has a 2/3-width activity line chart on the left, titled '对话与成果', fine horizontal guides, eight sparse date ticks from 08/10 to 09/08, two carefully drawn lines with small understated legend '对话' green and '成果' blue. Right third is a segmented donut chart titled 'AI 协助分布', labels '开发 42%' '研究 26%' '写作 19%' '设计 13%'. Direct labels outside chart, neat legend.
Second chart band: left 1/3 is an airy six-axis radar titled '关注领域', the axis means '话题记录数', labels 'AI 应用' '产品' '开发' '设计' '写作' '研究'; no skill score. Middle 1/3 is a readable small topic relationship network titled '主题关联', large green node 'AI 应用' linked to 'RAG' 'Agent' '自动化' '产品设计' '文档', subtle curved lines, no avatar. Right 1/3 a horizontal ranked bar chart titled '近期关注', labels 'AI 编程' '产品设计' '知识检索' '内容创作', real-looking counts '28' '24' '16' '12', small sparklines optional.
A bottom full-width quiet advice strip takes about 17% height. Heading 'Mona 的建议', three compact columns divided by thin vertical rules; each has one small colored dimension tag:
'学习补充' / '学会 RAG 的召回评估' / '用 10 条真实问题做一张评分表' / '开始 →'
'方法改进' / '把需求写成验收条件' / '从最近一次返工提炼 5 条条件' / '开始 →'
'成果沉淀' / '提炼一份报告模板' / '抽取 3 份报告的共同结构' / '开始 →'
Each chart has proper white space and axis typography. At least 70% of the usable content is charts, numbers and data shapes. The activity chart is the one largest visual focus. Make it look excellent at an everyday desktop window size, not an oversized marketing landing page.
```

### 方案二 · 关注地图

```text
Use case: ui-mockup.
Create a single high-fidelity raster screenshot of the Mona Chinese desktop application's USER PROFILE DATA DASHBOARD. This is a shippable, polished desktop analytics interface, completely front-on and full bleed, landscape 16:10, high resolution, razor-sharp readable Chinese typography, no surrounding device, no perspective, no presentation board.
Style: quiet precision, calm personal workspace. Light warm-gray application chrome #F2F2ED, pure/near white main data surface, charcoal text, subtle #E4E4DF dividers. Data colors chiefly emerald #0E9F6E, blue #4F9DE8, restrained amber. Hairline borders, consistent 8px corner radius, subtle grouping not many nested cards. Compact contemporary Chinese sans serif (PingFang/Inter-like). Information-rich but readable: prioritize chart area and clear numbers.
Shared app shell: narrow 60px left rail with Mona black cat mark at top, a few small monochrome icons and labels for 会话, 笔记, 资料, 画像. 画像 selected with a very small red brand marker. Thin app titlebar with 'Mona' and Windows controls. Main header '用户画像' in modest 22px type, tabs '总览' '关注变化' 'AI 建议', right '近 30 天' and tiny refresh icon. No giant hero, no avatar card, no biography or welcoming paragraph.
Use the same plausible SYNTHETIC values: '对话 64', '用户消息 312', '生成成果 27', '活跃日期 18'. A small footer reads '示例数据 · 近 30 天'. Do not imply real user data.
All user visible language Chinese, apart from common technical names like RAG or AI. Charts describe records, topics and activity, NEVER skill mastery, personality, confidence percentage, productivity score, saved hours, or “needs strengthening”. No 'AI眼中的我' card. No settings, pencil/edit icons, forms, save buttons, toggles, feedback controls, explanatory text walls or task checklists. Each observation under 16 Chinese characters. Advice compact and secondary; maximum two short lines per recommendation, with a small text link '开始 →'. No modal, no empty states.

Composition: DIFFERENT spatial design from an ordinary dashboard grid. One expansive main topic TREEMAP is the central visual anchor occupying 62% width and 52% main height, titled '最近，你把注意力放在哪里'. Treemap rectangles, with subtle 5px gutters, use translucent green/blue/amber, large readable embedded labels and tiny count labels. Largest light emerald rectangle 'AI 编程' '28 条记录', medium pale blue '产品设计' '24 条', muted mint '知识检索' '16 条', smaller pale blue '自动化' '12 条', soft amber '内容创作' '10 条', light gray '其他' '8 条'. All typography charcoal, not white on pastel. Above the treemap a thin inline statistics ribbon '64 次对话' '312 条消息' '27 份成果' '18 个活跃日' separated by fine rules.
Right 32% width is a slim insight column with two compact visual sections, not a tall wall of cards: top '关注变化' with three horizontal slope/lollipop comparisons labeled 'AI 编程' '知识检索' '内容创作', old values gray, current emerald or blue, headers '上期' and '本期'; below 'Mona 的建议' with exactly two concise recommendations:
small '学习补充 · 20 分钟', title '学会 RAG 的召回评估', one short line '从 10 条真实问题开始', right text link '开始 →'.
small '成果沉淀 · 15 分钟', title '提炼一份报告模板', one short line '先比较 3 份已有报告', right text link '开始 →'.
Lower full width analytical band about 25% screen: left 2/3 a low-height smooth two-series area/line chart titled '使用趋势' with legend '对话' and '成果' and sparse dates; right 1/3 four horizontal micro-bars labeled '文档 12' '代码 8' '图像 5' '其他 2' under heading '成果构成'.
Show precision in alignment and hierarchy; treemap is a real comprehensible data view, not arbitrary colorful decorative bento blocks. No trend arrows interpreted as abilities. At least 75% content area graphs/visuals/numbers. No hero person, identity summary, editing UI or explanatory paragraphs. This version should feel spacious and confident while still rich in real data visuals.
```

### 方案三 · 变化趋势

```text
Use case: ui-mockup.
Create a single high-fidelity raster screenshot of the Mona Chinese desktop application's USER PROFILE DATA DASHBOARD. This is a shippable, polished desktop analytics interface, completely front-on and full bleed, landscape 16:10, high resolution, razor-sharp readable Chinese typography, no surrounding device, no perspective, no presentation board.
Style: quiet precision, calm personal workspace. Light warm-gray application chrome #F2F2ED, pure/near white main data surface, charcoal text, subtle #E4E4DF dividers. Data colors chiefly emerald #0E9F6E, blue #4F9DE8, restrained amber. Hairline borders, consistent 8px corner radius, subtle grouping not many nested cards. Compact contemporary Chinese sans serif (PingFang/Inter-like). Information-rich but readable: prioritize chart area and clear numbers.
Shared app shell: narrow 60px left rail with Mona black cat mark at top, a few small monochrome icons and labels for 会话, 笔记, 资料, 画像. 画像 selected with a very small red brand marker. Thin app titlebar with 'Mona' and Windows controls. Main header '用户画像' in modest 22px type, tabs '总览' '关注变化' 'AI 建议', right '近 30 天' and tiny refresh icon. No giant hero, no avatar card, no biography or welcoming paragraph.
Use the same plausible SYNTHETIC values: '对话 64', '用户消息 312', '生成成果 27', '活跃日期 18'. A small footer reads '示例数据 · 近 30 天'. Do not imply real user data.
All user visible language Chinese, apart from common technical names like RAG or AI. Charts describe records, topics and activity, NEVER skill mastery, personality, confidence percentage, productivity score, saved hours, or “needs strengthening”. No 'AI眼中的我' card. No settings, pencil/edit icons, forms, save buttons, toggles, feedback controls, explanatory text walls or task checklists. Each observation under 16 Chinese characters. Advice compact and secondary; maximum two short lines per recommendation, with a small text link '开始 →'. No modal, no empty states.

Composition: a trend-centered analyst dashboard with a BROAD SINGLE MAIN CHART occupying around 48% vertical space, different from the previous treemap or multi-panel overview. Under modest main header, arrange four simple inline KPIs '对话 64' '用户消息 312' '生成成果 27' '活跃日期 18' and short positive/neutral comparisons, no cards.
Hero CHART not text: titled '这个月的使用变化', with switchless legend '本期' solid emerald and '上期' gray dashed, clear y-axis labeled '对话数', x-axis relative days '第 1 天' '第 7 天' '第 14 天' '第 21 天' '第 30 天', plotted values create a subtle recent rise. Include a neat lower aligned blue bar series inside this same chart for daily '生成成果', visibly separate axis/unit. Annotate only two points with very small callouts '开始研究 RAG' and '报告模板成形'. No big sentence above the chart.
Beneath, a three-column lower band:
Left 32%: '关注主题迁移' compact slope chart, left column '上期' right '本期', labeled topics '开发' '产品设计' '知识检索' '写作', colored connecting lines showing shift but no false skills. Right aligned small numbers.
Middle 32%: '活动日历' a clear 5-row-by-7-column activity heatmap, weekday labels '一 二 三 四 五 六 日', low-to-high emerald legend; beside it a narrow donut for '成果 27' with tiny labels 文档 / 代码 / 图像.
Right 32%: '下一步值得做' only two small actionable suggestions, with no card stack:
'把 RAG 评估做成小实验' followed by '挑 10 条问题，记录召回结果' and '开始 →';
'把报告结构沉淀为模板' followed by '先抽取 3 份报告的共同栏目' and '开始 →'.
The final image should look like a refined Chinese analytics tool: restrained, sharp, compact, connected by chart rhythm, 80% chart-led. No settings, no user self-description section, no scoring gauges, no paragraphs. Keep the light gray shell and white data canvas; use warm amber only for tiny advice tags and gray for historic data.
```
