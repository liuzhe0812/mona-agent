import { stockVibeRequest, type StockVibeRead, type StockVibeRequestRecord } from "./stock-vibe-api";

export type StockVibeStrategyScope = { kind: "all_a" } | { kind: "industry"; industry_code: string } | { kind: "watchlist"; codes: string[] };
export interface StockVibeStrategyScopeReceipt {
  kind: "all_a" | "industry" | "watchlist"; industry_code?: string; industry_name?: string;
  source: string; as_of: string; fetched_at: string; count: number;
  membership_basis: "current_snapshot"; snapshot_sha256: string;
}
export interface StockVibeStrategyCoverage { requested: number; loaded: number; evaluated: number; missing: number; complete: boolean; }

export interface StockVibeBacktestSettings {
  source?: string; codes?: string[]; start_date?: string | null; end_date?: string | null; interval?: string;
  initial_cash?: number; commission_rate?: number; commission_min?: number; stamp_tax?: number;
  transfer_fee?: number; slippage?: number; position_adjustment?: string;
  rebalance_mask?: string | string[] | null; rebalance_tolerance?: number;
  benchmark?: string | null; warmup_bars?: number | null; evaluation_start_date?: string | null;
  optimizer?: string | null; optimizer_params?: Record<string, unknown>;
  validation?: Record<string, Record<string, unknown>> | null;
}
export interface StockVibeBacktestParameter { name: string; value: unknown; editable?: boolean; }
export interface StockVibeBacktestStrategyReference {
  strategy_id: string;
  version: string;
  name: string;
  source?: string;
  parameters?: StockVibeBacktestParameter[];
  effective_config?: StockVibeBacktestSettings | null;
  can_backtest?: boolean;
  unavailable_reason?: string | null;
  scope?: StockVibeStrategyScope | null;
  scope_label?: string;
}
export interface StockVibeBacktestDefaults {
  defaults: StockVibeBacktestSettings;
  options: { sources: string[]; intervals: string[]; position_adjustment: string[]; optimizers?: Array<string | null> };
  templates: Array<{ id: string; name: string; description: string; parameters: StockVibeBacktestParameter[] }>;
  fields?: Record<string, string | { label?: string; help?: string; description?: string; default_source?: string }>;
  optimizer_parameters?: Record<string, Record<string, unknown>>;
  validation_parameters?: Record<string, Record<string, unknown>>;
}
export interface StockVibeBacktestInput {
  run_id: string; title: string; status?: string; config: StockVibeBacktestSettings;
  effective_config?: StockVibeBacktestSettings; created_at?: string;
  strategy_parameters?: StockVibeBacktestParameter[] | Record<string, unknown>;
}
export interface StockVibeBacktestOperation {
  operation_id: string; operation: "backtest"; status: string; created_at?: string;
  payload?: { run_id?: string; template_id?: string; strategy_id?: string; strategy_version?: string; scope?: StockVibeStrategyScope; settings?: StockVibeBacktestSettings; strategy_parameters?: Record<string, number> };
  references?: { run_id?: string; output_run_id?: string; effective_config?: StockVibeBacktestSettings; scope?: StockVibeStrategyScopeReceipt; coverage?: StockVibeStrategyCoverage; [key: string]: unknown };
  tool_result?: unknown;
}
export interface StockVibeBacktestStrategyHistory {
  items: StockVibeBacktestOperation[];
  total: number;
  limit: number;
  offset: number;
}
export interface StockVibeBacktestRun {
  run_id: string; status?: string; prompt?: string; metrics?: Record<string, unknown> | null;
  equity_curve?: Array<Record<string, unknown>> | null; trade_log?: Array<Record<string, unknown>> | null;
  artifacts_trades_csv?: Array<Record<string, unknown>> | null;
  config?: StockVibeBacktestSettings; effective_config?: StockVibeBacktestSettings;
  validation?: unknown; risk_xray?: unknown; run_card?: unknown;
  has_factor_artifacts?: boolean;
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid_backtest_identifier");
  return value;
}
function safeStrategyId(value: string): string {
  if (!/^(?:builtin:[A-Za-z0-9_-]{1,128}|sdm:[A-Za-z0-9_.-]{1,128})$/.test(value)) throw new Error("invalid_backtest_strategy_id");
  return value;
}
export async function listStockVibeBacktestStrategyHistory(strategyId: string, limit = 100, offset = 0): Promise<StockVibeBacktestStrategyHistory> {
  safeStrategyId(strategyId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new Error("invalid_backtest_history_page");
  const query = new URLSearchParams({ strategy_id: strategyId, operation: "backtest", limit: String(limit), offset: String(offset) });
  return (await stockVibeRequest<StockVibeRead<StockVibeBacktestStrategyHistory>>(`/strategy-library/history?${query}`)).native;
}
export async function getStockVibeBacktestDefaults(): Promise<StockVibeBacktestDefaults> {
  return (await stockVibeRequest<StockVibeRead<StockVibeBacktestDefaults>>("/backtest-settings/defaults")).native;
}
export async function getStockVibeBacktestInputs(): Promise<StockVibeBacktestInput[]> {
  return (await stockVibeRequest<StockVibeRead<{ inputs: StockVibeBacktestInput[] }>>("/backtest-settings/inputs")).native.inputs;
}
export function startStockVibeBacktest(requestId: string, input: {
  run_id?: string; template_id?: string; strategy_id?: string; strategy_version?: string;
  settings: StockVibeBacktestSettings; strategy_parameters?: Record<string, number>; scope?: StockVibeStrategyScope;
}): Promise<StockVibeRequestRecord> {
  const legacySelection = Boolean(input.run_id) !== Boolean(input.template_id);
  const strategySelection = Boolean(input.strategy_id) && Boolean(input.strategy_version);
  if ((legacySelection && (input.strategy_id !== undefined || input.strategy_version !== undefined))
    || (strategySelection && (input.run_id !== undefined || input.template_id !== undefined))
    || (!legacySelection && !strategySelection)) throw new Error("backtest_strategy_required");
  if (input.run_id) safeId(input.run_id);
  if (input.template_id) safeId(input.template_id);
  if (input.strategy_id) safeStrategyId(input.strategy_id);
  if (input.strategy_version && !/^[a-f\d]{64}$/i.test(input.strategy_version)) throw new Error("invalid_backtest_strategy_version");
  if (input.scope && (!strategySelection || input.settings.codes !== undefined)) throw new Error("conflicting_backtest_scope");
  return stockVibeRequest("/operations", { method: "POST", requestId, body: { operation: "backtest", ...input } });
}
export function stockVibeBacktestSettings(config: StockVibeBacktestSettings): StockVibeBacktestSettings {
  const keys: Array<keyof StockVibeBacktestSettings> = ["source", "codes", "start_date", "end_date", "interval", "initial_cash", "commission_rate", "commission_min", "stamp_tax", "transfer_fee", "slippage", "position_adjustment", "rebalance_mask", "rebalance_tolerance", "benchmark", "warmup_bars", "evaluation_start_date", "optimizer", "optimizer_params", "validation"];
  return Object.fromEntries(keys.filter((key) => key in config).map((key) => [key, config[key]]));
}
export async function getStockVibeBacktestRun(runId: string): Promise<StockVibeBacktestRun> {
  return (await stockVibeRequest<StockVibeRead<StockVibeBacktestRun>>(`/reports/runs/${safeId(runId)}`)).native;
}
export function getStockVibeBacktestConfig(runId: string): Promise<StockVibeBacktestSettings> {
  return stockVibeRequest<StockVibeBacktestSettings>(`/artifacts/run-config/${safeId(runId)}`);
}
export async function getStockVibeBacktestFactor(runId: string): Promise<import("@/components/stock-vibe/native/lib/types").FactorReportPayload> {
  return (await stockVibeRequest<StockVibeRead<import("@/components/stock-vibe/native/lib/types").FactorReportPayload>>(`/reports/runs/${safeId(runId)}/factor`)).native;
}
export function parseStockVibeBacktestOperation(value: unknown): StockVibeBacktestOperation | null {
  const row = value as Partial<StockVibeBacktestOperation> | null;
  return row && typeof row === "object" && row.operation === "backtest" && typeof row.operation_id === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(row.operation_id) && typeof row.status === "string" ? row as StockVibeBacktestOperation : null;
}
export function stockVibeBacktestRunId(operation: StockVibeBacktestOperation): string | null {
  let result = operation.tool_result;
  if (typeof result === "string") { try { result = JSON.parse(result); } catch { result = null; } }
  const body = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const id = operation.references?.output_run_id ?? operation.references?.run_id ?? body.run_id;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}
