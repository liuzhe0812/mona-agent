import { stockVibeRequest, StockVibeApiError, type StockVibeRead, type StockVibeRequestRecord } from "./stock-vibe-api";

export type OpportunityMode = "ultrashort" | "swing" | "medium";
export type OpportunityUniverse = "csi300" | "watchlist";

export interface StockVibeOpportunityPlan {
  id: string;
  title: string;
  description: string;
  kind: "quant" | "research";
  mechanism: string;
  sources: string[];
  limitations: string[];
  suitable_modes: string[];
  prompt?: string;
}

export interface StockVibeOpportunityInput {
  plan_id: string;
  plan_ids?: string[];
  mode: OpportunityMode;
  universe: OpportunityUniverse;
  symbols?: string[];
  conditions?: string;
}

export interface StockVibeOpportunityHistoryInput extends StockVibeOpportunityInput {
  selection_date: string;
  horizon: number;
  top_n: number;
}

export interface StockVibeOpportunityHistoryRangeInput extends StockVibeOpportunityInput {
  start_date: string;
  end_date: string;
  horizon: number;
  top_n: number;
}

export type StockVibeOpportunityHistoryRequest = StockVibeOpportunityHistoryInput | StockVibeOpportunityHistoryRangeInput;

export interface StockVibeOpportunityHistoryResult {
  kind: "opportunity_history";
  version: 1;
  status: "completed" | "incomplete" | "unavailable";
  selection_date: string;
  horizon: number;
  top_n: number;
  plan_ids: string[];
  universe: OpportunityUniverse;
  window: { start_date: string | null; end_date: string | null; available_trading_days: number };
  candidates: Array<{
    symbol: string; name?: string; rank: number;
    start_price: number | null; end_price: number | null; return: number | null;
    status: "observed" | "missing" | "pending"; reason?: string;
    industry?: { name?: string; symbol?: string; return: number | null; excess: number | null; status: string; reason?: string };
    market_excess: number | null;
    market_comparison_reason?: string | null;
  }>;
  summary: {
    selected: number; observed: number; average_return: number | null; market_return: number | null;
    industry_return: number | null; excess_market: number | null; excess_industry: number | null;
  };
  benchmark: {
    name: string; symbol: string; return: number | null; start_price: number | null; end_price: number | null;
    status: string; reason?: string; source?: unknown;
  };
  calculation: { start_basis: string; end_basis: string; weighting: string; fees: string; adjustment: string; range_end?: string; continued_observation?: string };
  method: Record<string, unknown>;
  coverage: Record<string, unknown>;
  limitations: string[];
  request?: StockVibeOpportunityHistoryRequest;
  observation_cutoff?: string;
  awaiting_observation?: boolean;
}

export interface StockVibeOpportunityHistoryRangeResult {
  kind: "opportunity_history_range";
  version: 1;
  status: "completed" | "incomplete" | "unavailable";
  start_date: string;
  end_date: string;
  horizon: number;
  top_n: number;
  plan_ids: string[];
  universe: OpportunityUniverse;
  frequency_trading_days: number;
  sampling?: "all_market_days_v1";
  roster_scopes?: string[];
  batches: Array<{
    batch_id: string; selection_date: string; status: string;
    summary: StockVibeOpportunityHistoryResult["summary"];
    window: StockVibeOpportunityHistoryResult["window"];
  }>;
  summary: {
    total_batches: number; complete_batches: number; average_return: number | null; market_return: number | null;
    industry_return: number | null; excess_market: number | null; excess_industry: number | null;
    outperform_market_count: number; comparable_market_batches: number;
    evaluated_start_date?: string | null; evaluated_end_date?: string | null;
    incomplete_batches?: number; unavailable_batches?: number; empty_batches?: number;
  };
  period_summaries?: Array<{
    label: string; start_date: string; end_date: string; total_batches: number; complete_batches: number;
    average_return: number | null; market_return: number | null; industry_return: number | null;
    excess_market: number | null; excess_industry: number | null;
  }>;
  offset_stability?: {
    groups: Array<{ offset: number; total_batches: number; complete_batches: number; average_return: number | null; excess_market: number | null }>;
    min_average_return: number | null; max_average_return: number | null;
  };
  calculation: StockVibeOpportunityHistoryResult["calculation"];
  limitations: string[];
  request: StockVibeOpportunityHistoryRangeInput;
  observation_cutoff?: string;
  awaiting_observation?: boolean;
}

