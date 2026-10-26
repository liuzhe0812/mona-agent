# 统一策略库原型提示词

- 工具：内置 `image_gen.imagegen`，通过 imagegen 技能生成；没有使用 CLI、HTML、CSS、SVG 或 React 代替原型图像。
- 类型：全新 `ui-mockup`；仅依据 Mona 当前设计规范，未编辑旧原型。
- 用途：2026-10-21 新设计的交互评审；画面中的自定义策略、股票和绩效为演示。
- 输出：`01-library-selection.png`、`02-strategy-backtest.png`、`03-ai-create-strategy.png`。
- 迭代：首轮生成后，以第一张的完整布局作为三张最终图的共同参照；下文保留首轮提示，最终使用文末对应修订提示。首轮弃选图片留在工具默认生成目录，项目只保存最终版本。

### 03 最后微调

在三张布局修订后，仅对第03张追加下面的精确修订。输入为该轮第03张，文件名 `exec-da20f4e0-f4b4-4d68-96a3-95faee5cde22.png`，位于与下文参照相同的工具生成目录。

```text
Use case: ui-mockup, precise small state correction. Input image is the edit target. Preserve the exact whole Mona window, all text, geometry, strategy content, conversation dialog and generated artifact. Only ONE strategy can be selected: keep the custom row 多因子排名·5只/10日 selected with its red marker, and remove the red marker and gray selected background from the original 多因子排名 row at the top of the left list. That original row is an ordinary unselected built-in example. Keep the matching custom strategy title in the right workspace. As a small style correction make the user chat bubble neutral light gray rather than light blue, and replace the small robot avatar with a simple neutral M avatar. Do not add any new controls, scores, financial results or words. All other pixels and readable Chinese text remain as they are. Keep the demonstration footer.
```

## 01-library-selection.png

```text
Use case: ui-mockup
Asset type: high fidelity Chinese desktop app interaction prototype, one complete screen, landscape 1920x1200.
Primary request: Design the future Mona stock opportunity workspace as ONE unified strategy library. Render a crisp realistic desktop UI, not a conceptual dashboard or presentation. This is a review prototype, not evidence of implemented features.
Style: Mona is a quiet personal workstation. Warm neutral light gray app shell, near-white content, charcoal text, muted gray secondary text, thin red underline only for the active main stock tab. Existing semantic palette: shell #F2F2ED, content #FFFEFA, ink #1A1A1A, secondary #6B6B67, separators #E4E4DF, primary button #3C3F43. No orange/yellow wash, gradients, bright blue buttons, glow, heavy shadows, nested cards, giant empty areas or decorative finance graphics. Chinese sans-serif, readable text, consistent tight alignment. UI text follows normal desktop hierarchy: body 14, controls/captions 12, page heading 20. Use whitespace and small tone changes rather than boxes.
Composition: full app window with 64px left app rail: 会话, 开发, 笔记, 文档, 邮件, 计划, 股票. Stock is selected. Across content top: 股票, then 投资工作台, 机会选股 (active red underline), 账户与复盘. Below, a compact toolbar reads 策略库, with search field 搜索策略 and right actions 历史记录 and 用 AI 创建策略. No AI选股/策略研发 mode tabs.
Below toolbar use a 288px strategy list and a spacious continuous right work surface. List source filters are plain text 全部 内置 自定义, then a compact market filter 中国A股. Selected row 多因子排名 with subtle gray selected background and small red marker. Its small neutral labels are 内置 and 示例. Other visible real upstream names: 技术指标综合; 基本面过滤 (需财务数据); 一目均衡表; K线形态综合; 波动率分位. Include one demonstration custom row 多因子排名·5只/10日 with label 自定义. List footer text 查看全部市场. The list has enough rows to feel useful, a modest scroll indicator, no huge cards or colorful icons.
Right work surface: heading 多因子排名, small neutral labels 内置 示例, small link 用 AI 修改. Below a concise rule sentence: 动量、反转、低波动和量比综合排名，选前3只，每20个交易日调仓. Small line 中国A股 · 日线. Then plain text tabs 选股 回测 规则, 选股 active. A short inline form 股票范围 [我的自选（12只）v], 数据截止 [最近完整交易日 v], secondary 参数, and one charcoal 开始选股 button. Below, results header 本次选股 and small metadata 演示数据 · 2026-10-20. A readable dense table with columns 股票, 目标权重, 信号日期, 操作. Three illustrative rows: 600519 贵州茅台 / 33.33% / 2026-10-20 / 看行情 加自选; 000333 美的集团 / 33.33% / 2026-10-20 / 看行情 加自选; 601318 中国平安 / 33.33% / 2026-10-20 / 看行情 加自选. Under table a concise note 目标权重来自策略输出，交易生效时点以数据和市场规则为准. A lightweight text link 查看本次规则与数据依据. In lower space show a compact 本策略最近记录 with two demonstration rows marked 选股 and 回测, dates, 查看, no made-up performance claims.
Text constraints: Use exact Chinese labels. Keep all labels legible and the complete window uncropped. Footer discreetly says 原型演示，名单为示意. No probability, recommendations, profit promises, buy now button, activation/publish/approval workflow, model or internal tool/port names. The main visual focus is the strategy and actual work, not buttons.
```

