import { stockVibeRequest, StockVibeApiError, type StockVibeRead, type StockVibeRequestRecord } from "@/lib/stock-vibe-api";
import type { AlphaListParams, AlphaListResponse, AlphaDetailResponse, AlphaReadiness, AlphaBenchRequest, AlphaCompareRequest, RunListItem, RunData } from "./types";
export type * from "./types";
export { StockVibeApiError as ApiError };
export interface AlphaDefaults {
  bench: { operation: string; request_schema: { properties: Record<string, { default?: unknown; minimum?: number; maximum?: number }>; required?: string[] } };
  compare: { operation: string; request_schema: { properties: Record<string, { default?: unknown; minimum?: number; maximum?: number }>; required?: string[] } };
  registry: { total: number; zoo_counts: Record<string, number> };
}
async function read<T>(path: string): Promise<T> { return (await stockVibeRequest<StockVibeRead<T>>(path)).native; }
function objectId(value: string): string { if (!/^[A-Za-z0-9_.:-]{1,192}$/.test(value) || value.includes("..")) throw new StockVibeApiError(0, "invalid_input"); return encodeURIComponent(value); }
function createAlpha(kind: "bench" | "compare", body: AlphaBenchRequest | AlphaCompareRequest): Promise<StockVibeRequestRecord> {
  const { request_id, ...input } = body;
  return stockVibeRequest("/operations", { method: "POST", requestId: request_id, body: { operation: `alpha_${kind}`, ...input } });
}
export const api = {
  listAlphas: (params: AlphaListParams = {}) => { const query = new URLSearchParams(); for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value)); return read<AlphaListResponse>(`/alpha/list${query.size ? `?${query}` : ""}`); },
  getAlpha: (alphaId: string) => read<AlphaDetailResponse>(`/alpha/${objectId(alphaId)}`),
  getAlphaReadiness: () => read<AlphaReadiness>("/alpha/readiness"),
  getAlphaDefaults: () => read<AlphaDefaults>("/alpha/defaults"),
  createAlphaBench: (body: AlphaBenchRequest) => createAlpha("bench", body),
  createAlphaCompare: (body: AlphaCompareRequest) => createAlpha("compare", body),
  listRuns: async (limit?: number) => { const native = await read<RunListItem[] | { runs: RunListItem[] }>(`/reports/runs${limit === undefined ? "" : `?limit=${limit}`}`); return Array.isArray(native) ? native : native.runs; },
  getRun: (runId: string) => read<RunData>(`/reports/runs/${objectId(runId)}`),
};
