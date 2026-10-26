# AI 投研原型生成提示词

模式：内置 imagegen。素材用于 UI 原型，不是功能或研究效果证据。

## 01 开放研究入口

```text
Use case: ui-mockup. Revise the provided Mona 股票 AI投研 new-research prototype to reflect a corrected PRODUCT SCOPE, retaining its visual shell and calm white/neutral-blue design.
ONE full high-fidelity desktop screenshot, readable accurate simplified Chinese. Preserve the 股票 heading, four top tabs with AI投研 active, 关注与提醒 / 研究模型 / 跟进消息, left research-history sidebar with a single neutral '+ 新建研究' button. No global app changes, no devices, perspective, decorative artwork, gradients, black buttons, nested cards or flashy icons.

Critical product correction: AI投研 is an open ongoing research workspace backed by Vibe native Session/tools/skills. The FOUR quick analyses already exist on the investment workbench and MUST NOT appear here as the page's exhaustive top-level analysis types. Do NOT show '综合分析 / 财报与估值 / 走势分析 / 风险检查' as four main choices. Do NOT require a single stock input or trading-period selector on the general AI research start page. A question can concern one company, comparison, an industry/event, or uploaded documents. Workbench-entered tasks may carry their original context; this illustration is the DIRECT ENTRY state.

Main right area:
- Small workspace toolbar title '新的研究'; on far right keep the neutral, optional secondary action '行情证据复核' exactly as an independent limited historical-market-evidence task, not a certificate for all reports.
- A compact centered column about 860px wide near the upper middle of the workspace. Heading '你想研究什么？', with one short muted caption '从一个问题开始，也可以附上需要解读的资料。'
- Directly below, ONE generously readable editable question textarea (about 150px high), showing this concrete multi-company question:
  '对比 600519 和 000858 的盈利质量，重点看现金流和负债。'
- An immediately adjacent footer row for this same input: paperclip text '添加资料', a small neutral attachment chip '对比资料.pdf  ×', subtle '单份最多 8MB', and exactly one BLUE primary button '开始研究 →' on the right. No separate stock selector, no wave/swing selector, no competing send button, no huge blank gap between the question and its action.
- Below the input/footer cluster, a small understated heading '也可以这样问' and three compact neutral example-question text buttons arranged as tidy rows, not feature cards, not exhaustive categories:
  '帮我解读这份财报的主要变化'
  '这条公告可能影响公司的哪些业务？'
  '行业需求变化，会影响哪些公司？'
  Each example may have a small neutral outline icon or diagonal arrow. These ONLY insert editable questions and do not execute, certify or promise all data available.
- Keep the layout restrained, natural and compact. No claim that all 30 teams or all advanced quantitative capabilities are already available; do NOT add arbitrary strategy, fund, backtest or factor buttons. No recommendation scores, investment advice, fake metrics, capability marketing copy or methodology jargon.
- Sidebar '研究记录', search '筛选最近研究'; use example human-readable research titles spanning different questions:
  今天: '600519 与 000858 · 盈利质量对比', '一份公告的业务影响', '002460 · 财报与估值'
  昨天: '行业需求变化', '现金流与回款问题'
  Secondary dates: 今天 10-19 / 昨天 10-18. No colored completion badges or cards.
- Tiny footer outside functional content: '交互原型 · 研究记录与附件为示例'.

Goal: the screen immediately communicates that users bring an investment research QUESTION, rather than selecting one of four fixed algorithms. One clear start action, useful history, cohesive question/attachment input, preserved existing Mona shell.
```

## 02 已有研究阅读与追问

```text
Use case: ui-mockup. Create the SECOND STATE of the same Mona 股票 / AI投研 prototype, using the attached generated new-research screenshot as the strict visual layout reference.
Preserve its entire application shell, four stock tabs, warm white palette, left research sidebar, neutral ordinary buttons, typography and proportions. This is one full front-facing desktop screenshot, high-resolution crisp readable simplified Chinese, approximately 2560x1600. No device, presentation board, perspective or annotation arrows. Do not add global navigation, colorful cards, black buttons, gradients, new financial features or metrics. All report and record content is a clearly labelled prototype example, not real financial research.

Change ONLY the main workspace from new-research form to a COMPLETED RESEARCH reading and follow-up state, plus select the corresponding left history row:
- Left sidebar unchanged structure, neutral '+ 新建研究', heading '研究记录', search placeholder '筛选最近研究'. Select '002460 · 财报与估值' with a quiet pale-blue/neutral-tinted highlight. Other rows in muted text. Group 今天 and 昨天; all displayed date labels should be 10-19 and 10-18, never 2025-04 dates.
- Main upper toolbar: '财报与估值 · 002460' on left, the same neutral secondary '行情证据复核' on far right. Keep this as a separate optional action, not a passed badge.
- Main continuous reading area with width around 860px, vertically starting comfortably below toolbar. Small context line '002460   ·   波段   ·   今天 10:32 完成' in muted text. A clearly but subtly marked '示例报告' label so nobody mistakes these example words for an actual company conclusion.
- Retain user's original question near top as a plain medium-weight line: '这家公司的盈利增长，有现金流支持吗？'. Below, a thin divider, no card.
- A short report with clean readable hierarchy, no separate conversation log duplicating it:
  Heading '先看结论'
  Text: '现有资料还不足以确认利润增长已转化为现金流，需要结合回款情况继续核查。'
  Heading '本次查看的资料'
  Two restrained document/source rows: '年报.pdf · 用户提供' and '利润表与现金流量表 · 报告引用'.
  Heading '还需要核实'
  Two concise bullets: '经营现金流与利润变化是否一致' and '应收账款变化是否影响回款'.
  Text source superscripts [1] can be used subtly, but no fake external URLs, official-data seals, grades, confidence percentages, buy/sell advice or numerical company metrics.
- Under the report, two compact neutral text actions with outline icons: '查看研究依据' and '导出 Markdown'. These open evidence details / download, not inline disclosure panels or cards. No fake green validation certification.
- At the bottom of the same main content column, a quiet thin divider and ONE compact follow-up composer. Label '继续追问' above an editable 2-line text area. Example typed follow-up: '现金流偏弱，可能只是回款时间不同吗？'. Under it, paperclip '添加资料', a small attachment chip '年报.pdf · 沿用  ×', and exactly one muted-blue primary '继续追问 →' on the right. The composer remains near the result, with comfortable bottom spacing, not separated by half an empty screen.
- Do not add top '开始一项研究', duplicate '新建研究' buttons, a second '会话记录' panel, red/green metrics or more layers of tabs.
- Tiny footer outside the functional content: '交互原型 · 报告内容与记录为示例'.

Quality goals: this feels like the direct continuation of the first prototype; a beginner can tell which question was answered, what report they are reading, where to inspect sources, and how to continue the same research. All visual emphasis stays on the user's question, the answer, and the one next action.
```
