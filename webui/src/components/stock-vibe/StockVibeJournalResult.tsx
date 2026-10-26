import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { StockVibeInfo } from "./StockVibeInfo";

type Data = Record<string, unknown>;
const FORMATS: Record<string, string> = { eastmoney: "东方财富", tonghuashun: "同花顺", futu: "富途", generic: "通用成交文件" };
const SIDES: Record<string, string> = { buy: "买入", sell: "卖出", dividend: "现金分红" };

function record(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
}

function rows(value: unknown): Data[] { return Array.isArray(value) ? value.map(record) : []; }
function numeric(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function number(value: unknown): string {
  return numeric(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "未提供";
}
function text(value: unknown): string { return typeof value === "string" && value ? value : "未提供"; }
function percent(value: unknown): string { return numeric(value) ? `${number(value * 100)}%` : "暂不能计算"; }
function amounts(value: unknown): [string, unknown][] { return numeric(value) ? [["", value]] : Object.entries(record(value)); }
function amountText(value: unknown, defaultCurrency = ""): string {
  return amounts(value).map(([currency, amount]) => `${currency || defaultCurrency ? `${currency || defaultCurrency} ` : ""}${number(amount)}`).join(" · ") || "未提供";
}
function settlementCurrency(data: Data): string {
  const currencies = record(record(data.review).coverage).currencies;
  return Array.isArray(currencies) && currencies.length === 1 && typeof currencies[0] === "string" ? currencies[0] : "";
}
function ratioText(value: unknown): string {
  return (numeric(value) ? [["", value]] : value === null ? [["", null]] : Object.entries(record(value)))
    .map(([currency, amount]) => `${currency ? `${currency} ` : ""}${numeric(amount) ? number(amount) : "暂不能计算"}`).join(" · ") || "暂不能计算";
}
function Monetary({ value, currency = "" }: { value: unknown; currency?: string }) {
  return <span className={numeric(value) && value !== 0 ? value > 0 ? "text-[hsl(var(--stock-up))]" : "text-[hsl(var(--stock-down))]" : undefined}>{currency && `${currency} `}{number(value)}</span>;
}

interface Observation { title: string; summary: string; basis: string[] }
function observations(data: Data): Observation[] {
  const behavior = record(data.behavior);
  const hold = record(behavior.disposition_effect);
  const activity = record(behavior.overtrading);
  const chase = record(behavior.chasing_momentum);
  const price = record(behavior.anchoring);
  const activityGroups: [string, Data][] = Object.keys(record(activity.by_currency)).length
    ? Object.entries(record(activity.by_currency)).map(([currency, value]) => [currency, record(value)]) : [["", activity]];
  const activitySummaries = activityGroups.filter(([, value]) => numeric(value.busy_day_avg_pnl) && numeric(value.quiet_day_avg_pnl))
    .map(([currency, value]) => `${currency ? `${currency}：` : ""}交易较多日平均每段 ${number(value.busy_day_avg_pnl)}，较少日 ${number(value.quiet_day_avg_pnl)}`);
  return [
    { title: "赚钱和亏钱的交易，各拿了多久", summary: numeric(hold.avg_winner_hold_days) && numeric(hold.avg_loser_hold_days)
      ? `盈利交易平均持有 ${number(hold.avg_winner_hold_days)} 天，亏损交易 ${number(hold.avg_loser_hold_days)} 天。` : "缺少可比较的盈利、亏损配对样本，暂不能比较。",
    basis: ["比较已配对成交中，盈利组与亏损组的平均持有天数；不据此判断你的心理或买卖是否正确。"] },
    { title: "交易多的日子，表现是否不同", summary: activitySummaries.length ? `${activitySummaries.join("；")}。` : "交易日或已配对样本不足，暂不能比较。",
      basis: ["按每日买卖笔数划分交易较多日（前四分位）和较少日（后四分位），比较在这些日子结束的配对成交平均盈亏。分组可能因笔数相同而重叠。", "按结算币种分别比较，没有换汇；记录中的差异不能证明交易频繁导致亏损。"] },
    { title: "重复买入时，是否越买越贵", summary: numeric(chase.chase_ratio) && numeric(chase.buys_evaluated)
      ? `可比较的 ${number(chase.buys_evaluated)} 笔买入中，${percent(chase.chase_ratio)} 比本人同股此前第 3 笔买价高出 3% 以上。` : "同一股票的重复买入记录不足，暂不能比较。",
      basis: ["比较的是你自己的历史买入价格，不是股票近期市场涨幅，也不代表确认追涨。每只股票至少有 4 笔买入，才有可比较样本。"] },
    { title: "是否反复在相近价格成交", summary: numeric(price.anchored_symbol_ratio) && numeric(price.symbols_evaluated)
      ? `评估 ${number(price.symbols_evaluated)} 只经常交易的股票，其中 ${percent(price.anchored_symbol_ratio)} 的成交价格较集中。` : "没有至少交易 5 笔的股票，暂不能比较。",
      basis: ["每只股票至少 5 笔买卖，以成交价格标准差÷均价低于 5% 作为价格集中条件。仅描述成交价格分布，不判断是否存在心理偏差。",
        ...rows(price.anchored_symbols).map((row) => `${text(row.symbol)}：${number(row.trades)} 笔，均价 ${number(row.mean_price)}，价格变异系数 ${percent(row.cv)}`)] },
  ];
}

type Column = { label: string; value: (row: Data) => ReactNode };
function DetailTable({ data, columns, empty }: { data: Data[]; columns: Column[]; empty: string }) {
  if (!data.length) return <p className="text-muted-foreground">{empty}</p>;
  return <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-caption"><thead><tr>{columns.map((column) => <th key={column.label} className="whitespace-nowrap border-b py-2 pr-4 font-medium">{column.label}</th>)}</tr></thead>
    <tbody>{data.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column.label} className="border-b py-2 pr-4">{column.value(row)}</td>)}</tr>)}</tbody></table></div>;
}
const TRADE_COLUMNS: Column[] = [
  { label: "日期", value: (row) => text(row.datetime) }, { label: "股票", value: (row) => <>{text(row.symbol)} {typeof row.name === "string" ? row.name : ""}</> },
  { label: "类型", value: (row) => SIDES[text(row.side)] || "未识别" }, { label: "数量", value: (row) => number(row.quantity) }, { label: "价格", value: (row) => number(row.price) },
];

