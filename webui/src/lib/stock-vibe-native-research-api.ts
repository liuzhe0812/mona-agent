import { stockVibeRequest, type StockVibeRead, type StockVibeRequestRecord } from "./stock-vibe-api";
import type { StockVibeOpportunityCandidate } from "./stock-vibe-opportunity-api";

export interface StockVibeNativeResearchTeam {
  name: string; title: string; description: string; source: string; source_sha256?: string;
  variables: Array<{ name: string; description?: string; required?: boolean; default?: unknown }>;
  tasks: Array<{ id: string; agent_id: string; depends_on?: string[] }>;
  agents: Array<{ id: string; role: string; tools?: string[]; skills?: string[] }>;
}
export interface StockVibeNativeStrategy {
  strategy_id: string; name: string; source?: string; description?: string; has_evidence?: boolean;
  regimes_with_evidence?: string[]; [key: string]: unknown;
}
export interface StockVibeNativeResearchCatalog {
  teams: StockVibeNativeResearchTeam[];
  strategies: { status: string; total: number; returned: number; offset: number; items: StockVibeNativeStrategy[] };
}
export interface StockVibeNativeResearchTask {
  id: string; agent_id: string; status: string; summary?: string | null; iterations?: number; error?: string | null;
  depends_on?: string[]; blocked_by?: string[]; artifacts?: unknown[]; [key: string]: unknown;
}
export interface StockVibeNativeResearchCandidate extends StockVibeOpportunityCandidate {
  as_of: string; task_id: string; artifact_id: string; evidence_refs: unknown[];
  kind: "research_candidate"; evidence_verification: "tool_result_symbol_and_date";
}
export interface StockVibeNativeResearchResult {
  id: string; preset_name: string; status: string; user_vars: Record<string, unknown>;
  tasks: StockVibeNativeResearchTask[]; final_report: string | null; grounding_metadata?: unknown;
  artifacts: Array<{ artifact_id: string; task_id: string; filename: string; bytes?: number; sha256?: string }>;
  linked_runs: Array<{ run_id: string; task_id: string; artifact_id?: string; status?: string; config_sha256?: string; code_sha256?: string }>;
  strategy_ids: string[]; candidates: StockVibeNativeResearchCandidate[]; candidate_sources: unknown[];
  historical_signals?: Array<{ symbol: string; as_of: string; task_id: string; kind: "backtest_target"; weight: number; support: string[]; risks: string[]; evidence_refs: unknown[] }>;
  created_at?: string; completed_at?: string | null;
}
export interface StockVibeNativeResearchRecord {
  id: string; preset_name: string; status: string; created_at?: string; completed_at?: string | null;
  task_count?: number; completed_count?: number; is_stale?: boolean;
}
function id(value: string) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("invalid_native_research_id"); return value; }
export async function getStockVibeNativeResearchCatalog(offset = 0): Promise<StockVibeNativeResearchCatalog> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid_strategy_offset");
  return (await stockVibeRequest<StockVibeRead<StockVibeNativeResearchCatalog>>(`/native-research/catalog?source=sdm&limit=20&offset=${offset}`)).native;
}
export async function getStockVibeNativeResearch(swarmId: string): Promise<StockVibeNativeResearchResult> {
  const result = (await stockVibeRequest<StockVibeRead<StockVibeNativeResearchResult>>(`/native-research/${id(swarmId)}`)).native;
  if (result.id !== swarmId || !Array.isArray(result.tasks) || !Array.isArray(result.candidates) || !Array.isArray(result.candidate_sources)) throw new Error("invalid_native_research_result");
  return { ...result, candidates: result.candidate_sources.length ? result.candidates.filter((candidate) => candidate && candidate.kind === "research_candidate" && candidate.evidence_verification === "tool_result_symbol_and_date" && /^\d{6}\.(SH|SZ|BJ)$/.test(candidate.symbol) && typeof candidate.task_id === "string" && typeof candidate.artifact_id === "string" && result.candidate_sources.some((source) => source && typeof source === "object" && (source as Record<string, unknown>).task_id === candidate.task_id && (source as Record<string, unknown>).artifact_id === candidate.artifact_id) && Array.isArray(candidate.evidence_refs) && candidate.evidence_refs.length > 0 && Array.isArray(candidate.support) && candidate.support.every((item) => typeof item === "string") && Array.isArray(candidate.risks) && candidate.risks.every((item) => typeof item === "string")) : [] };
}
export function startStockVibeNativeResearch(requestId: string, input: { preset_name: string; user_vars: Record<string, unknown> }): Promise<StockVibeRequestRecord> {
  id(input.preset_name);
  return stockVibeRequest("/swarm/runs", { method: "POST", requestId, body: input });
}
export async function getStockVibeNativeStrategy(strategyId: string): Promise<Record<string, unknown>> {
  if (!/^(?:sdm|alpha_zoo):[A-Za-z0-9_.-]{1,128}$/.test(strategyId) || strategyId.includes("..")) throw new Error("invalid_native_strategy_id");
  return (await stockVibeRequest<StockVibeRead<Record<string, unknown>>>(`/native-research/strategies/${encodeURIComponent(strategyId)}`)).native;
}
