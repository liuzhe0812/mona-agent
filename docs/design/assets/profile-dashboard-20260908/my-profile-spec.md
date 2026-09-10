# 我的画像：第一个页签的重设计

- 图片：[06-tab-my-profile.png](06-tab-my-profile.png)
- 状态：本次重生成的第一页签原型，未按图修改运行界面。
- 生成方式：内置 image_gen。
- 视觉参考：04-tab-focus-changes.png；规范以 docs/design/mona-ui-design-system.md 为准。
- 三个并列页签：我的画像、变化轨迹、AI 建议。
- 我的画像：关注领域雷达、主题关联、常见协作类型、常见交付物、领域与协作方式矩阵。
- 趋势、时间比较和活动日历归属变化轨迹；行动建议归属 AI 建议。
- 不使用设置表单、编辑卡片、身份介绍卡或大段文字。
- 数字、连线、图表均为原型示例；实现时用真实数据和准确坐标生成图表。

## 完整生成提示词

```text
Use case: ui-mockup. Produce ONE high-fidelity, implementable screenshot of the FIRST TAB of Mona's user-profile dashboard.
Reference image 1 is the approved Mona visual-language reference. Preserve its application chrome, narrow sidebar, spacing scale, white main surface, compact centered toolbar, Chinese system typography and understated neutral styling. Replace all content to depict a different tab. This is not the reference's trends page.

OUTPUT: a full desktop screen, front-on, landscape matching the reference's aspect ratio (around 1.68:1), high resolution and sharply readable Chinese. No device frame, no perspective, no design-board annotations.
SHELL: Same small 'Mona' Windows titlebar, 64 logical px narrow gray rail with outline icons and Chinese module labels 会话、笔记、文档、终端、邮件、计划、数据库、系统、股票、画像. 画像 selected by a thin red vertical line. One white main work surface with outer 12px corner radius only. No cats, avatars or character illustrations.
TOP TOOLBAR: left '用户画像 · 近 30 天'. Center THREE PARALLEL TABS, exact names '我的画像' '变化轨迹' 'AI 建议'. FIRST TAB '我的画像' selected by a thin RED underline and dark text. Other tabs gray. Same 12px logical typography for all tabs. Right small refresh icon and one neutral CHARCOAL button '更新画像'. Do not use the labels 总览 or 关注变化.
MANDATORY UI RULES: exterior #F2F2ED, pure white data canvas, charcoal #1A1A1A and gray #6B6B67 text. Borderless chart sections organized by whitespace, aligned edges and occasional single faint divider. No outlined card wall, no nested cards, no colored panel backgrounds, no gradients, no shadows. Chart series emerald, blue, restrained amber, plus gray when needed; control colors remain neutral. Typography like system Chinese sans serif: headings 16px semibold, chart labels 13px, toolbar 12px, key numerals 28px. No giant titles.

PURPOSE: this page shows a structured picture of the user's interests, topic relationships and collaboration patterns. It is NOT an overview of other tabs. Display NO time-series chart, trend sparkline, previous/current comparison, date calendar, percent-growth badge, AI advice, learning action, settings form, edit control or user biography. No giant 'AI眼中的我' summary card. Never call topic counts skills or mastery.

LAYOUT: dense yet calm professional data dashboard, same full-width content footprint as reference. Four small inline summary counts at top, no metric card borders: '关注领域 6', '关联主题 18', '协作类型 4', '支撑会话 64'. Use charcoal numerals, subdued labels. Keep this ribbon shallow, about 90 logical pixels maximum.

UPPER DATA BAND (roughly 48% remaining height):
LEFT 34%: '关注领域', a large precise six-axis radar with an emerald outline and very light transparent fill. Radius axis labeled '相关记录数', ticks 10/20/30. Labels around radar: 'AI 应用', '产品设计', '软件开发', '知识检索', '内容创作', '效率工具'. Plausible current values 28,24,20,16,12,10. Only one series, no comparison, no ability ratings.
RIGHT 63%: '主题关联' with a spacious, polished topic co-occurrence graph as the page's central visual anchor. Three related topic clusters, clear small connected circles:
largest emerald core 'AI 应用' linked to 'RAG', 'Agent', '自动化', '检索评估';
medium blue core '产品设计' linked to '需求分析', '交互设计', '数据可视化';
small amber core '内容创作' linked to '报告写作', '教程', '笔记'.
A few thin neutral cross-cluster edges, e.g. RAG–笔记, 自动化–需求分析, 数据可视化–报告写作. NO central person/avatar. Avoid random spaghetti; lots of breathing room between short labels. Under title tiny subtitle '同一记录中的共同出现'; total 13 core nodes shown, overall count 18 can refer to all recorded topics. Three small colored-dot legend labels only.

LOWER DATA BAND (roughly 34% remaining height), three borderless columns with optional fine vertical dividers:
1) LEFT 30% '常见协作类型': medium donut chart with center '64' and '次协作'. Four series green/blue/amber/gray, compact direct labels and legend: '开发 27', '分析 17', '写作 12', '设计 8'. These sum to 64. No percentages necessary.
2) MIDDLE 30% '常见交付物': four thin horizontal bars with direct count labels '文档 12', '代码 8', '图像 5', '其他 2'. Small header-side '27 份记录'. Green/blue/amber/gray colors consistent with chart semantics; modest axes and equal bar spacing.
3) RIGHT 35% '领域 × 协作方式': a readable 4x4 heatmap matrix, columns '开发' '分析' '写作' '设计', rows 'AI 应用', '产品设计', '知识检索', '内容创作'. White-to-muted-green cells encode relative number of records, simple low/high legend. It displays how domains and task types intersect; do not use skill level names or words like 精通, 能力, 补强. Cells are chart marks not editable form inputs.

Small unobtrusive bottom footer: '示例数据 · 近 30 天'. No prose blocks or explanations elsewhere. Make chart labels, connected nodes and the matrix actually readable. The final page should communicate the user's current profile at a glance and feel unmistakably part of the same refined native Mona app as the reference.
```