function ReviewDetails({ data }: { data: Data }) {
  const review = record(data.review);
  const coverage = record(review.coverage);
  const preview = record(review.preview);
  const currencies = Array.isArray(coverage.currencies) ? coverage.currencies.filter((value): value is string => typeof value === "string") : [];
  return <>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-caption sm:grid-cols-3">{[
      ["识别格式", FORMATS[text(data.format_detected)] || "未识别格式"], ["记录覆盖日期", text(data.date_range)], ["数据行数（不含表头）", number(coverage.source_rows)],
      ["已解析记录", number(coverage.parsed_records ?? data.total_records)], ["买入 / 卖出记录", `${number(coverage.buy_records)} / ${number(coverage.sell_records)}`], ["现金分红记录", number(coverage.dividend_records)], ["结算币种", currencies.join("、") || "旧记录未提供币种清单"],
    ].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1">{value}</dd></div>)}</dl>
    {!Object.keys(review).length ? <p className="text-caption text-muted-foreground">这份旧复盘没有保存行级核对资料。可查看原统计；重新导入文件后可核对明细。</p> : <>
      {numeric(coverage.source_rows) && numeric(coverage.parsed_records) && coverage.source_rows !== coverage.parsed_records && <p className="text-caption">数据行数与解析记录数不同，请核对是否含非成交行或未识别内容。</p>}
      <p className="text-caption text-muted-foreground">已识别费用列：{Array.isArray(coverage.recognized_fee_columns) && coverage.recognized_fee_columns.length ? coverage.recognized_fee_columns.join("、") : "未发现，不代表实际费用为零"}。</p>
      {numeric(coverage.invalid_datetime_records) && coverage.invalid_datetime_records > 0 && <p role="status" className="text-caption">{number(coverage.invalid_datetime_records)} 条记录日期无效，可能影响时间和配对统计。</p>}
      <div className="space-y-2"><h4 className="text-caption font-medium">已识别记录预览</h4><DetailTable data={rows(preview.rows)} columns={[...TRADE_COLUMNS, { label: "已识别费用", value: (row) => number(row.fee) }]} empty="没有可预览记录。" />
        {preview.truncated === true && <p className="text-caption text-muted-foreground">这里只预览前 {number(preview.limit)} 条，已识别共 {number(preview.total)} 条。</p>}</div>
    </>}
  </>;
}
function Basis({ data }: { data: Data }) {
  const review = record(data.review);
  const coverage = record(review.coverage);
  const unmatched = record(review.unmatched);
  return <div className="space-y-3"><p>按同一证券、同一币种的先后成交进行先进先出配对；部分成交可分成多段。配对金额使用原生费用分摊。</p>
    <p>本次只统计文件内可配对的成交及已识别现金分红，不代表完整账户净值或账户收益率。没有期初持仓记录，不能把剩余成交直接视为当前持仓，也不能据此认定用户实际做空。</p>
    <p>币种分别列示，没有换汇。费用只覆盖文件中已识别的列；未识别费用、遗漏成交、拆分转增和缺失期初记录可能影响结果。</p>
    <p>未配对记录：{numeric(unmatched.total_lots) ? `${number(unmatched.total_lots)} 段` : "旧记录未保存"}。{numeric(coverage.filtered_out_records) && coverage.filtered_out_records > 0 ? `原生筛选排除 ${number(coverage.filtered_out_records)} 条。` : ""}</p>
    {Array.isArray(coverage.raw_columns) && <p>原文件列名：{coverage.raw_columns.filter((value) => typeof value === "string").join("、")}。</p>}<ReviewDetails data={data} /></div>;
}