export type StockVibeOpportunityHistoryOutput = StockVibeOpportunityHistoryResult | StockVibeOpportunityHistoryRangeResult;

export interface StockVibeOpportunityHistoryRecord {
  operation_id: string;
  operation: string;
  status: string;
  result_status?: string | null;
  created_at: string;
  updated_at: string;
  input: StockVibeOpportunityHistoryRequest;
  summary?: Partial<StockVibeOpportunityHistoryResult["summary"] & StockVibeOpportunityHistoryRangeResult["summary"]>;
  batch_count?: number;
  source_operation_id?: string;
}

export interface StockVibeOpportunityHistoryPage {
  items: StockVibeOpportunityHistoryRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface StockVibeOpportunityCandidate {
  symbol: string;
  name?: string;
  rank?: number;
  score?: number;
  price?: number;
  change_pct?: number;
  support: string[];
  risks: string[];
  counter_evidence?: string[];
  checks?: Array<{ plan_id: string; status: "supported"; reason: string }>;
  contributions?: Array<{ factor_id: string; name?: string; value?: number; standardized_value?: number; contribution?: number; imputed?: boolean }>;
}

export interface StockVibeOpportunityResult {
  message?: string;
  version?: string | number;
  as_of?: string;
  plan_id?: string;
  candidates: StockVibeOpportunityCandidate[];
  coverage?: { requested?: number; used?: number; dropped?: unknown; universe?: string };
  factor_audit?: { total?: number; computed?: number; selected?: number; entries?: Array<{
    factor_id: string; family: string; status: "computed" | "excluded" | "failed";
    selected: boolean; reason: string; selection_reason?: string; name?: string;
    training_rank_ic?: number; required_fields?: string[];
  }> };
  method?: Record<string, unknown>;
  composition?: {
    plan_ids: string[];
    rule: "all_selected";
    backtest_status: "not_run";
    methods: Array<{ plan_id: string; title: string; as_of: string; method: Record<string, unknown>;
      factor_audit?: { total?: number; computed?: number; selected?: number };
      backtests?: StockVibeOpportunityResult["backtests"] }>;
  };
  validations?: Array<{ id: string; label: string; status: string; summary?: string }>;
  backtests?: Array<{
    kind: "selected" | "random_41" | "random_42" | "random_43";
    run_id: string;
    metrics: { total_return?: number | null; max_drawdown?: number | null; sharpe_ratio?: number | null; total_trades?: number | null };
  }>;
  limitations?: string[];
  report_markdown?: string;
  artifact?: unknown;
}

function objectId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new StockVibeApiError(0, "invalid_input");
  return encodeURIComponent(id);
}

export async function getStockVibeOpportunityPlans(): Promise<{ plans: StockVibeOpportunityPlan[] }> {
  const response = await stockVibeRequest<StockVibeRead<{ plans: StockVibeOpportunityPlan[] }>>("/opportunity-plans");
  return response.native;
}

export function startStockVibeOpportunity(requestId: string, input: StockVibeOpportunityInput): Promise<StockVibeRequestRecord> {
  return stockVibeRequest("/operations", { method: "POST", requestId, body: { operation: "opportunity_screen", ...input } });
}

export async function getStockVibeOpportunityHistory(limit = 20, offset = 0): Promise<StockVibeOpportunityHistoryPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new StockVibeApiError(0, "invalid_input");
  const response = await stockVibeRequest<StockVibeRead<StockVibeOpportunityHistoryPage>>(`/opportunity-history?limit=${limit}&offset=${offset}`);
  return response.native;
}

