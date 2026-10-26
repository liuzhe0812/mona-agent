import { stockVibeRequest, type StockVibeRead, type StockVibeRequestRecord } from "./stock-vibe-api";

export interface StockVibePaperQuote {
  source: string; as_of: string; observed_at: string; market_status: string; adjustment: string;
}
export interface StockVibePaperResearch {
  session_id: string; attempt_id: string; title: string; summary: string; summary_sha256: string;
  completed_at: string; task?: "comprehensive" | "fundamental" | "technical" | "risk";
  mode?: "ultrashort" | "swing" | "medium";
}
export interface StockVibePaperPosition {
  symbol: string; name: string; quantity: number; available_quantity: number; average_cost: number; cost_basis: number;
  mark_price: number | null; mark_as_of: string | null; quote_source: string | null; mark_status: string;
  market_value: number | null; unrealized_pnl: number | null;
}
export interface StockVibePaperAccountState {
  initial_cash: number; cash: number; realized_pnl: number; unrealized_pnl: number | null;
  equity: number | null; total_pnl: number | null;
  /** Percentage points, matching the native account response. */
  total_return: number | null; version: number; created_at: string;
}
export interface StockVibePaperAccount {
  status: "uninitialized" | "ok" | "partial";
  defaults: { initial_cash: number; lot_size: number; fee_model: Record<string, unknown>; currency: "CNY" };
  account: StockVibePaperAccountState | null;
  positions: StockVibePaperPosition[];
  valuation: { complete: boolean; cached: boolean; missing_symbols: string[]; as_of: string | null };
}
export interface StockVibePaperPreview {
  status: "ready"; preview_id: string; expires_at: string; account_version: number;
  symbol: string; name: string; side: "buy" | "sell"; quantity: number; lot_size: number;
  price: number; notional: number; fee: number; cash_delta: number; cash_after: number;
  available_quantity: number; quote: StockVibePaperQuote;
}
export interface StockVibePaperTrade {
  trade_id: string; request_id: string; preview_id?: string; symbol: string; name: string; side: "buy" | "sell";
  quantity: number; price: number; notional: number; fee: number; realized_pnl: number | null;
  cash_after: number; quantity_after: number; note: string; quote: StockVibePaperQuote;
  research: StockVibePaperResearch | null; recorded_at: string; account_version: number;
}
export interface StockVibePaperHistory { items: StockVibePaperTrade[]; total: number; limit: number; offset: number }
export interface StockVibePaperTradeInput {
  preview_id: string; note?: string; research?: { session_id: string; attempt_id: string };
}

