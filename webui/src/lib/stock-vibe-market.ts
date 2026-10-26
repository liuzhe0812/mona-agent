import type { StockVibeBar, StockVibeChartInterval, StockVibeRead, StockVibeWorkbenchMarketData } from "./stock-vibe-api";

export function stockRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export const stockNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const stockPrice = (value: unknown) => stockNumber(value)
  ? value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 3 }) : "—";
export const stockDirection = (price: number | null | undefined, previous: number | null | undefined) =>
  stockNumber(price) && stockNumber(previous) && previous > 0
    ? price > previous ? "stock-vibe-up" : price < previous ? "stock-vibe-down" : "" : "";

export function workbenchMarket(result: StockVibeRead | null, symbol: string | null): StockVibeWorkbenchMarketData | null {
  const value = stockRecord(result?.native);
  return value?.symbol === symbol && Array.isArray(value?.bars) && stockRecord(value?.quote)
    ? value as unknown as StockVibeWorkbenchMarketData : null;
}

export function stockBars(result: StockVibeRead | null, symbol: string, interval: StockVibeChartInterval): { bars: StockVibeBar[]; omitted: number } {
  const native = stockRecord(result?.native);
  const data = workbenchMarket(result, symbol);
  if (data ? data.interval !== interval : interval === "intraday") return { bars: [], omitted: 0 };
  const rows = data ? data.bars : native?.[symbol];
  if (!Array.isArray(rows)) return { bars: [], omitted: 0 };
  const bars = rows.filter((row): row is StockVibeBar => {
    const item = stockRecord(row);
    if (!item || typeof item.trade_date !== "string" || !Number.isFinite(Date.parse(item.trade_date)) || !stockNumber(item.close) || item.close <= 0) return false;
    if (interval === "intraday") return true;
    return [item.open, item.high, item.low].every(stockNumber)
      && Number(item.low) <= Math.min(Number(item.open), Number(item.close))
      && Number(item.high) >= Math.max(Number(item.open), Number(item.close));
  });
  return { bars, omitted: rows.length - bars.length };
}
