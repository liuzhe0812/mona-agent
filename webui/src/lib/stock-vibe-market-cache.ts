import type { StockVibeChartInterval, StockVibeRead, StockVibeWorkbenchMarketData } from "./stock-vibe-api";
import { stockBars, stockRecord, stockNumber, workbenchMarket } from "./stock-vibe-market";

const STORAGE_KEY = "mona.stock-vibe.market-snapshots.v1";
const MAX_ENTRIES = 24;
const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
const VALID_INTERVALS: StockVibeChartInterval[] = ["intraday", "1m", "5m", "15m", "30m", "1H", "1D", "1W", "1M"];

interface MarketSnapshot {
  key: string;
  symbol: string;
  interval: StockVibeChartInterval;
  saved_at: string;
  result: StockVibeRead;
}

interface MarketSnapshotStore {
  version: 1;
  entries: MarketSnapshot[];
}

const snapshotKey = (symbol: string, interval: StockVibeChartInterval) => JSON.stringify([symbol, interval]);

function structuredMarket(result: StockVibeRead, symbol: string, interval: StockVibeChartInterval): StockVibeWorkbenchMarketData | null {
  if (interval !== "intraday" && interval !== "1D") return null;
  const market = workbenchMarket(result, symbol);
  if (!market || market.status !== "ok" || market.interval !== interval) return null;
  if (!stockNumber(market.quote.price) || market.quote.price <= 0) return null;
  if (market.quote.name !== undefined && typeof market.quote.name !== "string") return null;
  if (!Number.isFinite(Date.parse(market.observed_at))) return null;
  return stockBars(result, symbol, interval).bars.length > 0 ? market : null;
}

function observedTime(result: StockVibeRead, symbol: string, interval: StockVibeChartInterval): number {
  const timestamp = interval === "intraday" || interval === "1D"
    ? structuredMarket(result, symbol, interval)?.observed_at : result.observed_at;
  return typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
}

function validSnapshot(value: unknown): value is MarketSnapshot {
  const entry = stockRecord(value);
  if (!entry || typeof entry.symbol !== "string" || !/^\d{6}\.(?:SH|SZ|BJ)$/.test(entry.symbol) || typeof entry.interval !== "string"
    || !VALID_INTERVALS.includes(entry.interval as StockVibeChartInterval)
    || typeof entry.saved_at !== "string" || !Number.isFinite(Date.parse(entry.saved_at))) return false;
  const result = stockRecord(entry.result) as StockVibeRead | null;
  if (!result || !stockRecord(result.native)) return false;
  const interval = entry.interval as StockVibeChartInterval;
  if (snapshotKey(entry.symbol, interval) !== entry.key) return false;
  if (interval === "intraday" || interval === "1D") return structuredMarket(result, entry.symbol, interval) !== null;
  return stockBars(result, entry.symbol, interval).bars.length > 0;
}

function readEntries(): MarketSnapshot[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const store = stockRecord(parsed);
    if (store?.version !== 1 || !Array.isArray(store.entries)) return [];
    return store.entries.filter(validSnapshot).sort((a, b) => Date.parse(b.saved_at) - Date.parse(a.saved_at)).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function storageBytes(value: string): number {
  return value.length * 2;
}

function serialize(entries: MarketSnapshot[]): string {
  return JSON.stringify({ version: 1, entries } satisfies MarketSnapshotStore);
}

export function readStockVibeMarketSnapshot(symbol: string, interval: StockVibeChartInterval): StockVibeRead | null {
  const key = snapshotKey(symbol, interval);
  return readEntries().find((entry) => entry.key === key)?.result ?? null;
}

export function saveStockVibeMarketSnapshot(symbol: string, interval: StockVibeChartInterval, result: StockVibeRead): void {
  if (!/^\d{6}\.(?:SH|SZ|BJ)$/.test(symbol) || !VALID_INTERVALS.includes(interval)
    || !stockRecord(result) || !stockRecord(result.native)) return;
  if (interval === "intraday" || interval === "1D") {
    if (!structuredMarket(result, symbol, interval)) return;
  } else if (stockBars(result, symbol, interval).bars.length === 0) return;

  try {
    const key = snapshotKey(symbol, interval);
    const previousEntries = readEntries();
    const previous = previousEntries.find((existing) => existing.key === key);
    const incomingObserved = observedTime(result, symbol, interval);
    const previousObserved = previous ? observedTime(previous.result, symbol, interval) : Number.NaN;
    if (Number.isFinite(incomingObserved) && Number.isFinite(previousObserved) && incomingObserved < previousObserved) return;
    const entry: MarketSnapshot = { key, symbol, interval, saved_at: new Date(Date.now()).toISOString(), result };
    const entries = [entry, ...previousEntries.filter((existing) => existing.key !== key)]
      .sort((a, b) => Date.parse(b.saved_at) - Date.parse(a.saved_at));
    while (entries.length > MAX_ENTRIES) entries.pop();
    let value = serialize(entries);
    while (entries.length > 0 && storageBytes(value) > MAX_STORAGE_BYTES) {
      entries.pop();
      value = serialize(entries);
    }
    if (!entries.some((saved) => saved.key === key)) return;
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // A market snapshot is only a startup display aid; storage must never block a live read.
  }
}

export function readStockVibeQuoteSnapshots(): Record<string, StockVibeWorkbenchMarketData> {
  const quotes: Record<string, StockVibeWorkbenchMarketData> = {};
  const observedTimes: Record<string, number> = {};
  for (const entry of readEntries()) {
    if (entry.interval !== "intraday" && entry.interval !== "1D") continue;
    const market = structuredMarket(entry.result, entry.symbol, entry.interval);
    if (!market) continue;
    const observed = Date.parse(market.observed_at);
    if (observed > (observedTimes[entry.symbol] ?? Number.NEGATIVE_INFINITY)) {
      quotes[entry.symbol] = market;
      observedTimes[entry.symbol] = observed;
    }
  }
  return quotes;
}
