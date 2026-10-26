import { stockVibeRequest, StockVibeApiError, type StockVibeRequestRecord } from "./stock-vibe-api";

export interface StockVibeDataSettings {
  tushare_configured: boolean;
  source: "settings" | "environment" | "unconfigured";
}
export function parseStockVibeDataSettings(value: unknown): StockVibeDataSettings {
  const data = value as Partial<StockVibeDataSettings> | null;
  if (!data || typeof data.tushare_configured !== "boolean" || !["settings", "environment", "unconfigured"].includes(String(data.source))) throw new StockVibeApiError(0, "invalid_response");
  return { tushare_configured: data.tushare_configured, source: data.source! };
}
export async function getStockVibeDataSettings(): Promise<StockVibeDataSettings> {
  return parseStockVibeDataSettings(await stockVibeRequest("/data-settings"));
}
export function updateStockVibeDataSettings(requestId: string, token: string): Promise<StockVibeRequestRecord> {
  return stockVibeRequest("/data-settings", { method: "PUT", requestId, body: { tushare_token: token } });
}
