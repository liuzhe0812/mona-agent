# Mona 股票模块原型生成提示词

- 生成方式：内置 image_gen
- 类型：ui-mockup，高保真桌面界面图片
- 用途：方案讨论；所有数字、连接和验证状态均为示例
- 参考图：用户提供的现有 Mona 股票页面，仅作为外壳与视觉风格参考
- 最终产物：01-investment-workbench.png、02-strategy-lab-v2.png、03-shadow-account.png

以下保存最终提示词规格，供后续统一修改和重新生成。原始参考图不进入产品资产；生成后的三张最终图片保存在本目录。

## 通用提示词

Create a high-fidelity raster desktop UI prototype for Mona's A-share investment product. Landscape approximately 2880 by 1704. Flat front-facing application screenshot, no device frame, no perspective, no annotations outside the application. Crisp, legible Simplified Chinese typography.

Preserve the recognizable Mona app shell from the reference: narrow left global navigation with 股票 selected, Mona title bar and window controls. Use warm neutral gray shell, almost-white content, charcoal typography, thin warm-gray separators, restrained rounding. Active module tabs use a short red underline. Chinese financial convention: gains red, losses green. Blue is reserved for forecast data and information links. Avoid decorative gradients, glass, heavy shadows, large hero titles and nested cards. Keep the chart or analysis as the visual focus.

Top module navigation: 股票, 投资工作台, 机会选股, AI投研, 策略实验室, 账户与复盘. Include a stock search field, a 示例数据 label, and a compact second-row cycle control: A股, 超短线, 波段, 中短线. 波段 is selected in these examples. Bottom note: 设计原型，行情、账户、规则和收益均为示例. No fabricated win-rate or confidence percentages.

## 投资工作台提示词

Create the 投资工作台 page with the common shell. Use three columns: watchlist and research tasks on the left, selected-stock chart and linked research in the middle, judgment and holding plan on the right.

Left: 自选与持仓, 自选5 and 持仓3. Selected 天赐材料002709, quote29.46, change+1.24%, 持仓. Other example rows: 宁德时代300750 186.20 -0.84%; 中际旭创300308 138.60 +2.15%; 紫金矿业601899 17.84 +0.90%; 贵州茅台600519 1512.00 -0.52%. Use compact sparklines. Below show 今日机会: 趋势回踩2只, 事件催化1只. Show research tasks 天赐材料综合研究已完成 and 回踩策略验证运行中.

Center: 天赐材料002709, quote29.46, +0.36, +1.24%. Stats 今开29.13, 最高29.68, 最低28.96, 昨收29.10. Tabs 走势预估, 研究结论, 资讯公告, 基本面. Large chart 行情与走势预估. Actual red line runs from09:30 to14:30 and ends exactly29.46. A vertical 现在 divider at14:30 separates the future interval to15:00. Future is a pale blue widening interval from roughly29.20 to29.75, with blue dashed middle path ending29.60. Actual volume bars exist only before现在. Legend actual and forecast clearly. Summaries: 当日收盘29.20–29.75偏强; 未来3日28.90–30.60震荡偏强; 未来5日28.60–31.10震荡偏强. Link 查看预测表现.

Under the chart show 关联投研: 研究任务 → 专家协作 → 证据核查 → 研究报告. Findings: 技术研究量价配合改善; 基本面研究关注业绩兑现; 风险审查上方压力仍在. Actions 查看完整报告 and 将判断转为策略. Small contextual question input at bottom.

Right: 当前判断, 14:30更新, headline 短线偏强，关注回踩承接. 已持有 selected. Holding2000shares, cost28.60, unrealized gain1720, portfolio weight19.6%. Plan: 持有观察; 回踩观察29.10–29.30; 关键支撑28.90; 上方压力30.20; 跌破支撑或板块转弱重新评估. Primary action 开启条件提醒. Two attention items: 宁德时代接近观察价位, 紫金矿业明日有重要公告. Account summary 东方财富已连接, assets300000, total position66%, links to holdings, trade review and Shadow comparison. Every datum is a mockup example.