export async function getStockVibeOpportunityHistoryBatch(operationId: string, batchId: string): Promise<StockVibeOpportunityHistoryResult> {
  const response = await stockVibeRequest<StockVibeRead<unknown>>(`/opportunity-history/${objectId(operationId)}/batches/${objectId(batchId)}`);
  const result = parseStockVibeOpportunityHistory(response.native);
  if (!result) throw new StockVibeApiError(0, "invalid_response");
  return result;
}

export function parseStockVibeOpportunityHistoryRange(value: unknown): StockVibeOpportunityHistoryRangeResult | null {
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
  const numberOrNull = (item: unknown) => item === null || (typeof item === "number" && Number.isFinite(item));
  const integer = (item: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => typeof item === "number" && Number.isInteger(item) && item >= min && item <= max;
  const day = (item: unknown) => typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item);
  if (!object(value) || value.kind !== "opportunity_history_range" || value.version !== 1
    || !["completed", "incomplete", "unavailable"].includes(String(value.status)) || !day(value.start_date) || !day(value.end_date)
    || !integer(value.horizon, 1, 20) || !integer(value.top_n, 1, 50)
    || (value.sampling === undefined ? value.frequency_trading_days !== value.horizon : value.sampling !== "all_market_days_v1" || value.frequency_trading_days !== 1)
    || !["csi300", "watchlist"].includes(String(value.universe)) || !Array.isArray(value.plan_ids) || !value.plan_ids.every((item) => typeof item === "string")
    || !object(value.summary) || !["total_batches", "complete_batches", "outperform_market_count", "comparable_market_batches"].every((key) => integer((value.summary as Record<string, unknown>)[key], 0))
    || !["average_return", "market_return", "industry_return", "excess_market", "excess_industry"].every((key) => numberOrNull((value.summary as Record<string, unknown>)[key]))
    || !object(value.calculation) || !["start_basis", "end_basis", "weighting", "fees", "adjustment"].every((key) => typeof (value.calculation as Record<string, unknown>)[key] === "string")
    || !Array.isArray(value.limitations) || !value.limitations.every((item) => typeof item === "string") || !object(value.request)
    || !Array.isArray(value.batches) || !value.batches.every((item) => object(item) && typeof item.batch_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.batch_id)
      && day(item.selection_date) && typeof item.status === "string" && object(item.summary) && object(item.window))) return null;
  const summary = value.summary as Record<string, unknown>;
  if (!["evaluated_start_date", "evaluated_end_date"].every((key) => summary[key] === undefined || summary[key] === null || day(summary[key]))
    || !["incomplete_batches", "unavailable_batches", "empty_batches"].every((key) => summary[key] === undefined || integer(summary[key], 0))
    || (value.roster_scopes !== undefined && (!Array.isArray(value.roster_scopes) || !value.roster_scopes.every((item) => typeof item === "string")))
    || (value.period_summaries !== undefined && (!Array.isArray(value.period_summaries) || !value.period_summaries.every((item) => object(item)
      && typeof item.label === "string" && day(item.start_date) && day(item.end_date) && integer(item.total_batches, 0) && integer(item.complete_batches, 0)
      && ["average_return", "market_return", "industry_return", "excess_market", "excess_industry"].every((key) => numberOrNull(item[key])))))
    || (value.offset_stability !== undefined && (!object(value.offset_stability) || !numberOrNull(value.offset_stability.min_average_return) || !numberOrNull(value.offset_stability.max_average_return)
      || !Array.isArray(value.offset_stability.groups) || !value.offset_stability.groups.every((item) => object(item) && integer(item.offset, 0) && integer(item.total_batches, 0)
        && integer(item.complete_batches, 0) && numberOrNull(item.average_return) && numberOrNull(item.excess_market))))) return null;
  return value as unknown as StockVibeOpportunityHistoryRangeResult;
}

