import { stockVibeRequest, type StockVibeRead, type StockVibeRequestRecord } from "./stock-vibe-api";
import type { StockVibeBacktestParameter, StockVibeBacktestSettings, StockVibeStrategyCoverage, StockVibeStrategyScope, StockVibeStrategyScopeReceipt } from "./stock-vibe-backtest-api";
import builtinCatalog from "./stock-vibe-builtin-catalog.generated.json";

export interface StockVibeLibraryStrategy {
  strategy_id: string; version: string; name: string; source: "builtin" | "custom"; example: boolean;
  market: "china_a" | "options" | "multi_asset"; interval: string; description: string;
  can_scan: boolean; can_backtest: boolean; unavailable_reason: string | null;
  parameters: StockVibeBacktestParameter[]; has_evidence: boolean;
  deleted?: boolean;
}
export interface StockVibeLibraryStrategyDetail extends StockVibeLibraryStrategy {
  rules: Array<{ label: string; value: unknown }>;
  linked_run: { run_id: string; [key: string]: unknown } | null;
  effective_config: StockVibeBacktestSettings | null;
}
export interface StockVibeStrategyScanResult {
  status: "ok"; kind: "strategy_scan"; strategy_id: string; strategy_version: string;
  signals: Array<{ symbol: string; signal: number; target_weight?: number; signal_date: string }>;
  as_of: string; data_as_of: string; effective_at: string | null;
  data_sources: unknown; missing: unknown[]; note?: string;
  scope?: StockVibeStrategyScopeReceipt; coverage?: StockVibeStrategyCoverage;
}
export interface StockVibeStrategyOperation {
  operation_id: string; operation: "strategy_scan" | "backtest"; status: string;
  payload?: { strategy_id?: string; strategy_version?: string; settings?: StockVibeBacktestSettings; scope?: StockVibeStrategyScope; [key: string]: unknown };
  references?: { strategy_id?: string; strategy_version?: string; run_id?: string; output_run_id?: string; effective_config?: StockVibeBacktestSettings; scope?: StockVibeStrategyScopeReceipt; coverage?: StockVibeStrategyCoverage; [key: string]: unknown };
  tool_result?: unknown; error_category?: string | null; created_at?: string; updated_at?: string;
}
export type StockVibeStrategyDeleteOperation = Omit<StockVibeStrategyOperation, "operation"> & { operation: "strategy_delete" };
export interface StockVibeStrategyPage<T> { items: T[]; total: number; limit: number; offset: number; }
export interface StockVibeStrategyContext { strategy_id: string; strategy_version: string; operation_id?: string; }
export interface StockVibeStrategyIndustries {
  items: Array<{ code: string; name: string }>;
  source: unknown; as_of: string | null; fetched_at: string | null;
}

export function stockVibeBuiltinStrategies(query: { q?: string; market?: "china_a" | "all" } = {}): StockVibeLibraryStrategyDetail[] {
  const q = query.q?.trim().toLowerCase() ?? "";
  return structuredClone(builtinCatalog.items as StockVibeLibraryStrategyDetail[]).filter((item) =>
    (query.market === "all" || item.market === "china_a") && (!q || `${item.name} ${item.description}`.toLowerCase().includes(q)));
}
export function stockVibeBuiltinStrategy(id: string): StockVibeLibraryStrategyDetail | null {
  return stockVibeBuiltinStrategies({ market: "all" }).find((item) => item.strategy_id === id) ?? null;
}

