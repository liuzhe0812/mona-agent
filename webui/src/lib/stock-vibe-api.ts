import { getServicesHttpBase } from "./services-http-base";
import { httpFetch, isTauri } from "./tauri";

const PREFIX = "/api/stock-vibe";
const UUID = /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;

export type StockVibeRequestStatus = "pending" | "completed" | "rejected" | "unknown";

export interface StockVibeSource {
  data_root_sha256: string;
  instance_id: string;
  snapshot_id: string;
  patches: Array<{ path: string; category: string; sha256: string }>;
  model_binding?: {
    model?: string;
    max_tokens?: number;
    reasoning_effort?: string | null;
    context_window_tokens?: number;
    context_window_verified?: boolean;
  } | null;
}

export interface StockVibeModelBinding {
  executor: "codex" | "claude" | "codebuddy";
  model: string;
  provider?: null;
  effort?: string | null;
}

export interface StockVibeRequestRecord {
  request_id: string;
  method: string;
  path: string;
  payload_sha256: string;
  status: StockVibeRequestStatus;
  error_category: string | null;
  source: StockVibeSource | null;
  source_sha256: string | null;
  receipt: { status_code: number; body: unknown } | null;
  receipt_sha256: string | null;
  created_at: string;
  updated_at: string;
  request_url?: string;
  receipt_owner?: "vibe" | "mona_settings";
}

export interface StockVibeUploadReceipt {
  upload_id: string;
  request_id: string;
  filename: string;
  size_bytes: number | null;
  payload_sha256: string;
  receipt_sha256: string;
  source: StockVibeSource;
  uploaded_at: string;
}

export interface StockVibeUploadList {
  uploads: StockVibeUploadReceipt[];
}

export interface StockVibeRead<T = unknown> {
  native: T;
  source: StockVibeSource | null;
  observed_at?: string;
}

export interface StockVibeStatus {
  execution_allowed: boolean;
  model_preset: string | null;
  model_binding?: StockVibeModelBinding | null;
  tushare_token_configured: boolean;
  running: boolean;
  diagnostic: string | null;
}

export type StockVibeAttentionMode = "manual" | "important_changes" | "continuous";

export interface StockVibeAttentionPreferences {
  proactive_mode: StockVibeAttentionMode;
  watched_symbols: string[];
  notification_start: string;
  notification_end: string;
  attention_interval_sec: number;
  data_sources: string[];
}

export interface StockVibeAttentionRead {
  preferences: StockVibeAttentionPreferences;
  execution_allowed: boolean;
  runtime: Record<string, unknown> | null;
}

export type StockVibeScenarioMode = "ultrashort" | "swing" | "medium";
export type StockVibeScenarioJudgment = "bullish" | "bearish" | "neutral" | "watch" | "insufficient_data";

export interface StockVibeScenarioCondition {
  field: string;
  operator: "gt" | "gte" | "lt" | "lte" | "equal";
  threshold: number | null;
  evidence_ref: string | null;
  source: string | null;
  observed_at: string | null;
  missing_data: string | null;
}

export interface StockVibeScenarioArtifact {
  artifact_id: string;
  run_id: string;
  symbol: string;
  exchange: string;
  as_of: string;
  mode: StockVibeScenarioMode;
  horizon: string;
  judgment: StockVibeScenarioJudgment;
  next_step: string;
  conditions: StockVibeScenarioCondition[];
  invalidation: StockVibeScenarioCondition[];
  review_at: string | null;
  supersedes: string | null;
  revision_reason: string | null;
  created_at: string;
  source: StockVibeSource;
}

export interface StockVibeScenarioList {
  scenarios: StockVibeScenarioArtifact[];
}

export interface StockVibeCreateSessionInput {
  title?: string;
  workbench?: StockVibeWorkbenchContext;
  journal_operation_id?: string;
  native_research?: StockVibeNativeResearchOrigin;
  strategy_creation?: boolean;
}

export type StockVibeNativeResearchOrigin =
  | { swarm_id: string; task_id?: string; symbol?: string; strategy_id?: never; strategy_version?: never; operation_id?: never }
  | { strategy_id: string; strategy_version?: string; operation_id?: string; swarm_id?: never; task_id?: never; symbol?: never };