export function parseStockVibeOpportunityHistory(value: unknown): StockVibeOpportunityHistoryResult | null {
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
  const numberOrNull = (item: unknown) => item === null || (typeof item === "number" && Number.isFinite(item));
  const day = (item: unknown) => typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item);
  const integer = (item: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => typeof item === "number" && Number.isInteger(item) && item >= min && item <= max;
  if (!object(value) || value.kind !== "opportunity_history" || value.version !== 1
    || !["completed", "incomplete", "unavailable"].includes(String(value.status)) || !day(value.selection_date)
    || !integer(value.horizon, 1, 20) || !integer(value.top_n, 1, 50)
    || !["csi300", "watchlist"].includes(String(value.universe))
    || !Array.isArray(value.plan_ids) || !value.plan_ids.every((id) => typeof id === "string")
    || !object(value.window) || ![value.window.start_date, value.window.end_date].every((item) => item === null || day(item))
    || !integer(value.window.available_trading_days, 0) || !object(value.summary)
    || !integer(value.summary.selected, 0) || !integer(value.summary.observed, 0)
    || !["average_return", "market_return", "industry_return", "excess_market", "excess_industry"].every((key) => numberOrNull(value.summary && (value.summary as Record<string, unknown>)[key]))
    || !object(value.benchmark) || typeof value.benchmark.name !== "string" || typeof value.benchmark.symbol !== "string"
    || typeof value.benchmark.status !== "string" || !["return", "start_price", "end_price"].every((key) => numberOrNull((value.benchmark as Record<string, unknown>)[key]))
    || !object(value.calculation) || !["start_basis", "end_basis", "weighting", "fees", "adjustment"].every((key) => typeof (value.calculation as Record<string, unknown>)[key] === "string")
    || !object(value.method) || !object(value.coverage) || !Array.isArray(value.limitations) || !value.limitations.every((item) => typeof item === "string")
    || !Array.isArray(value.candidates) || !value.candidates.every((item) => object(item) && /^\d{6}\.(SH|SZ|BJ)$/.test(String(item.symbol))
      && integer(item.rank, 1) && ["observed", "missing", "pending"].includes(String(item.status))
      && [item.return, item.start_price, item.end_price, item.market_excess].every(numberOrNull)
      && (item.industry === undefined || (object(item.industry) && typeof item.industry.status === "string"
        && [item.industry.return, item.industry.excess].every(numberOrNull))))) return null;
  return value as unknown as StockVibeOpportunityHistoryResult;
}

export function createStockVibeOpportunitySession(requestId: string, title: string, input: StockVibeOpportunityInput): Promise<StockVibeRequestRecord> {
  return stockVibeRequest("/sessions", { method: "POST", requestId, body: { title, opportunity: input } });
}

export async function getStockVibeOpportunitySession(sessionId: string, attemptId?: string): Promise<StockVibeOpportunityResult> {
  const query = attemptId ? `?attempt_id=${objectId(attemptId)}` : "";
  const response = await stockVibeRequest<StockVibeRead<StockVibeOpportunityResult>>(`/opportunity-sessions/${objectId(sessionId)}${query}`);
  return response.native;
}

export function parseStockVibeOpportunityResult(value: unknown): StockVibeOpportunityResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.candidates)) return null;
  return {
    ...result,
    candidates: result.candidates.flatMap((item): StockVibeOpportunityCandidate[] => {
      if (!item || typeof item !== "object" || !/^\d{6}\.(SH|SZ|BJ)$/.test(item.symbol)) return [];
      const strings = (items: unknown): string[] => Array.isArray(items) ? items.filter((s): s is string => typeof s === "string") : [];
      return [{ ...item, support: strings(item.support), risks: strings(item.risks) }];
    }),
  } as StockVibeOpportunityResult;
}