export function validStockVibeStrategyId(value: unknown): value is string {
  return typeof value === "string" && /^(?:builtin|sdm):[A-Za-z0-9_.-]{1,128}$/.test(value) && !value.includes("..");
}
function strategyId(value: string) { if (!validStockVibeStrategyId(value)) throw new Error("invalid_strategy_id"); return value; }
function version(value: string) { if (!/^[a-f\d]{64}$/i.test(value)) throw new Error("invalid_strategy_version"); return value; }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function page<T>(value: StockVibeStrategyPage<T>): StockVibeStrategyPage<T> {
  if (!Array.isArray(value?.items) || !Number.isSafeInteger(value.total) || value.total < 0 || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error("invalid_strategy_page");
  return value;
}
export async function getStockVibeStrategyLibrary(query: { q?: string; source?: "builtin" | "custom"; market?: "china_a" | "all"; offset?: number; limit?: number } = {}): Promise<StockVibeStrategyPage<StockVibeLibraryStrategy>> {
  const offset = query.offset ?? 0, limit = query.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_strategy_pagination");
  if (query.source === "builtin") {
    const items = stockVibeBuiltinStrategies(query);
    return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
  }
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset), market: query.market ?? "china_a" });
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.source) params.set("source", query.source);
  const result = page((await stockVibeRequest<StockVibeRead<StockVibeStrategyPage<StockVibeLibraryStrategy>>>(`/strategy-library?${params}`)).native);
  for (const item of result.items) { strategyId(item.strategy_id); version(item.version); }
  return result;
}
export async function getStockVibeLibraryStrategy(id: string): Promise<StockVibeLibraryStrategyDetail> {
  strategyId(id);
  if (id.startsWith("builtin:")) {
    const result = stockVibeBuiltinStrategy(id);
    if (!result) throw new Error("unknown_builtin_strategy");
    return result;
  }
  const result = (await stockVibeRequest<StockVibeRead<StockVibeLibraryStrategyDetail>>(`/strategy-library/${encodeURIComponent(strategyId(id))}`)).native;
  if (result.strategy_id !== id || !Array.isArray(result.rules) || !Array.isArray(result.parameters)) throw new Error("invalid_strategy_detail");
  version(result.version);
  return result;
}
export async function getStockVibeStrategyIndustries(): Promise<StockVibeStrategyIndustries> {
  const result = (await stockVibeRequest<StockVibeRead<StockVibeStrategyIndustries>>("/strategy-library/industries")).native;
  if (!Array.isArray(result?.items) || result.items.some((item) => !item || typeof item.code !== "string" || !/^BK\d+$/.test(item.code) || typeof item.name !== "string" || !item.name.trim())) throw new Error("invalid_strategy_industries");
  return result;
}
export async function getStockVibeStrategyHistory(query: { strategy_id?: string; operation?: "strategy_scan" | "backtest"; offset?: number; limit?: number } = {}): Promise<StockVibeStrategyPage<StockVibeStrategyOperation>> {
  const offset = query.offset ?? 0, limit = query.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_strategy_pagination");
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (query.strategy_id) params.set("strategy_id", strategyId(query.strategy_id));
  if (query.operation) params.set("operation", query.operation);
  const result = page((await stockVibeRequest<StockVibeRead<StockVibeStrategyPage<StockVibeStrategyOperation>>>(`/strategy-library/history?${params}`)).native);
  if (result.items.some((item) => !parseStockVibeStrategyOperation(item))) throw new Error("invalid_strategy_history");
  return result;
}
export function startStockVibeStrategyScan(requestId: string, input: { strategy_id: string; strategy_version: string; scope: StockVibeStrategyScope; settings: StockVibeBacktestSettings; strategy_parameters?: Record<string, number> }): Promise<StockVibeRequestRecord> {
  strategyId(input.strategy_id); version(input.strategy_version);
  if (input.settings.codes !== undefined) throw new Error("strategy_scope_codes_conflict");
  return stockVibeRequest("/operations", { method: "POST", requestId, body: { operation: "strategy_scan", ...input } });
}
export function deleteStockVibeLibraryStrategy(requestId: string, input: { strategy_id: string; strategy_version: string }): Promise<StockVibeRequestRecord> {
  strategyId(input.strategy_id); version(input.strategy_version);
  if (!input.strategy_id.startsWith("sdm:")) throw new Error("only_custom_strategy_can_be_deleted");
  return stockVibeRequest("/operations", { method: "POST", requestId, body: { operation: "strategy_delete", ...input } });
}
export function parseStockVibeStrategyDeleteOperation(value: unknown): StockVibeStrategyDeleteOperation | null {
  return object(value) && typeof value.operation_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.operation_id)
    && value.operation === "strategy_delete" && typeof value.status === "string" ? value as unknown as StockVibeStrategyDeleteOperation : null;
}
export function stockVibeStrategyDeleteConfirmed(operation: StockVibeStrategyDeleteOperation): boolean {
  let result = operation.tool_result;
  if (typeof result === "string") { try { result = JSON.parse(result); } catch { return false; } }
  const expected = operation.references?.strategy_id ?? operation.payload?.strategy_id, revision = operation.references?.strategy_version ?? operation.payload?.strategy_version;
  return operation.status === "completed" && object(result) && result.status === "ok" && result.kind === "strategy_delete" && result.deleted === true
    && validStockVibeStrategyId(expected) && expected.startsWith("sdm:") && result.strategy_id === expected && typeof revision === "string" && /^[a-f\d]{64}$/i.test(revision) && result.strategy_version === revision;
}
export function parseStockVibeStrategyOperation(value: unknown): StockVibeStrategyOperation | null {
  return object(value) && typeof value.operation_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.operation_id)
    && (value.operation === "strategy_scan" || value.operation === "backtest") && typeof value.status === "string" ? value as unknown as StockVibeStrategyOperation : null;
}
export function stockVibeStrategyScanResult(operation: StockVibeStrategyOperation): StockVibeStrategyScanResult | null {
  let raw = operation.tool_result;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return null; } }
  if (operation.operation !== "strategy_scan" || operation.status !== "completed" || !object(raw) || raw.status !== "ok" || raw.kind !== "strategy_scan"
    || !validStockVibeStrategyId(raw.strategy_id) || typeof raw.strategy_version !== "string" || !/^[a-f\d]{64}$/i.test(raw.strategy_version)
    || !Array.isArray(raw.signals) || !Array.isArray(raw.missing) || typeof raw.data_as_of !== "string" || typeof raw.as_of !== "string") return null;
  if (raw.signals.some((signal) => !object(signal) || typeof signal.symbol !== "string" || !/^\d{6}\.(SH|SZ|BJ)$/.test(signal.symbol)
    || typeof signal.signal !== "number" || !Number.isFinite(signal.signal) || typeof signal.signal_date !== "string"
    || signal.target_weight !== undefined && (typeof signal.target_weight !== "number" || !Number.isFinite(signal.target_weight)))) return null;
  const expected = operation.references?.strategy_id ?? operation.payload?.strategy_id, revision = operation.references?.strategy_version ?? operation.payload?.strategy_version;
  if (expected !== raw.strategy_id || revision !== raw.strategy_version) return null;
  return raw as unknown as StockVibeStrategyScanResult;
}