export type StockVibeResearchTask = "comprehensive" | "fundamental" | "technical" | "risk";
export interface StockVibeWorkbenchContext {
  symbol: string;
  task: StockVibeResearchTask;
  mode: StockVibeScenarioMode;
}

export interface StockVibeWorkbenchSession {
  session_id: string;
  title: string;
  task: StockVibeResearchTask;
  mode: StockVibeScenarioMode;
  status: string;
  last_attempt_id: string | null;
  created_at: string;
  updated_at: string;
  attempt: StockVibeAttempt | null;
}

export interface StockVibeWorkbenchReport {
  session_id: string;
  attempt_id: string;
  task: StockVibeResearchTask;
  mode: StockVibeScenarioMode;
  summary: string;
  created_at: string;
  completed_at: string | null;
  grounding_validation?: StockVibeAttempt["grounding_validation"];
}

export interface StockVibeSchedule {
  id: string;
  title: string;
  status: string;
  schedule: string;
  next_run_at: string | null;
  last_run_at: string | null;
  timezone?: string;
  config?: { mona_workbench?: StockVibeWorkbenchContext };
}

export interface StockVibeWorkbenchData {
  symbol: string;
  sessions: StockVibeWorkbenchSession[];
  latest_report: StockVibeWorkbenchReport | null;
  scheduled_jobs: StockVibeSchedule[];
  scheduler: { enabled?: boolean; running?: boolean; executable?: boolean } | null;
  portfolio: unknown;
  errors: Array<{ section: string; code: string }>;
}

export function getStockVibeWorkbench(symbol: string): Promise<StockVibeRead<StockVibeWorkbenchData>> {
  return read(`/workbench?${new URLSearchParams({ symbol })}`);
}

export interface StockVibeAnalysisRecord {
  session_id: string; attempt_id: string | null; title: string;
  task: StockVibeResearchTask; mode: StockVibeScenarioMode; status: string;
  created_at: string; completed_at: string | null;
}

export interface StockVibeAnalysisHistory {
  symbol: string; offset: number; limit: number; total: number; items: StockVibeAnalysisRecord[];
}

export function getStockVibeAnalysisHistory(symbol: string, query: {
  q: string; task: StockVibeResearchTask | "all"; state: "all" | "completed" | "active" | "unfinished";
  offset: number; limit: number;
}): Promise<StockVibeRead<StockVibeAnalysisHistory>> {
  return read(`/workbench/history?${new URLSearchParams({ symbol, ...query, offset: String(query.offset), limit: String(query.limit) })}`);
}

export interface StockVibeAttentionEvent {
  event_id: string; kind: string; symbol: string; created_at: string;
  session_id?: string | null; attempt_id?: string | null; artifact_id?: string | null;
}

export function getStockVibeAttentionEvents(): Promise<StockVibeRead<{ events: StockVibeAttentionEvent[] }>> {
  return read<{ events: StockVibeAttentionEvent[] }>("/attention/events");
}

export function createStockVibeSchedule(stableRequestId: string, input: {
  id: string; title: string; prompt: string; schedule: string;
  timezone: "Asia/Shanghai"; workbench: StockVibeWorkbenchContext;
}): Promise<StockVibeRequestRecord> {
  return write("/scheduled-runs", stableRequestId, input);
}

export function cancelStockVibeSchedule(id: string, stableRequestId: string): Promise<StockVibeRequestRecord> {
  return stockVibeRequest(`/scheduled-runs/${objectId(id)}`, { method: "DELETE", requestId: requestId(stableRequestId) });
}

export function updateStockVibeSchedule(id: string, stableRequestId: string, input: { schedule: string; timezone: "Asia/Shanghai" }): Promise<StockVibeRequestRecord> {
  return stockVibeRequest(`/scheduled-runs/${objectId(id)}`, { method: "PATCH", requestId: requestId(stableRequestId), body: input });
}

export interface StockVibeSendMessageInput {
  content: string;
  research?: { symbol: string | null; mode: StockVibeScenarioMode };
  attachments?: { file_path: string; filename: string }[];
}

export interface StockVibeStartSwarmInput {
  preset_name: string;
  user_vars: {
    symbol: string;
    start_date: string;
    end_date: string;
    question?: string;
  };
}