## 02-strategy-backtest.png

```text
Use case: ui-mockup
Asset type: high fidelity Chinese desktop app prototype, one complete screen, landscape 1920x1200.
Primary request: Show the BACKTEST tab of the same unified Mona strategy library. Keep the exact same application frame, 288px strategy list, header, typography and spacing described here. The strategy is already chosen in the library; there must NOT be another strategy selector or a separate backtest product/modal.
Style: quiet Mona light workstation, shell #F2F2ED, content #FFFEFA, ink #1A1A1A, muted #6B6B67, thin #E4E4DF separators, charcoal #3C3F43 primary action, red only for active main navigation. Minimal boundaries and no card wall, gradients, neon, giant KPI tiles, decorative market graphics. Chinese sans-serif, normal readable desktop body 14/control 12/page heading20, compact data density.
Composition: left64px app rail 会话 开发 笔记 文档 邮件 计划 股票, stock active. Main top 股票 and tabs 投资工作台 / 机会选股 (red underline active) / 账户与复盘. Toolbar 策略库 with 搜索策略, 历史记录, 用 AI 创建策略. Below, left list source filters 全部 内置 自定义 and 中国A股 market filter. Selected 多因子排名 with 内置 示例 labels. Other real upstream list items 技术指标综合, 基本面过滤, 一目均衡表, K线形态综合, 波动率分位, plus a custom demonstration row 多因子排名·5只/10日 labelled 自定义. List footer 查看全部市场.
Right: heading 多因子排名 with 内置 示例, link 用 AI 修改. Exact summary 动量、反转、低波动和量比综合排名，选前3只，每20个交易日调仓. Metadata 中国A股 · 日线. Tabs 选股 回测 规则 with 回测 active. Short inline controls 股票范围 [我的自选（12只）v], 回测区间 [2025-01-01 — 2026-10-20], 初始资金 [100000], lightweight 费用与设置 action, one charcoal 开始回测 button. A slim line below states 本次使用当前策略版本与参数 and a 查看本次参数 text action. No strategy dropdown here.
Results section 回测结果, a small clearly visible 演示数据 label. Three modest inline metrics, not cards: 累计收益 +8.6%, 最大回撤 -6.2%, 交易次数 18. Below a realistic restrained equity line chart taking most work-surface width, light grid, y-axis net-value, x-axis dates2025/2026, a dark solid strategy curve and gray dashed benchmark; legend 策略净值 / 比较基准. This is visual illustration only, no recommendation or actual strategy evidence implied. Below chart text actions 交易记录, 持仓, 费用明细, 完整报告. Bottom compact history table columns 运行时间 期间 状态 操作, with one illustrative 已完成 row and 查看. Footer inside image clearly says 原型演示，收益与图表为示意.
Constraints: natural consistent UI, all Chinese text legible, full window uncropped. No separate lab, no duplicate strategy selection, no AI research workflow menu, no confidence score or verified-profitable badge, no publish or approval steps. Selection and backtesting share one strategy context.
```

