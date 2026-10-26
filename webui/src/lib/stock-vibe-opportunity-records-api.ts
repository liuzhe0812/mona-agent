import { stockVibeRequest, StockVibeApiError, type StockVibeRead } from "./stock-vibe-api";
import type { StockVibeOpportunityInput } from "./stock-vibe-opportunity-api";

export interface StockVibeOpportunitySelectionRecord {
  id: string;
  title: string;
  kind: "quant" | "research";
  input: StockVibeOpportunityInput;
  createdAt: string;
  updatedAt?: string;
  status: string;
  operationId?: string;
  sessionId?: string;
  attemptId?: string;
}

export async function getStockVibeOpportunityRecords(limit = 20, offset = 0): Promise<{
  items: StockVibeOpportunitySelectionRecord[]; total: number; limit: number; offset: number;
}> {
  const response = await stockVibeRequest<StockVibeRead<{
    items: StockVibeOpportunitySelectionRecord[]; total: number; limit: number; offset: number;
  }>>(`/opportunity-records?limit=${limit}&offset=${offset}`);
  const result = response.native;
  if (!result || !Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0
    || result.limit !== limit || result.offset !== offset || !result.items.every((item) => item
      && /^[a-f0-9]{32}$/.test(item.id) && typeof item.title === "string" && typeof item.status === "string"
      && ["quant", "research"].includes(item.kind) && item.input
      && typeof item.input.plan_id === "string" && ["ultrashort", "swing", "medium"].includes(item.input.mode)
      && ["csi300", "watchlist"].includes(item.input.universe)
      && typeof item.createdAt === "string"
      && (item.kind === "quant" ? /^[A-Za-z0-9_-]{1,128}$/.test(item.operationId ?? "")
        : /^[A-Za-z0-9_-]{1,128}$/.test(item.sessionId ?? ""))
      && (!item.attemptId || /^[A-Za-z0-9_-]{1,128}$/.test(item.attemptId)))) {
    throw new StockVibeApiError(0, "invalid_response");
  }
  return result;
}
