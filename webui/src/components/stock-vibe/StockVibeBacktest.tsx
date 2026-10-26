import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CircleHelp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getStockVibeOperation, getStockVibeRequest, listStockVibeOperations, type StockVibeRequestRecord } from "@/lib/stock-vibe-api";
import {
  getStockVibeBacktestDefaults, getStockVibeBacktestInputs, getStockVibeBacktestRun, listStockVibeBacktestStrategyHistory, parseStockVibeBacktestOperation,
  startStockVibeBacktest, stockVibeBacktestRunId, stockVibeBacktestSettings, getStockVibeBacktestFactor, getStockVibeBacktestConfig, type StockVibeBacktestDefaults, type StockVibeBacktestInput,
  type StockVibeBacktestOperation, type StockVibeBacktestRun, type StockVibeBacktestSettings, type StockVibeBacktestParameter, type StockVibeBacktestStrategyReference,
} from "@/lib/stock-vibe-backtest-api";
import { StockVibeInfo } from "./StockVibeInfo";
import "./stock-vibe-backtest.css";
import type { EquityPoint, FactorReportPayload, RunData, ValidationData } from "./native/lib/types";

const NativeTrades = lazy(() => import("./native/components/NativeTrades").then((module) => ({ default: module.NativeTrades })));
const NativeReports = lazy(() => import("./StockVibeNativeTools").then((module) => ({ default: module.StockVibeNativeReports })));
const NativeCompare = lazy(() => import("./StockVibeNativeTools").then((module) => ({ default: module.StockVibeNativeCompare })));
const NativeEquity = lazy(() => import("./native/components/charts/EquityChart").then((module) => ({ default: module.EquityChart })));
const NativeValidation = lazy(() => import("./native/components/charts/ValidationPanel").then((module) => ({ default: module.ValidationPanel })));
const NativeFactors = lazy(() => import("./native/components/charts/FactorResearchPanel").then((module) => ({ default: module.FactorResearchPanel })));