export function stockVibeJournalMarkdown(result: unknown): string {
  const data = record(result);
  const profile = record(data.profile);
  const review = record(data.review);
  const coverage = record(review.coverage);
  const hasPairs = numeric(profile.total_roundtrips) && profile.total_roundtrips > 0;
  const currency = settlementCurrency(data);
  const lines = ["# 成交复盘", "", `- 文件：${text(data.file)}`, `- 记录覆盖日期：${text(data.date_range)}`, `- 识别格式：${FORMATS[text(data.format_detected)] || "未识别格式"}`,
    `- 解析记录：${number(data.total_records)}；买入 ${number(coverage.buy_records)}；卖出 ${number(coverage.sell_records)}`, `- 已配对成交：${number(profile.total_roundtrips)} 段`,
    `- 文件内配对盈亏（含已识别现金分红）：${amountText(profile.total_pnl, currency)}`, `- 其中已识别现金分红：${amountText(profile.total_dividends, currency)}`,
    `- 盈利配对占比：${hasPairs ? percent(profile.win_rate) : "暂无配对样本"}`, `- 平均赚赔比：${hasPairs ? ratioText(profile.profit_loss_ratio) : "暂无配对样本"}`,
    `- 平均持有：${hasPairs ? `${number(profile.avg_holding_days)} 天` : "暂无配对样本"}`, "", "## 交易观察", ""];
  for (const observation of observations(data)) lines.push(`### ${observation.title}`, "", observation.summary, "", ...observation.basis.map((basis) => `- 依据：${basis}`), "");
  if (rows(review.by_symbol).length) lines.push("## 逐股配对盈亏", "", ...rows(review.by_symbol).map((row) => `- ${text(row.symbol)} ${typeof row.name === "string" ? row.name : ""}：${text(row.currency)} ${number(row.matched_pnl)}；${number(row.matched_count)} 段`), "");
  const unmatched = record(review.unmatched);
  if (rows(review.settlements).length) lines.push("## 费用与分红口径", "", ...rows(review.settlements).map((row) => `- ${text(row.currency)}：配对盈亏（不含分红）${number(row.matched_pnl)}；全文件已识别费用 ${number(row.recognized_fees)}`), "", "配对盈亏已含原生分摊费用，不再重复扣减；全文件费用还可能包含未配对成交的费用。", "");
  if (rows(unmatched.by_symbol).length) lines.push("## 未配对成交", "", ...rows(unmatched.by_symbol).map((row) => `- ${text(row.symbol)} ${SIDES[text(row.side)] || "未识别"}剩余 ${number(row.quantity)}，${number(row.lots)} 段，${text(row.currency)}`), "");
  lines.push("## 数据范围与局限", "", `原始数据 ${number(coverage.source_rows)} 行（不含表头）；已解析 ${number(coverage.parsed_records ?? data.total_records)} 条；参与本次分析 ${number(coverage.analyzed_records ?? data.total_records)} 条。`,
    `已识别费用列：${Array.isArray(coverage.recognized_fee_columns) && coverage.recognized_fee_columns.length ? coverage.recognized_fee_columns.join("、") : "未记录或未发现，不代表实际费用为零"}。`,
    "先进先出配对，部分成交会分成多段；配对金额使用原生费用分摊。", "本次只统计文件内可配对的成交及已识别现金分红，不代表完整账户净值或账户收益率。", "币种分别列示，没有换汇；费用仅覆盖已识别列，未提供期初持仓。", `未配对成交：${numeric(unmatched.total_lots) ? `${number(unmatched.total_lots)} 段，可能缺少对应成交或期初记录` : "旧记录未保存"}。`, "未配对成交不能直接认定为当前持仓或实际做空。", "");
  return lines.join("\n");
}