const MESSAGES: Record<string, string> = {
  invalid_quantity: "请按模拟数量规则填写正整数股数。",
  insufficient_cash: "模拟资金不足，请减少买入数量。",
  insufficient_quantity: "卖出数量超过模拟持仓，请减少数量。",
  quote_unavailable: "未取得可核对的参考报价，请稍后再试或选择其他股票。",
  account_uninitialized: "请先设置模拟资金，再记录买卖。",
  account_exists: "模拟账户已经建立，已保留原有资金和记录，请重新读取。",
  preview_expired: "参考报价预览已过期，请重新核对后确认。",
  account_changed: "模拟资金或持仓已变化，请重新核对这次记录。",
  preview_consumed: "这份预览已用于保存记录，请先查看交易记录。",
  research_unavailable: "关联研究暂不可用，请取消关联后重试，或重新选择研究。",
  research_symbol_mismatch: "所选研究与当前股票不一致，请重新选择。",
  invalid_response: "未能核对模拟账户返回的内容，请稍后重新读取。",
};
export class StockVibePaperApiError extends Error {
  constructor(readonly code: string) { super(MESSAGES[code] ?? "模拟操作未能完成，请核对输入后重试。"); }
}
export function stockVibePaperError(value: unknown): StockVibePaperApiError {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const detail = data.detail && typeof data.detail === "object" ? data.detail as Record<string, unknown> : data;
  const code = detail.code ?? detail.error;
  return new StockVibePaperApiError(typeof code === "string" ? code : "invalid_response");
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function nullableNumber(value: unknown): boolean { return value === null || finite(value); }
function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new StockVibePaperApiError("invalid_response");
  return value;
}
function validQuote(value: unknown): value is StockVibePaperQuote {
  return object(value) && ["source", "as_of", "observed_at", "market_status", "adjustment"].every((key) => typeof value[key] === "string")
    && value.adjustment === "none" && Number.isFinite(Date.parse(value.as_of as string));
}
export async function getStockVibePaperAccount(): Promise<StockVibePaperAccount> {
  const value = (await stockVibeRequest<StockVibeRead>("/paper/account")).native;
  if (!object(value) || !["uninitialized", "ok", "partial"].includes(String(value.status)) || !object(value.defaults)
    || !finite(value.defaults.initial_cash) || value.defaults.initial_cash <= 0 || !finite(value.defaults.lot_size) || value.defaults.lot_size < 1
    || value.defaults.currency !== "CNY" || !object(value.defaults.fee_model) || !Array.isArray(value.positions)
    || !object(value.valuation) || typeof value.valuation.complete !== "boolean" || typeof value.valuation.cached !== "boolean"
    || !Array.isArray(value.valuation.missing_symbols)) throw new StockVibePaperApiError("invalid_response");
  if (value.positions.some((item) => !object(item) || typeof item.symbol !== "string" || !/^[0-9]{6}\.(SH|SZ|BJ)$/.test(item.symbol)
    || !["quantity", "available_quantity", "average_cost", "cost_basis"].every((key) => finite(item[key]))
    || !["mark_price", "market_value", "unrealized_pnl"].every((key) => nullableNumber(item[key])))) {
    throw new StockVibePaperApiError("invalid_response");
  }
  if (value.status === "uninitialized" ? value.account !== null : !object(value.account)
    || !["initial_cash", "cash", "realized_pnl", "version"].every((key) => finite(value.account && (value.account as Record<string, unknown>)[key]))
    || !["equity", "unrealized_pnl", "total_pnl", "total_return"].every((key) => nullableNumber(value.account && (value.account as Record<string, unknown>)[key]))) {
    throw new StockVibePaperApiError("invalid_response");
  }
  return value as unknown as StockVibePaperAccount;
}
export function createStockVibePaperAccount(requestId: string, input: { initial_cash: number }): Promise<StockVibeRequestRecord> {
  return stockVibeRequest("/paper/account", { method: "POST", requestId, body: input });
}
export async function getStockVibePaperPreview(input: { symbol: string; side: "buy" | "sell"; quantity: number }): Promise<StockVibePaperPreview> {
  const params = new URLSearchParams({ symbol: input.symbol, side: input.side, quantity: String(input.quantity) });
  const value = (await stockVibeRequest<StockVibeRead>(`/paper/preview?${params}`)).native;
  if (object(value) && value.status === "unavailable") throw stockVibePaperError(value);
  if (!object(value) || value.status !== "ready" || typeof value.preview_id !== "string" || !safeId(value.preview_id)
    || value.symbol !== input.symbol || value.side !== input.side || value.quantity !== input.quantity || !finite(value.price) || value.price <= 0
    || !["notional", "fee", "cash_delta", "cash_after", "available_quantity", "account_version", "lot_size"].every((key) => finite(value[key]))
    || typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at)) || !validQuote(value.quote)) {
    throw new StockVibePaperApiError("invalid_response");
  }
  return value as unknown as StockVibePaperPreview;
}
export function commitStockVibePaperTrade(requestId: string, input: StockVibePaperTradeInput): Promise<StockVibeRequestRecord> {
  safeId(input.preview_id);
  return stockVibeRequest("/paper/trades", { method: "POST", requestId, body: input });
}
export async function listStockVibePaperTrades(query: { limit?: number; offset?: number } = {}): Promise<StockVibePaperHistory> {
  const params = new URLSearchParams({ limit: String(query.limit ?? 20), offset: String(query.offset ?? 0) });
  const value = (await stockVibeRequest<StockVibeRead>(`/paper/trades?${params}`)).native;
  if (!object(value) || !Array.isArray(value.items) || !["total", "limit", "offset"].every((key) => Number.isInteger(value[key]))
    || (value.total as number) < 0 || (value.offset as number) < 0 || (value.limit as number) < 1 || value.items.length > (value.limit as number)
    || value.items.some((item) => !object(item) || typeof item.trade_id !== "string" || typeof item.request_id !== "string"
      || typeof item.symbol !== "string" || !["buy", "sell"].includes(String(item.side)) || !finite(item.quantity) || !finite(item.price) || !validQuote(item.quote))) {
    throw new StockVibePaperApiError("invalid_response");
  }
  return value as unknown as StockVibePaperHistory;
}