interface StockVibeBacktestProps { symbols: string[]; onError: (message: string) => void; initialView?: "settings" | "history"; initialRunId?: string; selectedStrategy?: StockVibeBacktestStrategyReference; }
type Page = "settings" | "history" | "report" | "compare";
type Group = "basic" | "trading" | "validation";
interface Pending { requestId: string; operationId?: string; }
const STORAGE = "mona.stock-vibe.native-backtest-pending.v1";
const TERMINAL = new Set(["completed", "failed", "interrupted", "rejected"]);
const STATUS: Record<string, string> = { queued: "排队中", running: "回测中", completed: "已完成", failed: "未完成", interrupted: "已中断", rejected: "未接受" };
const LABELS: Record<string, string> = {
  source: "行情来源", codes: "股票范围", start_date: "开始日期", end_date: "结束日期", interval: "行情周期", initial_cash: "初始资金",
  commission_rate: "佣金比例", commission_min: "每笔最低佣金", stamp_tax: "印花税比例", transfer_fee: "过户费比例", slippage: "滑点比例",
  position_adjustment: "仓位调整", rebalance_mask: "调仓日安排", rebalance_tolerance: "仓位偏离容忍度", benchmark: "比较基准",
  warmup_bars: "指标预热根数", evaluation_start_date: "业绩计算起始日", optimizer: "仓位分配方法",
  top_n: "持股数量", rebalance_interval: "换股间隔", momentum_period: "动量观察期", volatility_period: "波动观察期", volume_period: "成交量观察期",
  momentum_window: "动量观察期", vol_window: "波动观察期", rebalance_freq: "换股间隔",
  n_simulations: "模拟次数", n_bootstrap: "重采样次数", confidence: "置信水平", n_windows: "滚动窗口数", lookback: "观察期", max_weight: "单股权重上限",
  risk_free: "无风险收益率", risk_aversion: "风险厌恶系数", turnover_penalty: "换手惩罚系数", max_per_name: "单股权重上限", groups: "股票分组", max_per_group: "分组权重上限", seed: "随机种子",
};
const HELP: Record<string, string> = {
  codes: "策略在这些股票中产生买卖信号；这里不是固定买入今天的候选名单。输入六位代码，用逗号或空格分隔。",
  start_date: "从这天开始读取历史行情。原生没有统一起始日期时，需要自行选择。", end_date: "读取历史行情的截止日期。",
  source: "回测实际使用的行情来源。默认沿用 Vibe；不同来源需要相应数据权限。", interval: "每根行情对应的时间长度，策略在该周期的历史行情上运行。",
  initial_cash: "模拟账户开始时可用的资金，不涉及真实交易。", commission_rate: "按成交金额收取的佣金比例。0.0003 表示万分之三。",
  commission_min: "每笔交易佣金的最低金额。", stamp_tax: "按原生市场规则计入的印花税比例。", transfer_fee: "按原生市场规则计入的过户费比例。",
  slippage: "用来模拟成交价偏离参考价格的比例。0.001 表示 0.1%。", position_adjustment: "保持仓位沿用策略信号；再平衡允许按目标权重调整持仓。",
  rebalance_mask: "原生支持日历频率（例如 W、MS）或指定日期列表；只约束再平衡执行日，不改变策略自身的选股周期。留空为不额外限制。",
  rebalance_tolerance: "持仓权重与目标权重偏离超过此比例时才调整。0.05 表示 5 个百分点；策略目标变化仍按原生规则处理。",
  benchmark: "用于同期比较的基准代码。未指定时不添加基准。", warmup_bars: "前若干根行情只用于准备指标，不计入业绩。与业绩计算起始日二选一。",
  evaluation_start_date: "这天之前的行情只用于准备指标，不计入业绩。与指标预热根数二选一。", optimizer: "对策略产生的目标仓位应用原生权重优化；未指定时沿用原策略。",
};
const SOURCE: Record<string, string> = { tushare: "Tushare", tencent: "腾讯行情", eastmoney: "东方财富行情", local: "本地行情", auto: "自动选择" };
const INTERVAL: Record<string, string> = { "1m": "1 分钟", "5m": "5 分钟", "15m": "15 分钟", "30m": "30 分钟", "1H": "1 小时", "4H": "4 小时", "1D": "日线", "1W": "周线", "1M": "月线" };
const OPTIMIZER: Record<string, string> = { equal_volatility: "等波动分配", risk_parity: "风险平价", mean_variance: "均值方差", max_diversification: "最大分散化", turnover_aware: "考虑换手成本" };
const VALIDATION: Record<string, string> = { monte_carlo: "随机模拟检验", bootstrap: "重采样检验", walk_forward: "滚动窗口检验" };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const number = (value: unknown) => numeric(value) || typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 4 }) : "未提供";
const percent = (value: unknown) => numeric(value) ? `${number(value * 100)}%` : "未提供";
const display = (value: unknown) => value === null || value === undefined || value === "" ? "未指定" : typeof value === "object" ? JSON.stringify(value) : String(value);
function initialCodes(config: StockVibeBacktestSettings, strategy: StockVibeBacktestStrategyReference | undefined, symbols: string[]) {
  if (strategy?.scope_label !== undefined) return "";
  const strategyCodes = strategy?.effective_config?.codes;
  const codes = strategy && !strategyCodes?.length ? symbols : config.codes ?? [];
  return codes.map((code) => code.slice(0, 6)).join(", ");
}
function settingsForStrategy(config: StockVibeBacktestSettings, strategy: StockVibeBacktestStrategyReference | undefined): StockVibeBacktestSettings {
  const settings = { ...config };
  if (strategy?.scope_label !== undefined) delete settings.codes;
  return stockVibeBacktestSettings(settings);
}
function validStrategyScope(scope: StockVibeBacktestStrategyReference["scope"]): boolean {
  if (!scope) return false;
  if (scope.kind === "all_a") return true;
  if (scope.kind === "industry") return scope.industry_code.trim().length > 0;
  return scope.codes.length > 0 && scope.codes.every((code) => /^\d{6}(?:\.(?:SH|SZ|BJ))?$/i.test(code));
}
function belongsToStrategy(row: StockVibeBacktestOperation, strategy: StockVibeBacktestStrategyReference, requireVersion = false): boolean {
  const strategyId = row.payload?.strategy_id ?? row.references?.strategy_id;
  const version = row.payload?.strategy_version ?? row.references?.strategy_version;
  return strategyId === strategy.strategy_id && (!requireVersion || version === strategy.version);
}
function objectValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
  return isObject(value) ? value : null;
}
function backtestScopeDetails(operation: StockVibeBacktestOperation | null, run?: StockVibeBacktestRun) {
  const result = objectValue(operation?.tool_result), references = operation?.references ?? {};
  const scope = objectValue(references.scope) ?? objectValue(result?.scope);
  if (!scope) {
    const savedCodeSets = [operation?.payload?.settings?.codes, references.effective_config && objectValue(references.effective_config)?.codes, run?.effective_config?.codes, run?.config?.codes];
    const savedCodes = savedCodeSets.find((codes): codes is string[] => Array.isArray(codes) && codes.length > 0);
    return { summary: savedCodes ? `历史记录范围（${savedCodes.length}只）` : "历史范围未记录", currentSnapshot: false };
  }
  const label = scope.kind === "all_a" ? "全A股"
    : scope.kind === "industry" ? String(scope.industry_name ?? scope.industry_code ?? "所选行业")
      : scope.kind === "watchlist" ? "自选股票" : "本次策略范围";
  const asOf = typeof scope.as_of === "string" ? scope.as_of.slice(0, 10) : null;
  const coverage = objectValue(references.coverage) ?? objectValue(result?.coverage);
  const evaluated = typeof coverage?.evaluated === "number" ? coverage.evaluated : null;
  const requested = typeof coverage?.requested === "number" ? coverage.requested : null;
  const missing = typeof coverage?.missing === "number" ? coverage.missing : Array.isArray(coverage?.missing) ? coverage.missing.length : null;
  return {
    summary: `本次范围：${label}${asOf ? ` · 名单截点 ${asOf}` : ""}${evaluated !== null && requested !== null ? ` · 已计算 ${evaluated}/${requested} 只` : ""}${missing !== null && missing > 0 ? ` · 缺数据 ${missing} 只` : ""}`,
    currentSnapshot: scope.membership_basis === "current_snapshot",
  };
}
function readPending(key = STORAGE): Pending | null {
  try { const value = JSON.parse(localStorage.getItem(key) ?? "null"); return isObject(value) && typeof value.requestId === "string" && /^[a-f\d-]{32,36}$/i.test(value.requestId) ? value as unknown as Pending : null; } catch { return null; }
}
function savePending(value: Pending | null, key = STORAGE) { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); }
function Field({ name, help, children }: { name: string; help: string; children: ReactNode }) {
  return <div className="space-y-1.5"><div className="flex items-center gap-1.5"><span>{name}</span><TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild><button type="button" className="stock-vibe-backtest-help" aria-label={`${name}说明`}><CircleHelp className="h-3.5 w-3.5" /></button></TooltipTrigger><TooltipContent className="max-w-xs font-normal">{help}</TooltipContent></Tooltip></TooltipProvider></div>{children}</div>;
}
function ToggleTabs<T extends string>({ value, items, onChange, label }: { value: T; items: Array<[T, string]>; onChange: (value: T) => void; label: string }) {
  return <div role="tablist" aria-label={label} className="flex flex-wrap gap-1">{items.map(([key, title]) => <Button key={key} role="tab" aria-selected={value === key} type="button" variant="ghost" size="sm" className={value === key ? "bg-muted" : ""} onClick={() => onChange(key)}>{title}</Button>)}</div>;
}
function MappingParameter({ name, value, onChange, onValidity }: { name: string; value: unknown; onChange: (value: Record<string, unknown> | null) => void; onValidity: (valid: boolean) => void }) {
  const groups = name === "groups", title = LABELS[name] ?? name;
  const [rows, setRows] = useState(() => Object.entries(isObject(value) ? value : {}).map(([key, entry], id) => ({ id, key: groups ? key.slice(0, 6) : key, value: groups ? String(entry) : String(Number(entry) * 100) })));
  const [errors, setErrors] = useState<Record<number, string>>({});
  const nextId = useRef(rows.length);
  function change(next: typeof rows) {
    const invalid: Record<number, string> = {}, seen = new Set<string>();
    for (const row of next) {
      const key = row.key.trim(), entry = row.value.trim();
      if (!key || !entry) invalid[row.id] = "请填写这一行的两项内容，或删除此行。";
      else if (groups && !/^\d{6}$/.test(key)) invalid[row.id] = "股票代码应为六位数字。";
      else if (!groups && (!Number.isFinite(Number(entry)) || Number(entry) <= 0 || Number(entry) > 100)) invalid[row.id] = "最高权重应大于 0%，且不超过 100%。";
      else if (seen.has(key)) invalid[row.id] = groups ? "股票代码重复，请合并为一行。" : "分组名称重复，请合并为一行。";
      seen.add(key);
    }
    setRows(next); setErrors(invalid); onValidity(Object.keys(invalid).length === 0);
    if (!Object.keys(invalid).length) onChange(next.length ? Object.fromEntries(next.map((row) => [row.key.trim(), groups ? row.value.trim() : Number(row.value) / 100])) : null);
  }
  return <Field name={title} help={groups ? "为股票指定所属分组，填写六位代码即可；不添加时不分组。" : "限制每组股票占账户资金的最高比例；例如填写 30，表示该组最多占 30%。不添加时不设分组上限。"}>
    {!rows.length && <p className="py-1 text-muted-foreground">未指定</p>}
    {rows.length > 0 && <div className="mb-1 flex gap-2 pr-8 text-muted-foreground"><span className="flex-1">{groups ? "股票代码" : "分组名称"}</span><span className="flex-1">{groups ? "分组名称" : "最高权重（%）"}</span></div>}
    <div className="space-y-2">{rows.map((row, index) => <div key={row.id}><div className="flex items-center gap-2"><Input aria-label={`${title} 第${index + 1}行 ${groups ? "股票代码" : "分组名称"}`} value={row.key} placeholder={groups ? "六位代码" : "分组名称"} className="min-w-0 flex-1" aria-invalid={Boolean(errors[row.id])} onChange={(event) => change(rows.map((item) => item.id === row.id ? { ...item, key: event.target.value } : item))} /><Input aria-label={`${title} 第${index + 1}行 ${groups ? "分组名称" : "最高权重百分比"}`} value={row.value} placeholder={groups ? "分组名称" : "0–100"} type={groups ? "text" : "number"} step={groups ? undefined : "any"} className="min-w-0 flex-1" aria-invalid={Boolean(errors[row.id])} onChange={(event) => change(rows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))} /><Button type="button" variant="ghost" size="icon" className="h-8 w-6 shrink-0" aria-label={`删除${title}第${index + 1}行`} onClick={() => change(rows.filter((item) => item.id !== row.id))}><X className="h-3.5 w-3.5" /></Button></div>{errors[row.id] && <p className="mt-1 text-destructive">{errors[row.id]}</p>}</div>)}</div>
    <Button type="button" variant="ghost" size="sm" className="px-0" onClick={() => change([...rows, { id: nextId.current++, key: "", value: "" }])}>添加{groups ? "股票分组" : "分组上限"}</Button>
  </Field>;
}
function Equity({ rows }: { rows: Array<Record<string, unknown>> }) {
  const points = rows.filter((row) => typeof row.time === "string" && row.equity !== null && row.equity !== "" && Number.isFinite(Number(row.equity)) && row.drawdown !== null && row.drawdown !== "" && Number.isFinite(Number(row.drawdown)));
  if (!points.length) return <p className="text-muted-foreground">报告没有提供净值曲线。</p>;
  return <Suspense fallback={<p role="status">正在读取原生资金曲线…</p>}><NativeEquity data={points as unknown as EquityPoint[]} height={280} /></Suspense>;
}
function BacktestReport({ run, operation, onError }: { run: StockVibeBacktestRun; operation: StockVibeBacktestOperation | null; onError: (message: string) => void }) {
  const [section, setSection] = useState<"performance" | "trades" | "config" | "factors">("performance");
  const [factorReport, setFactorReport] = useState<FactorReportPayload | null>(null);
  const [factorLoading, setFactorLoading] = useState(false);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  useEffect(() => {
    if (section !== "factors" || !run.has_factor_artifacts) return;
    let active = true;
    setFactorLoading(true);
    void getStockVibeBacktestFactor(run.run_id).then((native) => { if (active) setFactorReport(native); })
      .catch(() => { if (active) onErrorRef.current("暂时无法读取本次因子评测产物，请稍后重新打开。"); })
      .finally(() => { if (active) setFactorLoading(false); });
    return () => { active = false; };
  }, [run.run_id, run.has_factor_artifacts, section]);
  const metrics = run.metrics ?? {};
  const config = run.effective_config ?? run.config ?? operation?.references?.effective_config ?? operation?.payload?.settings;
  const benchmarkTicker = typeof metrics.benchmark_ticker === "string" ? metrics.benchmark_ticker.trim() : "";
  const warnings = [...new Set([...(isObject(run.run_card) && Array.isArray(run.run_card.warnings) ? run.run_card.warnings : []), ...(Array.isArray(metrics.warnings) ? metrics.warnings : [])].filter((warning): warning is string => typeof warning === "string" && warning.length > 0))];
  const scope = backtestScopeDetails(operation, run);
  return <div className="space-y-4">{scope && <div className="text-caption text-muted-foreground"><p>{scope.summary}</p>{scope.currentSnapshot && <p>按本次可用股票范围回测历史区间，可能存在幸存者偏差；不代表当时的历史成分。</p>}</div>}<ToggleTabs label="报告内容" value={section} onChange={setSection} items={[["performance", "回测表现"], ["trades", "交易记录"], ["config", "实际设置与检验"], ["factors", "因子评测"]]} />
    {section === "performance" && <><div className="grid grid-cols-3 gap-4 border-y border-border py-4">{[["累计收益", metrics.total_return, true, true], ["年化收益", metrics.annual_return, true, true], ["最大回撤", metrics.max_drawdown, true, false], ["基准收益", metrics.benchmark_return, true, true], ["超额收益", metrics.excess_return, true, true], ["夏普比率", metrics.sharpe, false, false], ["胜率", metrics.win_rate, true, false], ["交易次数", metrics.trade_count, false, false]].map(([label, value, ratio, gain]) => <div key={String(label)}><p className="text-muted-foreground">{String(label)}</p><p className={`mt-1 text-ui font-semibold ${numeric(value) && gain && value !== 0 ? value > 0 ? "text-[hsl(var(--stock-up))]" : "text-[hsl(var(--stock-down))]" : ""}`}>{ratio ? percent(value) : number(value)}</p></div>)}</div>
      {(benchmarkTicker || numeric(metrics.benchmark_return)) && <p className="text-muted-foreground">{benchmarkTicker ? `实际基准：${benchmarkTicker}` : config?.benchmark && config.benchmark !== "auto" ? "本次使用回测股票的等权篮子对照，未使用所设指数。" : "基准：回测股票的等权篮子。"}</p>}
      {warnings.length > 0 && <StockVibeInfo title="本次回测的原生说明" label="查看回测说明"><div className="space-y-2">{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></StockVibeInfo>}
      <Equity rows={run.equity_curve ?? []} /></>}
    {section === "trades" && <Suspense fallback={<p role="status">正在读取原生交易记录…</p>}><NativeTrades run={run as unknown as RunData} /></Suspense>}
    {section === "config" && <><p className="text-muted-foreground">本次实际执行的设置</p>{config ? <dl className="grid grid-cols-2 gap-3">{Object.entries(config).map(([key, value]) => <div key={key}><dt className="text-muted-foreground">{LABELS[key] ?? key}</dt><dd className="break-words">{display(value)}</dd></div>)}</dl> : <p>未取得本次完整执行设置，可稍后重新打开。</p>}<div className="flex gap-4"><StockVibeInfo title="原生统计检验结果" label="查看统计检验"><pre className="whitespace-pre-wrap break-words">{run.validation ? JSON.stringify(run.validation, null, 2) : "本次没有生成统计检验结果。"}</pre></StockVibeInfo><StockVibeInfo title="原生风险报告" label="查看风险详情"><pre className="whitespace-pre-wrap break-words">{run.risk_xray ? JSON.stringify(run.risk_xray, null, 2) : "本次没有生成风险分析产物。"}</pre></StockVibeInfo></div></>}
    {section === "config" && isObject(run.validation) && <Suspense fallback={<p role="status">正在读取原生统计检验图表…</p>}><NativeValidation data={run.validation as unknown as ValidationData} compact /></Suspense>}
    {section === "factors" && (factorLoading ? <p role="status">正在读取因子评测…</p> : factorReport?.exists ? <Suspense fallback={<p role="status">正在读取原生因子图表…</p>}><NativeFactors report={factorReport} /></Suspense> : <p className="text-muted-foreground">本次运行没有生成因子评测产物。</p>)}
  </div>;
}

export function StockVibeBacktest(props: StockVibeBacktestProps) {
  const strategyKey = props.selectedStrategy ? `${props.selectedStrategy.strategy_id}@${props.selectedStrategy.version}` : "native-default";
  return <StockVibeBacktestInstance key={strategyKey} {...props} />;
}

function StockVibeBacktestInstance({ symbols, onError, initialView = "settings", initialRunId, selectedStrategy }: StockVibeBacktestProps) {
  const pendingStorage = selectedStrategy ? `${STORAGE}.${encodeURIComponent(selectedStrategy.strategy_id)}.${selectedStrategy.version}` : STORAGE;
  const scopeContext = selectedStrategy?.scope_label !== undefined ? `${selectedStrategy.strategy_id}@${selectedStrategy.version}:${JSON.stringify(selectedStrategy.scope)}` : "unscoped";
  const [view, setView] = useState<Page>(initialRunId ? "report" : initialView), [group, setGroup] = useState<Group>("basic");
  const [defaults, setDefaults] = useState<StockVibeBacktestDefaults | null>(null), [inputs, setInputs] = useState<StockVibeBacktestInput[]>([]);
  const [selection, setSelection] = useState(""), [settings, setSettings] = useState<StockVibeBacktestSettings>({}), [codes, setCodes] = useState("");
  const [strategyParameters, setStrategyParameters] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({}), [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<Pending | null>(() => readPending(pendingStorage)), [operation, setOperation] = useState<StockVibeBacktestOperation | null>(null);
  const [history, setHistory] = useState<StockVibeBacktestOperation[]>([]), [historyLoaded, setHistoryLoaded] = useState(false), [historyTotal, setHistoryTotal] = useState(0), [historyOffset, setHistoryOffset] = useState(0);
  const [report, setReport] = useState<StockVibeBacktestRun | null>(null), [reportLoading, setReportLoading] = useState(false);
  const errorRef = useRef(onError); errorRef.current = onError;
  const submitted = useRef(false), dispatching = useRef(false);
  const mounted = useRef(false);
  const reportRequest = useRef(0), scopeContextRef = useRef(scopeContext);
  const followPending = useRef(!initialRunId);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (scopeContextRef.current === scopeContext) return;
    scopeContextRef.current = scopeContext;
    reportRequest.current += 1;
    setOperation(null); setReport(null); setReportLoading(false); setView("settings");
  }, [scopeContext]);
  useEffect(() => {
    if (!initialRunId) return;
    const request = ++reportRequest.current;
    followPending.current = false;
    let active = true;
    setView("report"); setReportLoading(true); setReport(null); setOperation(null);
    void Promise.all([getStockVibeBacktestRun(initialRunId), getStockVibeBacktestConfig(initialRunId).catch(() => null)]).then(([native, actual]) => {
      if (!active || request !== reportRequest.current) return;
      if (native.run_id !== initialRunId) throw new Error("run_identity_mismatch");
      setReport({ ...native, effective_config: actual ?? native.effective_config ?? native.config });
    }).catch(() => { if (active && request === reportRequest.current) errorRef.current("暂时无法读取这份关联回测报告，请稍后重新打开。"); })
      .finally(() => { if (active && request === reportRequest.current) setReportLoading(false); });
    return () => { active = false; };
  }, [initialRunId]);
  useEffect(() => {
    let active = true;
    const existingInputs = selectedStrategy ? Promise.resolve([] as StockVibeBacktestInput[]) : getStockVibeBacktestInputs();
    void Promise.all([getStockVibeBacktestDefaults(), existingInputs]).then(([native, existing]) => {
      if (!active) return;
      setDefaults(native); setInputs(existing);
      const config = selectedStrategy?.effective_config ? { ...native.defaults, ...selectedStrategy.effective_config } : native.defaults;
      setSettings(settingsForStrategy(config, selectedStrategy)); setCodes(initialCodes(config, selectedStrategy, symbols));
      setSelection(selectedStrategy ? `strategy:${selectedStrategy.strategy_id}` : native.templates[0] ? `template:${native.templates[0].id}` : existing[0] ? `run:${existing[0].run_id}` : "");
      const availableParameters = selectedStrategy?.parameters ?? native.templates[0]?.parameters ?? [];
      setStrategyParameters(Object.fromEntries(availableParameters.filter((item) => item.editable && numeric(item.value)).map((item) => [item.name, item.value as number])));
      if (!selectedStrategy && !native.templates.length && existing[0]) { const inputConfig = existing[0].effective_config ?? existing[0].config; setSettings(stockVibeBacktestSettings({ ...native.defaults, ...inputConfig })); setCodes((inputConfig.codes ?? []).map((code) => code.slice(0, 6)).join(", ")); }
    }).catch(() => { if (active) errorRef.current("回测设置读取失败，请关闭后重新打开。"); }).finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);
  const loadHistory = useCallback(async () => {
    try {
      if (selectedStrategy) {
        const page = await listStockVibeBacktestStrategyHistory(selectedStrategy.strategy_id, 20, historyOffset);
        const rows = page.items.flatMap((row) => { const parsed = parseStockVibeBacktestOperation(row); return parsed ? [parsed] : []; });
        if (rows.length !== page.items.length || rows.some((row) => !belongsToStrategy(row, selectedStrategy)) || !Number.isInteger(page.total) || page.total < 0) throw new Error("invalid_backtest_strategy_history");
        setHistory(rows); setHistoryTotal(page.total); setHistoryLoaded(true); return;
      }
      const response = await listStockVibeOperations(), native = response.native;
      const rows = Array.isArray(native) ? native : isObject(native) && Array.isArray(native.operations) ? native.operations : [];
      setHistory(rows.flatMap((row) => { const parsed = parseStockVibeBacktestOperation(row); return parsed ? [parsed] : []; })); setHistoryTotal(0); setHistoryLoaded(true);
    } catch { if (mounted.current) errorRef.current("回测记录读取失败，请重新打开历史记录。"); }
  }, [selectedStrategy, historyOffset]);
  useEffect(() => { if (view === "history") { setHistoryLoaded(false); void loadHistory(); } }, [view, loadHistory]);
  const openNativeRun = useCallback(async (runId: string) => {
    const request = ++reportRequest.current;
    followPending.current = false;
    setOperation(null); setView("report"); setReport(null); setReportLoading(true);
    try {
      const [native, actual] = await Promise.all([getStockVibeBacktestRun(runId), getStockVibeBacktestConfig(runId).catch(() => null)]);
      if (!mounted.current || request !== reportRequest.current) return;
      if (native.run_id !== runId) throw new Error("run_identity_mismatch");
      const input = inputs.find((row) => row.run_id === runId);
      setReport({ ...native, effective_config: actual ?? native.effective_config ?? native.config ?? input?.effective_config ?? input?.config });
    } catch { if (mounted.current && request === reportRequest.current) errorRef.current("暂时无法读取这份原生报告，请稍后重新打开。"); }
    finally { if (mounted.current && request === reportRequest.current) setReportLoading(false); }
  }, [inputs]);
  const openReport = useCallback(async (row: StockVibeBacktestOperation) => {
    if (selectedStrategy && !belongsToStrategy(row, selectedStrategy)) { errorRef.current("这条回测记录与当前策略不匹配，系统没有显示报告。"); return; }
    const request = ++reportRequest.current;
    followPending.current = false; setOperation(row); setView("report"); setReport(null); setReportLoading(false);
    if (!TERMINAL.has(row.status)) return;
    let source = row, id = stockVibeBacktestRunId(row);
    if (!id && row.status === "completed") {
      try {
        const detail = await getStockVibeOperation(row.operation_id), parsed = parseStockVibeBacktestOperation(detail.native);
        if (!mounted.current || request !== reportRequest.current) return;
        if (parsed?.operation_id === row.operation_id) { source = parsed; id = stockVibeBacktestRunId(parsed); setOperation(parsed); }
      } catch { if (mounted.current && request === reportRequest.current) errorRef.current("回测记录详情暂时无法读取，可稍后重新打开。"); return; }
    }
    if (!id) { if (row.status === "completed" && mounted.current && request === reportRequest.current) errorRef.current("这条回测记录没有提供可读取的报告。"); return; }
    setReportLoading(true);
    try { const [result, actual] = await Promise.all([getStockVibeBacktestRun(id), getStockVibeBacktestConfig(id).catch(() => null)]); if (mounted.current && request === reportRequest.current) setReport({ ...result, effective_config: actual ?? result.effective_config ?? result.config ?? source.references?.effective_config ?? inputs.find((item) => item.run_id === id)?.effective_config ?? inputs.find((item) => item.run_id === id)?.config }); } catch { if (mounted.current && request === reportRequest.current) errorRef.current("回测报告读取失败，可从历史记录再次打开。"); } finally { if (mounted.current && request === reportRequest.current) setReportLoading(false); }
  }, [inputs, selectedStrategy]);
  const accept = useCallback((receipt: StockVibeRequestRecord, current: Pending): boolean => {
    if (receipt.request_id.replace(/-/g, "") !== current.requestId.replace(/-/g, "") || receipt.method !== "POST" || receipt.path !== "/mona/operations") return false;
    const code = receipt.receipt?.status_code;
    if (receipt.status === "completed" && code && code >= 200 && code < 300 && /^[a-f\d]{64}$/i.test(receipt.receipt_sha256 ?? "") && isObject(receipt.receipt?.body) && typeof receipt.receipt.body.operation_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(receipt.receipt.body.operation_id)) {
      const next = { ...current, operationId: receipt.receipt.body.operation_id }; savePending(next, pendingStorage); setPending(next); if (followPending.current) setView("report"); return true;
    }
    if (receipt.status === "rejected" && ((receipt.error_category === "not_dispatched" && receipt.receipt === null && receipt.source === null) || (code && code >= 400 && code < 500 && /^[a-f\d]{64}$/i.test(receipt.receipt_sha256 ?? "")))) { savePending(null, pendingStorage); setPending(null); submitted.current = false; errorRef.current("本次回测未被接受，请核对行情来源及权限、股票代码和日期后重新发起。"); return true; }
    return false;
  }, [pendingStorage]);
  useEffect(() => {
    if (!pending) return;
    let active = true, reading = false, done = false, warned = false;
    const poll = async () => {
      if (reading || done || (dispatching.current && !pending.operationId)) return; reading = true;
      try {
        if (!pending.operationId) { const receipt = await getStockVibeRequest(pending.requestId); if (active) accept(receipt, pending); }
        else {
          const response = await getStockVibeOperation(pending.operationId), row = parseStockVibeBacktestOperation(response.native);
          if (!active) return;
          if (!row || row.operation_id !== pending.operationId || (selectedStrategy && !belongsToStrategy(row, selectedStrategy, true))) throw new Error("invalid_backtest_operation");
          if (followPending.current) setOperation(row);
          if (TERMINAL.has(row.status)) { done = true; savePending(null, pendingStorage); setPending(null); submitted.current = false; if (row.status === "completed") { if (followPending.current) await openReport(row); } else errorRef.current("回测未完成，已保存本次记录。请核对行情来源及权限、股票代码和日期后重新发起。"); }
        }
      } catch { if (active && !warned) { warned = true; errorRef.current("暂时无法读取回测状态，原请求已保留，系统会继续核对。"); } } finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pending, accept, openReport]);
  const watchedId = view === "report" && operation && !TERMINAL.has(operation.status) && operation.operation_id !== pending?.operationId ? operation.operation_id : null;
  useEffect(() => {
    if (!watchedId) return;
    const request = reportRequest.current;
    let active = true, reading = false;
    const poll = async () => {
      if (reading) return; reading = true;
      try {
        const response = await getStockVibeOperation(watchedId), row = parseStockVibeBacktestOperation(response.native);
        if (active && request === reportRequest.current && row?.operation_id === watchedId) { setOperation(row); if (TERMINAL.has(row.status)) await openReport(row); }
      } catch { if (active && request === reportRequest.current) { active = false; errorRef.current("暂时无法读取回测进度，可从历史记录再次打开。"); } } finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => { if (active) void poll(); }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [watchedId, openReport]);
  function changeSelection(value: string) {
    setSelection(value); setErrors({});
    const input = inputs.find((item) => `run:${item.run_id}` === value), config = input ? input.effective_config ?? input.config : defaults!.defaults;
    setSettings(stockVibeBacktestSettings({ ...defaults!.defaults, ...config })); setCodes((config.codes ?? defaults!.defaults.codes ?? []).map((code) => code.slice(0, 6)).join(", "));
    setStrategyParameters(Object.fromEntries((defaults!.templates.find((item) => `template:${item.id}` === value)?.parameters ?? []).filter((item) => item.editable && numeric(item.value)).map((item) => [item.name, item.value as number])));
  }
  function update<K extends keyof StockVibeBacktestSettings>(key: K, value: StockVibeBacktestSettings[K]) { setSettings((current) => ({ ...current, [key]: value })); setErrors((current) => ({ ...current, [key]: "" })); }
  function help(key: string) { const native = defaults?.fields?.[key]; let text = typeof native === "string" ? native : native?.help ?? native?.description ?? HELP[key] ?? "沿用原生参数含义；留空时不覆盖原生设置。"; if (key === "source") text += " 原生默认 Tushare 可能需要配置行情凭据；也可主动选择已支持的腾讯、东方财富等来源。"; return typeof native === "object" && native.default_source ? `${text} 默认依据：${native.default_source}` : text; }
  function textField(key: keyof StockVibeBacktestSettings, type = "text", extra: { disabled?: boolean; placeholder?: string } = {}) {
    return <Field key={key} name={LABELS[key] ?? key} help={help(key)}><Input aria-label={LABELS[key] ?? key} type={type} value={settings[key] === null || settings[key] === undefined ? "" : String(settings[key])} onChange={(event) => {
      const value = event.target.value;
      if (key === "warmup_bars") setSettings((current) => ({ ...current, warmup_bars: value === "" ? null : Number(value), evaluation_start_date: null }));
      else if (key === "evaluation_start_date") setSettings((current) => ({ ...current, evaluation_start_date: value || null, warmup_bars: null }));
      else update(key, type === "number" ? value === "" ? undefined : Number(value) : value || null);
    }} step={type === "number" ? "any" : undefined} aria-invalid={Boolean(errors[key])} {...extra} />{errors[key] && <p className="text-destructive">{errors[key]}</p>}</Field>;
  }
  async function submit() {
    if (submitted.current || pending || !defaults) return;
    const selectedScope = Boolean(selectedStrategy && selectedStrategy.scope_label !== undefined);
    if (selectedStrategy && selectedStrategy.scope_label !== undefined && !validStrategyScope(selectedStrategy.scope)) { setErrors({ scope: "请先选择有效的股票范围。" }); return; }
    const list = codes.split(/[,，\s]+/).filter(Boolean), invalid: Record<string, string> = {};
    if (!selectedStrategy && !selection) invalid.selection = "请选择原生示例或已有策略。";
    if (!selectedScope && (!list.length || list.some((code) => !/^\d{6}(?:\.(?:SH|SZ|BJ))?$/i.test(code)))) invalid.codes = "请输入六位股票代码，用逗号或空格分隔。";
    if (!settings.start_date) invalid.start_date = "请选择开始日期。";
    if (!settings.end_date) invalid.end_date = "请选择结束日期。";
    if (settings.start_date && settings.end_date && settings.start_date > settings.end_date) invalid.end_date = "结束日期不能早于开始日期。";
    if (!numeric(settings.initial_cash) || settings.initial_cash <= 0) invalid.initial_cash = "初始资金应大于零。";
    for (const key of ["commission_rate", "commission_min", "stamp_tax", "transfer_fee", "slippage", "rebalance_tolerance"] as const) if (settings[key] !== undefined && (!numeric(settings[key]) || settings[key]! < 0)) invalid[key] = "请输入不小于零的数值。";
    for (const [key, value] of Object.entries(strategyParameters)) if (!Number.isInteger(value) || value <= 0) invalid[key] = "请输入大于零的整数。";
    if (Object.keys(invalid).length) { setErrors(invalid); setGroup("basic"); return; }
    if (errors.groups || errors.max_per_group) { setGroup("trading"); return; }
    const current = { requestId: crypto.randomUUID() };
    try { savePending(current, pendingStorage); } catch { errorRef.current("无法保存回测提交凭据，本次尚未提交。请检查本地存储后重试。"); return; }
    submitted.current = true; dispatching.current = true; followPending.current = true; setPending(current); setReport(null); setOperation(null);
    const original = settings.codes ?? [], sameCodes = original.length === list.length && original.every((code, index) => code.slice(0, 6) === list[index]);
    const actual: StockVibeBacktestSettings = selectedScope ? { ...settings } : { ...settings, codes: sameCodes ? original : list };
    if (selectedScope) delete actual.codes;
    const strategy = selectedStrategy
      ? { strategy_id: selectedStrategy.strategy_id, strategy_version: selectedStrategy.version, ...(selectedStrategy.scope_label !== undefined && selectedStrategy.scope ? { scope: selectedStrategy.scope } : {}), ...(Object.keys(strategyParameters).length ? { strategy_parameters: strategyParameters } : {}) }
      : selection.startsWith("run:") ? { run_id: selection.slice(4) } : { template_id: selection.slice(9), strategy_parameters: strategyParameters };
    try { const receipt = await startStockVibeBacktest(current.requestId, { ...strategy, settings: actual }); accept(receipt, current); }
    catch { errorRef.current("正在核对回测提交结果，请勿重复发起。"); }
    finally { dispatching.current = false; }
  }
  function restoreSettings() {
    if (!selectedStrategy) { changeSelection(selection); return; }
    if (!defaults) return;
    const config = selectedStrategy.effective_config ? { ...defaults.defaults, ...selectedStrategy.effective_config } : defaults.defaults;
    setSettings(settingsForStrategy(config, selectedStrategy)); setCodes(initialCodes(config, selectedStrategy, symbols));
    setStrategyParameters(Object.fromEntries((selectedStrategy.parameters ?? []).filter((item) => item.editable && numeric(item.value)).map((item) => [item.name, item.value as number])));
    setErrors({});
  }
  const selectedInput = inputs.find((item) => `run:${item.run_id}` === selection), template = defaults?.templates.find((item) => `template:${item.id}` === selection);
  const rawParameters = selectedStrategy?.parameters ?? selectedInput?.strategy_parameters ?? template?.parameters ?? [];
  const parameters: StockVibeBacktestParameter[] = Array.isArray(rawParameters) ? rawParameters : Object.entries(rawParameters).map(([name, value]) => ({ name, value }));
  const selectedScopeInvalid = selectedStrategy?.scope_label !== undefined && !validStrategyScope(selectedStrategy.scope);
  return <div className="stock-vibe-backtest space-y-4">
    <ToggleTabs value={view} onChange={setView} label="策略回测" items={[["settings", "回测设置"], ["history", "历史记录"], ["report", "回测报告"], ["compare", "报告比较"]]} />
    {view === "settings" && (!loaded ? <p role="status">正在读取原生回测设置…</p> : !defaults ? <p>暂时无法读取回测设置。</p> : <>
      {selectedStrategy ? <p className="text-muted-foreground">回测策略：{selectedStrategy.name}</p> : <Field name="回测策略" help="选取已保存的原生策略，或使用 Vibe 自带多因子示例。沿用原生规则，所选参数用于本次运行；当前候选股票名单不等于生成它的策略。"><Select aria-label="回测策略" value={selection} onValueChange={changeSelection} options={[...defaults.templates.map((item) => ({ value: `template:${item.id}`, label: item.name })), ...inputs.map((item) => ({ value: `run:${item.run_id}`, label: item.title || item.run_id }))]} />{errors.selection && <p className="text-destructive">{errors.selection}</p>}</Field>}
      {selectedStrategy?.can_backtest === false && !selectedScopeInvalid && <p role="status" className="text-muted-foreground">{selectedStrategy.unavailable_reason || "此策略当前还不能回测。"}</p>}
      <div className="flex items-center justify-between gap-2"><ToggleTabs label="回测设置分类" value={group} onChange={setGroup} items={[["basic", "基本设置"], ["trading", "费用与仓位"], ["validation", "数据与检验"]]} /><StockVibeInfo title="策略自身的参数" label="策略参数"><p className="text-muted-foreground">{template?.description ?? (selectedStrategy ? selectedStrategy.name : "以下参数来自已有策略；这里保留原策略代码，不把通用设置当作策略参数。")}</p><dl className="mt-3 grid grid-cols-2 gap-3">{parameters.map((item) => <div key={item.name}><dt className="text-muted-foreground">{LABELS[item.name] ?? item.name}</dt><dd>{display(item.value)}</dd></div>)}</dl>{!parameters.length && <p>原策略未提供可识别的可调参数。</p>}</StockVibeInfo></div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-4">
        {group === "basic" && (selectedStrategy ? parameters.filter((item) => item.editable && numeric(item.value)) : template ? parameters.filter((item) => item.editable) : []).map((item) => <Field key={item.name} name={LABELS[item.name] ?? item.name} help="数值来自所选原生策略；修改仅用于本次回测。需要长期保存时，请用 AI 修改并另存策略。"><Input aria-label={LABELS[item.name] ?? item.name} type="number" min="1" step="1" value={strategyParameters[item.name] ?? ""} onChange={(event) => { setStrategyParameters((current) => ({ ...current, [item.name]: Number(event.target.value) })); setErrors((current) => ({ ...current, [item.name]: "" })); }} aria-invalid={Boolean(errors[item.name])} />{errors[item.name] && <p className="text-destructive">{errors[item.name]}</p>}</Field>)}
        {group === "basic" && <>
          {selectedStrategy?.scope_label !== undefined
            ? <div className="col-span-2"><Field name="股票范围" help="当前回测沿用策略库中选择的股票范围。"><p>{selectedStrategy.scope_label}</p></Field></div>
            : <div className="col-span-2"><Field name="股票范围" help={help("codes")}><div className="flex gap-2"><Input aria-label="股票范围" value={codes} placeholder="输入六位股票代码" onChange={(event) => { setCodes(event.target.value); setErrors((current) => ({ ...current, codes: "" })); }} aria-invalid={Boolean(errors.codes)} />{symbols.length > 0 && <Button variant="ghost" size="sm" onClick={() => setCodes(symbols.map((code) => code.slice(0, 6)).join(", "))}>使用当前名单</Button>}</div>{errors.codes && <p className="text-destructive">{errors.codes}</p>}</Field></div>}
          {textField("start_date", "date")}{textField("end_date", "date")}{textField("initial_cash", "number")}<Field name="行情周期" help={help("interval")}><Select aria-label="行情周期" value={settings.interval} onValueChange={(value) => update("interval", value)} options={defaults.options.intervals.map((value) => ({ value, label: INTERVAL[value] ?? value }))} /></Field>{textField("benchmark", "text", { placeholder: "未指定" })}<Field name="行情来源" help={help("source")}><Select aria-label="行情来源" value={settings.source} onValueChange={(value) => update("source", value)} options={defaults.options.sources.map((value) => ({ value, label: SOURCE[value] ?? value }))} /></Field>
        </>}
        {group === "trading" && <>{(["commission_rate", "commission_min", "stamp_tax", "transfer_fee", "slippage", "rebalance_tolerance"] as const).map((key) => textField(key, "number"))}<Field name="仓位调整" help={help("position_adjustment")}><Select aria-label="仓位调整" value={settings.position_adjustment} onValueChange={(value) => setSettings((current) => ({ ...current, position_adjustment: value, ...(value === "hold" ? { rebalance_mask: null } : {}) }))} options={defaults.options.position_adjustment.map((value) => ({ value, label: value === "hold" ? "保持仓位" : value === "rebalance" ? "按目标权重再平衡" : value }))} /></Field><Field name="调仓日安排" help={help("rebalance_mask")}><Input aria-label="调仓日安排" disabled={settings.position_adjustment !== "rebalance"} value={Array.isArray(settings.rebalance_mask) ? settings.rebalance_mask.join(", ") : settings.rebalance_mask ?? ""} placeholder="未指定" onChange={(event) => update("rebalance_mask", /^\d{4}-/.test(event.target.value) ? event.target.value.split(/[,，\s]+/).filter(Boolean) : event.target.value || null)} /></Field><Field name="仓位分配方法" help={help("optimizer")}><Select aria-label="仓位分配方法" value={settings.optimizer ?? "none"} onValueChange={(value) => { setErrors((current) => ({ ...current, groups: "", max_per_group: "" })); setSettings((current) => ({ ...current, optimizer: value === "none" ? null : value, optimizer_params: value === "none" ? {} : defaults.optimizer_parameters?.[value] ?? {} })); }} options={[{ value: "none", label: "沿用策略" }, ...(defaults.options.optimizers ?? []).filter((value): value is string => Boolean(value)).map((value) => ({ value, label: OPTIMIZER[value] ?? value }))]} /></Field>{Object.entries(settings.optimizer_params ?? {}).map(([key, value]) => key === "groups" || key === "max_per_group" ? <MappingParameter key={`${settings.optimizer}:${key}`} name={key} value={value} onChange={(next) => update("optimizer_params", { ...settings.optimizer_params, [key]: next })} onValidity={(valid) => setErrors((current) => ({ ...current, [key]: valid ? "" : "对应关系格式不正确。" }))} /> : <Field key={key} name={LABELS[key] ?? key} help="所选原生仓位分配方法的参数，初始值来自 Vibe；留空为未指定。"><Input aria-label={LABELS[key] ?? key} type="number" step="any" value={String(value ?? "")} onChange={(event) => update("optimizer_params", { ...settings.optimizer_params, [key]: event.target.value === "" ? null : Number(event.target.value) })} /></Field>)}</>}
        {group === "validation" && <>{textField("warmup_bars", "number", { placeholder: "未指定" })}{textField("evaluation_start_date", "date")}<div className="col-span-2 space-y-4 border-t border-border pt-3">{Object.entries(defaults.validation_parameters ?? {}).map(([key, values]) => <div key={key} className="space-y-2"><label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(settings.validation?.[key])} onChange={(event) => { const next = { ...settings.validation }; if (event.target.checked) next[key] = values; else delete next[key]; update("validation", Object.keys(next).length ? next : null); }} />{VALIDATION[key] ?? key}</label>{settings.validation?.[key] && <div className="grid grid-cols-2 gap-3">{Object.entries(settings.validation[key]).map(([name, value]) => <Field key={name} name={LABELS[name] ?? name} help="用于原生统计检验，初始值来自 Vibe。"><Input aria-label={`${VALIDATION[key] ?? key} ${LABELS[name] ?? name}`} type="number" step="any" value={String(value)} onChange={(event) => update("validation", { ...settings.validation, [key]: { ...settings.validation?.[key], [name]: Number(event.target.value) } })} /></Field>)}</div>}</div>)}</div></>}
      </div><div className="flex items-center justify-between border-t border-border pt-3"><Button variant="ghost" size="sm" disabled={Boolean(pending)} onClick={restoreSettings}>恢复原始设置</Button><Button className="stock-vibe-backtest-primary" disabled={(!selectedStrategy && !selection) || selectedStrategy?.can_backtest === false || (selectedStrategy?.scope_label !== undefined && !validStrategyScope(selectedStrategy.scope)) || Boolean(pending)} onClick={() => { void submit(); }}>{pending ? "正在核对或执行回测…" : "开始回测"}</Button></div>
    </>)}
    {view === "history" && <>
      {!historyLoaded && <p role="status">正在核对进行中的任务…</p>}
      {selectedStrategy ? <>
        <h2 className="text-title-sm">{selectedStrategy.name} · 回测记录</h2>
        {history.map((row) => <div key={row.operation_id} className="flex items-center justify-between border-b border-border py-2"><span>{row.created_at ?? row.operation_id} · {STATUS[row.status] ?? "状态待确认"}</span><Button variant="ghost" size="sm" onClick={() => { void openReport(row); }}>查看</Button></div>)}
        {historyLoaded && history.length === 0 && <p className="text-muted-foreground">此策略还没有回测记录。</p>}
        {historyTotal > 20 && <div className="flex items-center justify-end gap-2"><span className="text-muted-foreground">第 {Math.floor(historyOffset / 20) + 1} 页 · 共 {historyTotal} 次</span><Button variant="ghost" size="sm" disabled={historyOffset === 0} onClick={() => setHistoryOffset((value) => Math.max(0, value - 20))}>上一页</Button><Button variant="ghost" size="sm" disabled={historyOffset + history.length >= historyTotal} onClick={() => setHistoryOffset((value) => value + 20)}>下一页</Button></div>}
      </> : <>
        {history.filter((row) => !TERMINAL.has(row.status)).map((row) => <Button key={row.operation_id} variant="secondary" size="sm" onClick={() => { void openReport(row); }}>查看进行中的回测 · {STATUS[row.status] ?? "正在核对"}</Button>)}
        <Suspense fallback={<p role="status">正在读取原生报告目录…</p>}><NativeReports onError={(message) => errorRef.current(message)} onOpenRun={(runId) => { void openNativeRun(runId); }} /></Suspense>
      </>}
    </>}
    {view === "compare" && <Suspense fallback={<p role="status">正在读取原生报告比较…</p>}><NativeCompare onError={(message) => errorRef.current(message)} initialLeftRunId={report?.run_id ?? initialRunId} /></Suspense>}
    {view === "report" && <>{reportLoading ? <p role="status">正在读取回测报告…</p> : report ? <BacktestReport key={report.run_id} run={report} operation={operation} onError={(message) => errorRef.current(message)} /> : <p role="status" className="py-6 text-center text-muted-foreground">{pending ? pending.operationId ? STATUS[operation?.status ?? "queued"] ?? "正在读取回测进度…" : "正在核对提交结果，不会重复提交。" : operation && operation.status !== "completed" ? STATUS[operation.status] ?? "状态待确认" : "完成一次回测，或从历史记录打开报告。"}</p>}</>}
  </div>;
}