export interface StockVibeEventTarget {
  kind: "session" | "swarm";
  object_id: string;
  last_event_id?: string;
}

export class StockVibeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(safeMessage(code, status));
    this.name = "StockVibeApiError";
  }
}

const SAFE_MESSAGES: Record<string, string> = {
  request_conflict: "此请求标识已用于另一项操作，请核对请求状态。",
  invalid_input: "请求内容无效，请检查后重试。",
  not_found: "未找到这项记录。",
  native_unavailable: "股票服务暂不可用，请查看功能资源和模型设置。",
  market_data_unavailable: "未能取得所选行情，请稍后刷新行情或切换周期。",
  market_query_unsupported: "当前数据源不支持所选行情，请核对代码或切换周期。",
  forecast_unavailable: "当前行情不足以生成走势预测，可以稍后刷新。",
  services_unavailable: "股票服务暂不可用，请稍后重试。",
  invalid_response: "股票服务返回了无法识别的响应。",
  network_error: "无法连接股票服务，请稍后重试。",
  http_error: "股票服务暂时无法完成此请求。",
  invalid_request_id: "提交操作需要有效且稳定的 UUID 请求标识。",
};

function safeMessage(code: string, status: number): string {
  return SAFE_MESSAGES[code] ?? `股票服务请求失败（${status}）。`;
}

function requestId(value: string): string {
  if (!UUID.test(value)) throw new StockVibeApiError(0, "invalid_request_id");
  return value;
}

function objectId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new StockVibeApiError(0, "invalid_input");
  }
  return encodeURIComponent(value);
}

function queryString(limit?: number): string {
  if (limit === undefined) return "";
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new StockVibeApiError(0, "invalid_input");
  }
  return `?${new URLSearchParams({ limit: String(limit) })}`;
}

async function servicesBase(): Promise<string> {
  try {
    const base = await getServicesHttpBase();
    if (base) return base;
    if (import.meta.env.DEV && !isTauri()) return window.location.origin;
  } catch {
    // Do not expose native/Tauri exception details to the user.
  }
  throw new StockVibeApiError(0, "services_unavailable");
}

function responseCode(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const code = (body as { error?: unknown }).error;
    if (typeof code === "string" && code in SAFE_MESSAGES) return code;
  }
  if (status === 409) return "request_conflict";
  if (status === 400 || status === 413 || status === 422) return "invalid_input";
  if (status === 404) return "not_found";
  if (status === 503) return "native_unavailable";
  return "http_error";
}