export interface StockVibeJournalResultProps {
  result: unknown;
  mode?: "review" | "result";
  onConfirm?: () => void;
  confirming?: boolean;
  onExplain?: (markdown: string) => void;
}

export function StockVibeJournalResult({ result, mode = "result", onConfirm, confirming, onExplain }: StockVibeJournalResultProps) {
  const data = record(result);
  const profile = record(data.profile);
  const review = record(data.review);
  const matched = record(review.matched_trades);
  const unmatched = record(review.unmatched);
  const pairs = profile.total_roundtrips;
  const hasPairs = numeric(pairs) && pairs > 0;
  const markdown = stockVibeJournalMarkdown(result);
  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "成交复盘.md";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  if (mode === "review") return <section aria-label="核对成交文件" className="space-y-5"><h3 className="text-ui font-medium">核对识别结果</h3><ReviewDetails data={data} />
    {numeric(unmatched.total_lots) && unmatched.total_lots > 0 && <p className="text-caption">有 {number(unmatched.total_lots)} 段成交缺少对应成交或期初记录，不能计入完整配对统计。</p>}
    <StockVibeInfo title="本次复盘的统计范围" label="了解费用、配对与缺失记录"><Basis data={data} /></StockVibeInfo>
    {onConfirm && <Button type="button" variant="secondary" disabled={confirming} onClick={onConfirm}>确认并查看复盘</Button>}</section>;
  return <section aria-label="成交文件统计" className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-ui font-medium">这份成交的交易表现</h3><p className="mt-1 text-caption text-muted-foreground">原文件区间：{text(data.date_range)}</p></div>
      <div className="flex gap-2">{onExplain && <Button type="button" variant="secondary" size="sm" onClick={() => onExplain(markdown)}>解释这份复盘</Button>}<Button type="button" variant="ghost" size="sm" onClick={download}>导出复盘</Button></div></div>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-4">
      <div className="col-span-2"><dt className="text-caption text-muted-foreground">文件内配对盈亏（含已识别分红）</dt><dd className="mt-1 flex flex-wrap gap-x-4 text-title font-semibold tabular-nums">{amounts(profile.total_pnl).length ? amounts(profile.total_pnl).map(([currency, amount]) => <Monetary key={currency} value={amount} currency={currency || settlementCurrency(data)} />) : "未提供"}</dd></div>
      <div><dt className="text-caption text-muted-foreground">盈利配对占比</dt><dd className="mt-1 text-ui font-medium tabular-nums">{hasPairs ? percent(profile.win_rate) : "暂无配对样本"}</dd></div>
      <div><dt className="text-caption text-muted-foreground">平均赚赔比</dt><dd className="mt-1 text-ui font-medium tabular-nums">{hasPairs ? ratioText(profile.profit_loss_ratio) : "暂无配对样本"}</dd></div>
      <div><dt className="text-caption text-muted-foreground">已配对成交段</dt><dd className="mt-1 text-ui tabular-nums">{number(pairs)}</dd></div>
      <div><dt className="text-caption text-muted-foreground">平均持有天数</dt><dd className="mt-1 text-ui tabular-nums">{hasPairs ? number(profile.avg_holding_days) : "暂无配对样本"}</dd></div>
      <div><dt className="text-caption text-muted-foreground">已解析记录</dt><dd className="mt-1 text-ui tabular-nums">{number(data.total_records)}</dd></div>
    </dl>
    {rows(matched.rows).some((row) => row.side === "short") && <p role="status" className="text-caption text-muted-foreground">文件中有先卖后买的配对。这里按文件内成交计算，实际盈亏还需核对期初持仓和成本，不能据此认定真实做空。</p>}
    <div className="flex flex-wrap gap-x-6 gap-y-1"><StockVibeInfo title="本次复盘的统计范围" label="数据范围与计算口径"><Basis data={data} /></StockVibeInfo>
      <StockVibeInfo title="这些指标怎么看" label="这些指标怎么看"><p>盈利配对占比＝盈利配对段数÷全部配对段数；打平成交也在分母内。</p><p>平均赚赔比＝盈利成交平均赚取金额÷亏损成交平均损失金额。没有亏损样本等情况下不能给出有限比值，不等于策略不会亏钱。</p><p>持有天数按已配对段的成交时间计算，不是全部持仓的持有时间。</p></StockVibeInfo></div>
    <section aria-label="交易习惯观察" className="space-y-1 border-t pt-5"><h4 className="text-body font-medium">从这份记录看到什么</h4>{observations(data).map((observation) => <div key={observation.title} className="py-3"><div className="flex items-start justify-between gap-4"><h5 className="text-caption font-medium">{observation.title}</h5><StockVibeInfo title={observation.title} label="看依据">{observation.basis.map((basis) => <p key={basis}>{basis}</p>)}</StockVibeInfo></div><p className="mt-1 text-caption text-muted-foreground">{observation.summary}</p></div>)}</section>
    <section className="space-y-3 border-t pt-5"><h4 className="text-body font-medium">哪些股票影响了配对盈亏</h4><DetailTable data={rows(review.by_symbol)} empty={Object.keys(review).length ? "本次没有可配对的逐股盈亏。" : "这份旧复盘没有保存逐股配对结果；重新导入文件后可查看。"} columns={[
      { label: "股票", value: (row) => <>{text(row.symbol)} {typeof row.name === "string" ? row.name : ""}</> }, { label: "配对段数", value: (row) => number(row.matched_count) }, { label: "配对盈亏", value: (row) => <Monetary value={row.matched_pnl} currency={text(row.currency)} /> },
    ]} />
      <div className="flex flex-wrap gap-x-6 gap-y-1"><StockVibeInfo title="已配对成交明细" label="查看配对成交"><p>入场、离场表示文件中先后配对的成交。卖出在先的配对可能缺少期初记录，不能据此认定实际做空。</p><DetailTable data={rows(matched.rows).length ? rows(matched.rows) : rows(profile.roundtrips_sample)} empty="没有已配对样本。" columns={[
        { label: "股票", value: (row) => text(row.symbol) }, { label: "入场时间", value: (row) => text(row.buy_dt) }, { label: "离场时间", value: (row) => text(row.sell_dt) },
        { label: "顺序", value: (row) => row.side === "short" ? "先卖后买" : row.side === "long" ? "先买后卖" : "旧记录未标记" },
        { label: "数量", value: (row) => number(row.qty) }, { label: "配对盈亏", value: (row) => <Monetary value={row.pnl} currency={typeof row.currency === "string" ? row.currency : ""} /> },
      ]} />{matched.truncated === true && <p>这里只显示前 {number(matched.limit)} 段，共 {number(matched.total)} 段。</p>}{!Object.keys(matched).length && <p>旧记录只保存了最多 5 段配对样本，不是全部成交。</p>}</StockVibeInfo>
        <StockVibeInfo title="缺少对应成交或期初记录" label={`查看未配对记录${numeric(unmatched.total_lots) ? `（${number(unmatched.total_lots)} 段）` : ""}`}><p>这些是文件内未能配对的剩余成交，不能直接判断为当前持仓或实际做空。</p><DetailTable data={rows(unmatched.rows)} empty={Object.keys(unmatched).length ? "没有未配对记录。" : "旧记录没有保存未配对明细。"} columns={[...TRADE_COLUMNS, { label: "币种", value: (row) => text(row.currency) }]} />{unmatched.truncated === true && <p>这里只显示前 {number(unmatched.limit)} 段，共 {number(unmatched.total_lots)} 段。</p>}</StockVibeInfo>
        <StockVibeInfo title="已识别费用与现金分红" label="查看费用与分红"><DetailTable data={rows(review.settlements)} empty="旧记录未保存按币种费用汇总。" columns={[
          { label: "币种", value: (row) => text(row.currency) }, { label: "配对盈亏（不含分红）", value: (row) => <Monetary value={row.matched_pnl} /> }, { label: "文件已识别费用", value: (row) => number(row.recognized_fees) },
        ]} /><p>已识别现金分红：{amountText(profile.total_dividends, settlementCurrency(data))}。</p>{numeric(profile.dividend_rows_missing_cash) && profile.dividend_rows_missing_cash > 0 && <p>{number(profile.dividend_rows_missing_cash)} 条分红记录没有识别到现金金额，分红合计可能不完整。</p>}<p>费用是已识别列的合计，不保证涵盖实际全部费用；配对盈亏已按原生规则分摊费用，勿再次扣减。</p></StockVibeInfo></div>
    </section>
  </section>;
}