## 03-ai-create-strategy.png

```text
Use case: ui-mockup
Asset type: high fidelity Chinese desktop UI interaction prototype, full landscape screen1920x1200.
Primary request: Show natural-language strategy creation/modification in the SAME unified Mona strategy library, using one existing-style research conversation dialog. Demonstrate that the real generated artifact appears as a custom strategy in the same list. This is a future interaction prototype with demonstration data.
Style: quiet warm-neutral desktop workstation, shell #F2F2ED, near-white #FFFEFA work surface, charcoal #1A1A1A, secondary #6B6B67, light boundaries #E4E4DF, charcoal primary action, red only active main nav. No bright colored bubbles, gradients, neon, nested heavy cards, cartoon robots, financial sci-fi or heavy drop shadows. Crisp Chinese sans-serif, body14, controls12, aligned compact layout.
Frame: full app window,64px rail 会话 开发 笔记 文档 邮件 计划 股票, stock active. Stock navigation 投资工作台 / 机会选股 (red underline active) / 账户与复盘. Under it the unified library toolbar 策略库, 搜索策略, 历史记录, 用 AI 创建策略. Left288px list with filters 全部 内置 自定义, and real entries 多因子排名 (内置 示例), 技术指标综合, 基本面过滤, 一目均衡表, K线形态综合. A newly generated demonstration entry 多因子排名·5只/10日 is visible and selected with 自定义 label. In the right main surface, the matching strategy title with 自定义 and 尚未回测, and tabs 选股 回测 规则 remain visible behind the dialog.
Conversation overlay: one large calm dialog around 900px wide, centered slightly to right without obscuring the library list. Title 用 AI 修改策略, compact close icon, small source line 来源：多因子排名. Body is an ordinary readable conversation, not a wizard. User message exactly: 基于多因子排名，把持股数改为5，换股间隔改为10个交易日，另存为我的策略。. AI response exactly: 已生成“多因子排名·5只/10日”，持股数为5，每10个交易日调仓，其余规则沿用来源策略。 followed by 尚未回测，可在策略库继续选股或回测。. Below response, a compact inline artifact panel says 多因子排名·5只/10日 with neutral labels 自定义 代码已就绪 and one clear 查看策略 action. Small provenance caption 来自本次生成结果. Do not show source code, hashes, file paths, internal tools or ports in the default chat.
At dialog bottom normal multiline composer placeholder 继续描述你想调整的规则… with attachment icon and send arrow. No approval step, no save/publish activation button, no preselected four-card research directions, no need for user to learn factors before using the library. No extra second conversation or second strategy database UI. A discreet overall footer says 原型演示，自定义策略与对话为示意. Full window uncropped and text legible.
```

## 最终修订提示与输入

三次调用均以首轮 `01` 图片为本地参照/编辑目标：`C:/Users/liuzhe/.codex/generated_images/01a15eb8-06ff-71c0-89f4-732fa5c1b1b1/exec-6e8533ed-b82f-47fc-9a61-380ed9b94262.png`。下列顺序对应最终 `01 / 02 / 03`，通过 `referenced_image_paths` 传入；不使用 `num_last_images_to_include`。

### 最终 01

```text
Use case: ui-mockup, precise revision of an existing interface image.
Input image 1 is the EDIT TARGET: the Mona unified strategy library with selection results. Preserve its exact full-window layout, app rail, top stock navigation, dimensions, neutral colors, fonts, strategy list, selection controls, table and actions. Do not redesign the frame or add fields.
Make only these factual copy corrections: every built-in row including 技术指标综合, 基本面过滤, 一目均衡表, K线形态综合, 波动率分位 should show two small neutral labels 内置 and 示例, as 多因子排名 already does. Retain 需财务数据 on 基本面过滤 without duplicating a long warning. The custom row remains 自定义. In the recent-history table set both row execution dates to 2026-10-20. The backtest row period must be 2025-01-01 至 2026-10-20, so there are no future dates relative to its execution. Preserve the visible 演示数据 label and footer 原型演示，名单为示意. Keep all text crisp, no additional scores or filters, no other changes.
```