Final edit instruction: Add the shared A股 and 超短线 / 波段 / 中短线 control in the second toolbar, preserving all page content. Keep 行情更新14:30:05 at the right. The search button reads 搜索.

## 策略实验室提示词

Create the 策略实验室 page using the same shell and typography. Left sidebar 我的策略 with selected 趋势回踩策略, 波段, 样本外验证完成. Additional rows 业绩改善策略待验证 and 放量突破策略研究中. Factor library categories 价量因子, 基本面因子, 学术因子.

Main title 趋势回踩策略v1.2, based on a research hypothesis, A股波段. Actions 查看规则, 导出, and primary 进入影子观察. Workflow 研究假设 → 策略生成 → 历史回测 → 样本外验证 → 影子观察. First four completed, final pending. Tabs 概览, 交易规则, 回测结果, 验证记录, 版本.

Example run dates2024-01-02 through2026-09-30; out-of-sample2026-01-01 through2026-09-30. Metrics after-cost return+12.8%, benchmark+7.3%, max drawdown-8.4%, completed trades64. Large normalized-equity chart starts100, strategy ends112.8, benchmark107.3, out-of-sample boundary marked. Smaller drawdown chart beneath.

Right validation panel: 数据覆盖完整, 样本外检验已完成, 收益重采样已完成, 成本敏感性已完成. Verdict 可进入影子观察, continue observing new data, and a link to the full validation report. Settings initial capital100000, execution at next trading time, A股rules, costs and slippage included, 沪深300benchmark. Downloadable artifacts: 净值与交易明细, 策略代码与参数, 数据与版本记录.

Recent trades table: 天赐材料2026-09-08 to09-15, 5tradingdays,+3.6%; 紫金矿业09-10 to09-18,6days,+2.1%; 宁德时代09-16 to09-21,3days,-1.4%. Related research link 新能源材料回踩机会. All performance and validation statuses explicitly illustrative.

Final edit instruction: Replace only the right validation checklist label 随机对照 with 收益重采样. Preserve its completion icon and all other elements. The v2 image is the selected final; the first image is retained as an intermediate version.

## 影子账户提示词

Create the 账户与复盘 page with inner tab 影子账户 selected. Same shell and compact trading-cycle controls. Left account sidebar: 东方财富已连接, holdings and today's trades synchronized; historical trades supplemented by file,2026-01 through09. Actions 添加券商 and 导入成交. Review history 当前影子账户, 九月交易复盘, 八月交易复盘. Data coverage and last update shown.

Main title 我的影子账户v1.0. Subtitle 从历史盈利交易提炼规则，并检验执行差异. Actions 导出报告, 查看策略代码, primary 扫描今日信号. Native pipeline: 真实成交 → 盈利规则提取 → 策略回测 → 差异归因 → 今日信号.

Separate rule extraction2026-01-01 through06-30 from validation2026-07-01 through09-30. Show comparison conditions: same initial funds, fees and trading constraints. Initial capital100000, deposits0, withdrawals0. Metrics actual return+4.2%, Shadow return+7.1%, after-cost difference+2900yuan. Chart starts100; charcoal actual line ends104.2, muted-blue Shadow107.1, gray沪深300benchmark103.5. Note Shadow result is a rule backtest.

Rules panel: source18profitable completed roundtrips; participate after a supported high-volume pullback; holding3–10tradingdays; exit when key support breaks. Versionv1.0 formed in extraction period and frozen during validation. Link to complete rules and samples.

Difference bars: 偏离入场规则+1200, 提前退出+900, 仓位差异+500, 其他因素+300; their sum is2900. Label these as estimated differences under a fixed-rule replay. Review suggestion 优先检查提前退出的交易, with actions 查看相关成交 and 新建验证任务. Related trades table shows 天赐材料提前退出, 紫金矿业仓位偏高, 宁德时代入场偏早; effects待复核. All data and statuses are examples; no promise of future profit.

## 使用说明

图片用于讨论信息结构与关键流程。具体数据、金融计算与可用状态由方案中的真实能力和验收标准约束。后续界面实现须使用 Mona 共享组件与语义变量，并以真实数据替换示例。