export async function stockVibeRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; requestId?: string } = {},
): Promise<T> {
  const base = await servicesBase();
  const method = options.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  const hasBody = options.body !== undefined;
  if (hasBody) headers.set("Content-Type", "application/json");
  if (method !== "GET") {
    headers.set("X-Mona-Request-ID", requestId(options.requestId ?? ""));
  }

  let response: Response;
  try {
    const body = hasBody ? JSON.stringify(options.body) : undefined;
    if (hasBody && body === undefined) throw new StockVibeApiError(0, "invalid_input");
    response = await httpFetch(`${base}${PREFIX}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  } catch (error) {
    if (error instanceof StockVibeApiError) throw error;
    throw new StockVibeApiError(0, "network_error");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new StockVibeApiError(response.status, "invalid_response");
  }
  if (!response.ok) throw new StockVibeApiError(response.status, responseCode(body, response.status));
  return body as T;
}

function read<T = unknown>(path: string): Promise<StockVibeRead<T>> {
  return stockVibeRequest<StockVibeRead<T>>(path);
}

export interface StockVibeSymbolCandidate {
  symbol: string;
  name: string;
}

export function searchStockVibeSymbols(query: string): Promise<StockVibeRead<{ candidates: StockVibeSymbolCandidate[] }>> {
  return read(`/symbol-search?${new URLSearchParams({ q: query.trim() })}`);
}

function write<T = StockVibeRequestRecord>(path: string, stableRequestId: string, body?: unknown): Promise<T> {
  const stableId = requestId(stableRequestId);
  return stockVibeRequest<T>(path, {
    method: "POST",
    requestId: stableId,
    ...(body === undefined ? {} : { body }),
  });
}

export function getStockVibeStatus(): Promise<StockVibeStatus> {
  return stockVibeRequest<StockVibeStatus>("");
}

export function getStockVibeAttention(): Promise<StockVibeAttentionRead> {
  return stockVibeRequest<StockVibeAttentionRead>("/attention");
}

export function updateStockVibeAttention(
  stableRequestId: string,
  preferences: StockVibeAttentionPreferences,
): Promise<StockVibeRequestRecord> {
  return stockVibeRequest<StockVibeRequestRecord>("/attention", {
    method: "PUT",
    requestId: requestId(stableRequestId),
    body: preferences,
  });
}

export function createStockVibeRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID().replace(/-/g, "").toLowerCase();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export interface StockVibeModelOptions {
  model_preset: string | null;
  model_binding?: StockVibeModelBinding | null;
  choices: Array<{ preset: string; label: string; model: string; protocol_supported: boolean; credentials_configured: boolean }>;
}

export function getStockVibeModelOptions(): Promise<StockVibeModelOptions> {
  return stockVibeRequest<StockVibeModelOptions>("/model");
}

export function selectStockVibeModel(
  stableRequestId: string,
  modelPreset: string | null,
  binding?: StockVibeModelBinding,
): Promise<StockVibeRequestRecord> {
  const body = binding ? { model_preset: null, model_binding: binding } : { model_preset: modelPreset };
  return stockVibeRequest<StockVibeRequestRecord>("/model", { method: "PUT", requestId: requestId(stableRequestId), body });
}

export function listStockVibeSessions(limit?: number): Promise<StockVibeRead> {
  return read(`/sessions${queryString(limit)}`);
}

export function listStockVibeJournalSessions(operationId: string): Promise<StockVibeRead> {
  return read(`/sessions?${new URLSearchParams({ limit: "1", journal_operation_id: objectId(operationId) })}`);
}

export function getStockVibeSession(sessionId: string): Promise<StockVibeRead> {
  return read(`/sessions/${objectId(sessionId)}`);
}

export function getStockVibeMessages(sessionId: string): Promise<StockVibeRead> {
  return read(`/sessions/${objectId(sessionId)}/messages`);
}

export interface StockVibeAttempt {
  attempt_id: string;
  session_id: string;
  status: "pending" | "running" | "waiting_user" | "completed" | "failed" | "cancelled" | "interrupted";
  summary: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  grounding_validation?: { valid?: boolean; issues?: unknown[]; content_sha256?: string } | null;
  grounding_released?: unknown;
}

export function getStockVibeAttempt(sessionId: string, attemptId: string): Promise<StockVibeRead<StockVibeAttempt>> {
  return read<StockVibeAttempt>(`/sessions/${objectId(sessionId)}/attempts/${objectId(attemptId)}`);
}

export function createStockVibeSession(
  stableRequestId: string,
  input: StockVibeCreateSessionInput = {},
): Promise<StockVibeRequestRecord> {
  return write("/sessions", stableRequestId, input);
}

export function sendStockVibeMessage(
  sessionId: string,
  stableRequestId: string,
  input: StockVibeSendMessageInput,
): Promise<StockVibeRequestRecord> {
  return write(`/sessions/${objectId(sessionId)}/messages`, stableRequestId, input);
}

export function cancelStockVibeSession(
  sessionId: string,
  stableRequestId: string,
): Promise<StockVibeRequestRecord> {
  return write(`/sessions/${objectId(sessionId)}/cancel`, stableRequestId);
}

export function listStockVibeSwarmPresets(): Promise<StockVibeRead> {
  return read("/swarm/presets");
}

export function listStockVibeSwarmRuns(limit?: number): Promise<StockVibeRead> {
  return read(`/swarm/runs${queryString(limit)}`);
}

export function getStockVibeSwarmRun(swarmId: string): Promise<StockVibeRead> {
  return read(`/swarm/runs/${objectId(swarmId)}`);
}

export function createStockVibeSwarm(
  stableRequestId: string,
  input: StockVibeStartSwarmInput,
): Promise<StockVibeRequestRecord> {
  const userVars = input.user_vars;
  if (
    !userVars.symbol.trim()
    || !isIsoDate(userVars.start_date)
    || !isIsoDate(userVars.end_date)
    || userVars.start_date > userVars.end_date
  ) {
    throw new StockVibeApiError(0, "invalid_input");
  }
  return write("/swarm/runs", stableRequestId, {
    preset_name: input.preset_name,
    user_vars: {
      symbol: userVars.symbol,
      start_date: userVars.start_date,
      end_date: userVars.end_date,
      ...(userVars.question === undefined ? {} : { question: userVars.question }),
    },
  });
}

export function resumeStockVibeSwarm(
  swarmId: string,
  stableRequestId: string,
): Promise<StockVibeRequestRecord> {
  return write(`/swarm/runs/${objectId(swarmId)}/resume`, stableRequestId);
}

export function cancelStockVibeSwarm(
  swarmId: string,
  stableRequestId: string,
): Promise<StockVibeRequestRecord> {
  return write(`/swarm/runs/${objectId(swarmId)}/cancel`, stableRequestId);
}

export function getStockVibeRequest(stableRequestId: string): Promise<StockVibeRequestRecord> {
  const id = requestId(stableRequestId);
  return stockVibeRequest<StockVibeRequestRecord>(`/requests/${id}`);
}

export function getStockVibePortfolio(): Promise<StockVibeRead> {
  return read("/portfolio");
}

export function getStockVibePortfolioStatus(): Promise<StockVibeRead> {
  return read("/portfolio/status");
}

export interface StockVibeMarketQuery {
  symbol: string;
  start_date: string;
  end_date: string;
  interval: "1m" | "5m" | "15m" | "30m" | "1H" | "1D" | "1W" | "1M";
  source?: "tencent" | "eastmoney";
}

export function getStockVibeMarketData(query: StockVibeMarketQuery): Promise<StockVibeRead> {
  return read(`/market-data?${new URLSearchParams({ ...query })}`);
}

export type StockVibeChartInterval = StockVibeMarketQuery["interval"] | "intraday";

export interface StockVibeBar {
  trade_date: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume: number | null;
}

export interface StockVibeWorkbenchMarketData {
  status: "ok" | "unavailable";
  symbol: string;
  interval: "intraday" | "1D";
  bars: StockVibeBar[];
  quote: { price: number | null; previous_close: number | null; change: number | null;
    change_pct: number | null; name?: string; as_of?: string | null;
    open?: number | null; high?: number | null; low?: number | null;
    turnover_rate?: number | null; volume?: number | null; amount?: number | null;
    market_cap?: number | null; float_market_cap?: number | null;
    pe_ratio?: number | null; pe_label?: string };
  trading_date: string | null;
  market_open: boolean;
  market_state: "open" | "recess" | "closed" | "stale";
  source: string;
  observed_at: string;
  volume_unit: string;
  adjustment: string;
  reason?: string;
}

export interface StockVibeForecastResult {
  symbol: string;
  interval: "intraday" | "1D";
  status: "ok" | "unavailable";
  experimental: true;
  reason_code?: string;
  reason?: string;
  as_of: string | null;
  last_price: number | null;
  points: Array<{ step: number; price: number; lower: number | null; upper: number | null; label: string; trade_date?: string }>;
  horizon_unit: "trading_day" | "trading_minute";
  model_version: string;
  training_cutoff: string | null;
  training_rows: number;
  data_fingerprint: string | null;
  features: string[];
  forecast_id?: string;
  signal_state?: "available" | "abstain";
  computed_at?: string;
  generation?: { policy: "daily" | "realtime"; reused: boolean };
  estimate_kind?: "classification_weighted_return";
  issued_at?: string;
  evaluation_basis?: "adjusted_return" | "intraday_raw_return";
  selection?: { method: string; model_id: string; model_name: string; baseline_selected: boolean;
    candidate_count: number; feature_count: number;
    coverage: { registered: number; eligible: number; computed: number; excluded: number };
    basis: "nested_walk_forward" };
  validation: { method: string; mae: number | null; baseline_mae: number | null;
    model_id?: string;
    samples: number; folds: number; beat_baseline: boolean | null;
    direction_accuracy?: number | null;
    by_horizon: Array<{ step: number; mae: number; baseline_mae: number; samples: number; folds: number;
      model_name?: string; status?: string }> };
  forward_validation?: { status: "waiting" | "tracking"; forecasts: number; completed_points: number;
    mae: number | null; baseline_mae: number | null; coverage: number | null; revised_points: number;
    last_scored_at: string | null;
    by_horizon: Array<{ step: number; samples: number; mae: number | null; baseline_mae: number | null; coverage: number | null }> };
}

export interface StockVibeForecastPending {
  symbol: string;
  interval: "intraday" | "1D";
  status: "pending";
  experimental: true;
  phase: "data" | "features" | "validation" | "forecast" | "queued";
  retry_after_ms: number;
  job_id: string;
}

export type StockVibeForecast = StockVibeForecastResult | StockVibeForecastPending;

export function getStockVibeWorkbenchMarket(symbol: string, interval: "intraday" | "1D"): Promise<StockVibeRead<StockVibeWorkbenchMarketData>> {
  return read<StockVibeWorkbenchMarketData>(`/workbench-market?${new URLSearchParams({ symbol, interval })}`);
}

export function getStockVibeForecast(symbol: string, interval: "intraday" | "1D"): Promise<StockVibeRead<StockVibeForecast>> {
  return read<StockVibeForecast>(`/forecast?${new URLSearchParams({ symbol, interval })}`);
}

export function uploadStockVibeFile(stableRequestId: string, filename: string, dataBase64: string): Promise<StockVibeRequestRecord> {
  return write("/uploads", stableRequestId, { filename, data_base64: dataBase64 });
}

export function listStockVibeUploads(): Promise<StockVibeUploadList> {
  return stockVibeRequest<StockVibeUploadList>("/uploads");
}

export interface StockVibeStrategyCostOverrides {
  commission_rate?: number;
  commission_min?: number;
  stamp_tax?: number;
  transfer_fee?: number;
  slippage?: number;
}

export interface StockVibeStrategyCostScenario {
  scenario_id: string;
  overrides: StockVibeStrategyCostOverrides;
}

export interface StockVibeStrategyOOSValidationInput {
  operation: "strategy_oos_validation";
  run_id: string;
  window_start: string;
  window_end: string;
  cost_scenarios?: StockVibeStrategyCostScenario[];
}

export type StockVibeStrategyValidationOutcome = "unavailable" | "passed" | "not_passed";

export interface StockVibeStrategyValidationCheck {
  status: string;
  result: unknown;
  [key: string]: unknown;
}

export interface StockVibeStrategyCostConfig {
  commission_rate: number;
  commission_min: number;
  stamp_tax: number;
  transfer_fee: number;
  slippage: number;
}

export interface StockVibeStrategyOOSValidationResult {
  status: "ok" | "error";
  experiment_status: "completed" | "partial" | "not_applicable" | "failed";
  input_run_id: string;
  development_window: [string, string] | null;
  test_window: [string, string];
  code_sha256: string | null;
  scenarios: Array<{
    scenario_id: string;
    status: "completed" | "failed" | "not_applicable" | "not_run";
    run_id: string | null;
    code_sha256: string | null;
    effective_cost_config: StockVibeStrategyCostConfig | null;
    backtest_summary: { metrics: Record<string, unknown> | null } | null;
    validation: {
      status: "completed" | "partial" | "not_applicable" | "not_run" | "failed";
      outcome: StockVibeStrategyValidationOutcome;
      outcome_reason_code: string | null;
      checks: Record<string, StockVibeStrategyValidationCheck> | null;
      artifact_available: boolean;
    };
  }>;
  strict_factor_validation: {
    status: "not_applicable";
    executed: false;
    reason_code: "cross_sectional_factor_inputs_required";
  };
}

export interface StockVibeStrictFactorValidationInput {
  operation: "strict_factor_validation";
  zoo: "alpha101" | "qlib158";
  start_date: string;
  end_date: string;
  oos_cutoff: string;
  n_random_seeds?: number;
  horizon?: number;
  top?: number;
}

export interface StockVibeStrictFactorValidationResult {
  status: "ok" | "error";
  experiment_status: "completed" | "unavailable" | "failed";
  reason_code?:
    | "tushare_token_unconfigured"
    | "csi300_constituents_degraded"
    | "csi300_data_unavailable"
    | "strict_factor_oos_unavailable"
    | "strict_factor_no_testable_rows"
    | "strict_factor_execution_failed"
    | null;
  no_network_attempt: boolean;
  inputs: {
    zoo: "alpha101" | "qlib158";
    universe: "csi300";
    start_date: string;
    end_date: string;
    oos_cutoff: string;
    period: string;
    random_control: true;
    n_random_seeds: number;
    horizon: number;
    top: number;
  };
  native_result: Record<string, unknown> | null;
}

export type StockVibeOperationInput =
  | { operation: "backtest"; run_id: string }
  | { operation: "extract_shadow_strategy"; upload_id: string; min_support?: number; max_rules?: number }
  | { operation: "analyze_trade_journal"; upload_id: string }
  | { operation: "run_shadow_backtest"; shadow_id: string; window_start?: string; window_end?: string; upload_id?: string; source?: string; markets?: Array<"china_a">; per_market_count?: number }
  | { operation: "render_shadow_report"; shadow_id: string; include_today_signals?: false; window_start: string; window_end: string; upload_id?: string; source: string; markets: Array<"china_a">; per_market_count: number }
  | { operation: "scan_shadow_signals"; shadow_id: string; date?: string; per_market?: number; source?: string }
  | StockVibeStrategyOOSValidationInput
  | StockVibeStrictFactorValidationInput;

export function startStockVibeOperation(stableRequestId: string, input: StockVibeOperationInput): Promise<StockVibeRequestRecord> {
  return write("/operations", stableRequestId, input);
}

export function listStockVibeOperations(): Promise<StockVibeRead> {
  return read("/operations");
}

export function getStockVibeOperation(operationId: string): Promise<StockVibeRead> {
  return read(`/operations/${objectId(operationId)}`);
}

export function listStockVibeShadowProfiles(): Promise<StockVibeRead> {
  return read("/shadow-profiles");
}

export function getStockVibeShadowProfile(shadowId: string): Promise<StockVibeRead> {
  return read(`/shadow-profiles/${objectId(shadowId)}`);
}

export function listStockVibeScenarios(): Promise<StockVibeRead<StockVibeScenarioList>> {
  return read<StockVibeScenarioList>("/scenarios");
}

export function getStockVibeScenario(artifactId: string): Promise<StockVibeRead<StockVibeScenarioArtifact>> {
  return read<StockVibeScenarioArtifact>(`/scenarios/${objectId(artifactId)}`);
}

export type StockVibeArtifactKind = "shadow-pdf" | "shadow-html" | "report-pdf";

export async function downloadStockVibeArtifact(kind: StockVibeArtifactKind, id: string): Promise<Blob> {
  return download(`/artifacts/${kind}/${objectId(id)}`);
}

export function listStockVibeSwarmArtifacts(runId: string): Promise<StockVibeRead> {
  return read(`/swarm/runs/${objectId(runId)}/artifacts`);
}

export function downloadStockVibeSwarmArtifact(runId: string, artifactId: string): Promise<Blob> {
  return download(`/swarm/runs/${objectId(runId)}/artifacts/${objectId(artifactId)}`);
}

async function download(path: string): Promise<Blob> {
  const base = await servicesBase();
  let response: Response;
  try {
    response = await httpFetch(`${base}${PREFIX}${path}`);
  } catch {
    throw new StockVibeApiError(0, "network_error");
  }
  if (!response.ok) throw new StockVibeApiError(response.status, responseCode(null, response.status));
  return response.blob();
}

export function refreshStockVibePortfolio(stableRequestId: string): Promise<StockVibeRequestRecord> {
  return write("/portfolio/refresh", stableRequestId);
}

export async function getStockVibeEventStreamUrl(
  stableRequestId: string,
  target: StockVibeEventTarget,
): Promise<string> {
  const ticket = await write<{ url: string; expires_in_seconds: number }>(
    "/events/ticket",
    stableRequestId,
    target,
  );
  const base = await servicesBase();
  try {
    return new URL(ticket.url, `${base}/`).toString();
  } catch {
    throw new StockVibeApiError(0, "invalid_response");
  }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