### 最终 02

```text
Use case: ui-mockup, precise state change of an existing interface image.
Input image 1 is the EDIT TARGET and exact layout reference. Preserve its complete application frame, top stock navigation, toolbars, exact left strategy-list width and position, neutral style, typography, app rail, selected 多因子排名 row, source filters and header. All built-in strategy rows show neutral 内置 and 示例 tags; custom row shows 自定义. Do not invent a different app shell, global search, badges or new menu.
Change only the right strategy workspace from 选股 to 回测. Retain title 多因子排名, 内置 示例, 用 AI 修改, original one-sentence rule and 中国A股 · 日线. The three tabs remain 选股 回测 规则, with 回测 now active. Replace selection controls with a compact backtest toolbar: 股票范围 [我的自选（12只）], 回测区间 [2025-01-01 — 2026-10-20], 初始资金 [100000], a quiet 费用与设置 action and one charcoal 开始回测 button. Do not add another strategy selector.
Below show 回测结果 and a visible 演示数据 label. Three understated inline metrics: 累计收益 +8.6%, 最大回撤 -6.2%, 交易次数18. Render a wide readable net-value chart, muted light grid, charcoal solid 策略净值 and gray dashed 比较基准（示意）. The strategy curve starts exactly at net value1.00 and ends1.086, consistent with the displayed +8.6%, with plausible drawdowns. No invented confidence, recommendation, factor contribution, stock or industry score. Below chart plain actions 交易记录 持仓 费用明细 完整报告. A compact history row may show execution time 2026-10-20 15:32, period 2025-01-01 至 2026-10-20, 已完成, 查看. Footer states 原型演示，收益与图表为示意. Preserve full-window dimensions and all unchanged left-side elements; keep text legible, no extra cards or controls.
```

### 最终 03

```text
Use case: ui-mockup, precise state change of an existing interface image.
Input image 1 is the EDIT TARGET and exact shared layout reference. Preserve its full application shell, 64px rail, 股票 header and three top tabs, strategy-library toolbar, left-column width and strategy-list style. Do not invent a new app shell or unrelated global search. All built-in rows show neutral 内置 and 示例 tags.
Select the existing demonstration custom row 多因子排名·5只/10日 in the left list, label 自定义. In the right workspace heading show 多因子排名·5只/10日, neutral 自定义 and 尚未回测, with the same 选股 回测 规则 tabs. This newly generated strategy has NOT been run: replace the old result table with a quiet 尚未运行选股 empty state, stock scope 我的自选（12只） and data cutoff 最近完整交易日. Absolutely do not show industry filters, estimated company valuation/growth scores, market-wide selection, fictitious probabilities or arbitrary extra form fields behind the dialog.
Overlay one existing-style calm conversation dialog, around900px wide, centered slightly right while the library list remains visible. Title 用 AI 修改策略 with close icon; source line 来源：多因子排名. User message verbatim: 基于多因子排名，把持股数改为5，换股间隔改为10个交易日，另存为我的策略。. AI reply: 已生成“多因子排名·5只/10日”，持股数为5，每10个交易日调仓，其余规则沿用来源策略。 Then: 尚未回测，可在策略库继续选股或回测。. Under the response a compact artifact strip: 多因子排名·5只/10日, 自定义, 代码已就绪, 查看策略; small caption 来自本次生成结果. One ordinary composer at bottom with placeholder 继续描述你想调整的规则… and send arrow. No source code, internal file paths, tools, extra wizards, publish/save approval button, second chat or fabricated execution success. Footer 原型演示，自定义策略与对话为示意. Preserve neutral shared typography/colors and full uncropped frame. Default AI conversation text is normal prose rather than oversized cards.
```
