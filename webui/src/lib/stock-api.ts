/** Stock module API client (design §10).
 *
 * Two route families:
 * - Data capability on the services port (watchlist CRUD/import, instrument
 *   search, batch quotes, kline with indicators) via ``getServicesHttpBase()``.
 * - Workspace-scoped report queries on the WebSocket port (list / detail /
 *   dashboard) via ``getApiBase()`` with the API bearer token.
 *
 * Workflow runs are started over the room protocol — see
 * ``MonaClient.runWorkflow(chatId, inputs)`` with ``STOCK_ROOM_CHAT_ID``.
 */

import { getApiBase, getServicesHttpBase, resetServicesHttpBase } from "./api";
import { httpFetch } from "./tauri";

/** Raw room protocol id; the gateway adds the websocket session prefix. */
export const STOCK_ROOM_CHAT_ID = "stock_research";

export type StockInstrumentType = "equity" | "etf" | "index";

export type StockStance =
  | "positive"
  | "neutral"
  | "negative"
  | "insufficient_data";
export type StockTimeHorizon = "short_term" | "swing" | "medium_term";
export type StockEvidenceStrength = "low" | "medium" | "high";

export type StockReportKind = "deep_research" | "daily_review";

/** Opportunity-discovery contracts. The service owns parsing and screening;
 * the UI only renders the structured result and starts the workflow. */
export type StockScreenStrategySource = "builtin" | "user" | "agent";
export type StockScreenHorizon =
  | "short_term"
  | "swing"
  | "medium_term"
  | "long_term";

export const STOCK_SELECTION_ORIGIN_USAGE_NOTE =
  "这是选股阶段的先验线索，不是深度投研事实；必须使用本次投研证据重新核验。";

/** Immutable context carried from deterministic selection into deep research. */
export interface StockSelectionOrigin {
  schema_version: 1;
  selection_run_id: string;
  selection_report_id: string;
  opportunity_report_id: string | null;
  instrument_id: string;
  strategy_id: string;
  strategy_name: string;
  strategy_horizon: StockScreenHorizon | string;
  deterministic_rank: number;
  selection_reasons: string[];
  why_now: string | null;
  research_priority: "high" | "medium" | "low" | null;
  focus_questions: string[];
  source_count: number;
  selection_as_of: string | null;
  usage_note: typeof STOCK_SELECTION_ORIGIN_USAGE_NOTE;
}

export interface StockScreenCondition {
  field: string;
  op: string;
  value: string | number | boolean | null;
  label?: string;
}

export interface StockScreenStrategy {
  schema_version?: number;
  strategy_id: string;
  name: string;
  description?: string;
  source: StockScreenStrategySource;
  horizon?: StockScreenHorizon;
  universe?: Record<string, unknown>;
  filters?: StockScreenCondition[];
  ranking?: Array<{ field: string; direction: "asc" | "desc"; weight: number; label?: string }>;
  /** Built-in directions combined as a union before unified ranking. */
  included_strategy_ids?: string[];
  limit?: number;
  /** Number of deterministic candidates passed to the AI opportunity step. */
  research_limit?: number;
  created_at?: string;
  updated_at?: string;
  schedule?: {
    mode: "manual" | "daily_after_close" | "weekly";
    enabled?: boolean;
    time?: string;
    weekday?: number | null;
    timezone?: string;
  };
  schedule_sync?: {
    status?: "registered" | "disabled" | "unavailable" | string;
    code?: string | null;
    job_id?: string | null;
  };
}

export interface StockScreenTemplate extends StockScreenStrategy {
  template_id?: string;
  beginner_label?: string;
  beginner_description?: string;
  typical_horizon?: string;
  availability?: "available" | "unavailable" | string;
  unavailable_reason?: string;
}

export type StockScreenDataQualityStatus = "complete" | "available" | "partial" | "stale" | "unavailable" | string;
export interface StockScreenDataQuality {
  status?: StockScreenDataQualityStatus;
  reason?: string;
  factor_algorithm_version?: string;
  missing?: string[];
  [key: string]: unknown;
}

/** A deterministic, source-traceable event attached to a screening candidate. */
export interface StockCatalystEvent {
  event_id?: string;
  instrument_id?: string;
  event_type?: string;
  title?: string;
  summary?: string | null;
  url?: string | null;
  published_at?: string | null;
  event_date?: string | null;
  status?: string;
  source_id?: string | null;
  source_ids?: string[];
  source?: {
    id?: string;
    url?: string | null;
    provider?: string;
    published_at?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/** Coverage metadata for the recent-catalyst event capture. */
export interface StockCatalystCapture {
  window_start?: string | null;
  window_end?: string | null;
  expected_count?: number | null;
  loaded_count?: number | null;
  complete?: boolean;
  cache_status?: "live" | "fresh_cache" | "stale_cache" | "unavailable" | string;
  status?: "complete" | "partial" | "stale" | "unavailable" | string;
  fetched_at?: string | null;
  error?: string | null;
  reason?: string | null;
  [key: string]: unknown;
}
export type StockScreenChangeState = "new" | "continued" | "reentered" | "exited" | string;

export interface StockValuationMetric {
  value?: number | null;
  peer_count: number;
  median?: number | null;
  percentile?: number | null;
}

export interface StockValuationContext {
  status: "complete" | "partial" | "unavailable" | string;
  as_of?: string | null;
  comparison_scope?: string;
  basis?: string;
  current_pe?: number | null;
  current_pb?: number | null;
  pe?: StockValuationMetric;
  pb?: StockValuationMetric;
  missing_fields?: string[];
}

export interface StockScreenCandidate {
  instrument_id: string;
  symbol?: string;
  exchange?: string;
  name: string;
  industry?: string | null;
  snapshot?: Record<string, unknown>;
  price?: number | null;
  change_pct?: number | null;
  rank?: number;
  score?: number | null;
  score_contributions?: Record<string, number>;
  matched_conditions?: StockScreenCondition[];
  unmatched_conditions?: StockScreenCondition[];
  selection_reasons: string[];
  risk_flags: string[];
  data_quality: StockScreenDataQualityStatus;
  missing_fields?: string[];
  as_of?: string | null;
  source_ids?: string[];
  catalyst_events?: StockCatalystEvent[];
  change_state?: StockScreenChangeState;
  valuation_context?: StockValuationContext | null;
  [key: string]: unknown;
}

export type StockOpportunityClaimType = "fact" | "inference" | "unknown" | string;

/** A traceable statement in the AI opportunity report. */
export interface StockOpportunityClaim {
  text: string;
  claim_type?: StockOpportunityClaimType;
  source_ids?: string[];
  [key: string]: unknown;
}

export type StockOpportunityHorizon = "short_term" | "medium_term" | "long_term";

export interface StockOpportunityHorizonView {
  status: "available" | "insufficient_data" | string;
  summary?: StockOpportunityClaim | string | null;
  supporting_evidence?: StockOpportunityClaim[];
  counter_evidence?: StockOpportunityClaim[];
  watch_items?: StockOpportunityClaim[];
  invalidation_conditions?: StockOpportunityClaim[];
  data_gaps?: StockOpportunityClaim[] | string[];
  [key: string]: unknown;
}

export type StockOpportunityHorizonViews = Partial<Record<StockOpportunityHorizon, StockOpportunityHorizonView>>;

export type StockOpportunityPricedIn =
  | "not_priced_in"
  | "partially_priced_in"
  | "fully_priced_in"
  | "unknown"
  | string;

/** Traceable path from a catalyst event to the candidate's earnings. */
export interface StockOpportunityEventTransmission {
  status: "available" | "insufficient_data" | string;
  event?: StockOpportunityClaim | string | null;
  direct_impact?: StockOpportunityClaim | string | null;
  industry_chain?: StockOpportunityClaim[];
  business_exposure?: StockOpportunityClaim | string | null;
  earnings_path?: StockOpportunityClaim | string | null;
  validation_window?: StockOpportunityClaim | string | null;
  priced_in: StockOpportunityPricedIn;
  priced_in_basis?: StockOpportunityClaim | string | null;
  counter_evidence?: StockOpportunityClaim[];
  invalidation_conditions?: StockOpportunityClaim[];
  data_gaps?: StockOpportunityClaim[] | string[];
  [key: string]: unknown;
}

export interface StockOpportunityCandidate {
  instrument_id: string;
  deterministic_rank?: number;
  research_priority?: "high" | "medium" | "low" | string;
  why_now?: StockOpportunityClaim | string | null;
  thesis?: StockOpportunityClaim[];
  supporting_evidence?: StockOpportunityClaim[];
  counter_evidence?: StockOpportunityClaim[];
  relative_edge?: StockOpportunityClaim[];
  watch_items?: StockOpportunityClaim[];
  invalidation_conditions?: StockOpportunityClaim[];
  data_gaps?: StockOpportunityClaim[] | string[];
  horizon_views?: StockOpportunityHorizonViews | null;
  event_transmission?: StockOpportunityEventTransmission | null;
  context_id?: string | null;
  source_ids?: string[];
  [key: string]: unknown;
}

export type StockOpportunityResearchStatus =
  | "not_started"
  | "running"
  | "completed"
  | "partial"
  | "unavailable"
  | "failed"
  | string;

export interface StockOpportunityResearch {
  schema_version?: number;
  kind?: "stock_opportunity_research" | string;
  report_id?: string;
  workflow_run_id?: string;
  selection_report_id?: string;
  as_of?: string | null;
  status?: StockOpportunityResearchStatus;
  candidate_count?: number;
  candidates?: StockOpportunityCandidate[];
  comparison_summary?: StockOpportunityClaim[];
  data_quality?: StockScreenDataQuality;
  source_ids?: string[];
  missing_sections?: string[];
  [key: string]: unknown;
}

/** One source record cited by an AI opportunity claim. */
export interface StockOpportunitySource {
  id: string;
  provider: string;
  url: string;
  published_at: string | null;
  fetched_at: string;
  content_hash: string;
  fields?: string[];
  [key: string]: unknown;
}

export interface StockScreenFilterStatistic {
  field?: string;
  label?: string;
  before?: number;
  after?: number;
  removed?: number;
}

export interface StockScreenValidation {
  status?: "available" | "unavailable" | "pending" | string;
  reason?: string;
  sample_count?: number;
  t5?: number | null;
  t20?: number | null;
  t60?: number | null;
  benchmark?: number | null;
  max_drawdown?: number | null;
  turnover?: number | null;
  failure_samples?: string[];
}

export interface StockScreenReport {
  schema_version?: number;
  kind?: "stock_selection" | "stock_opportunity_research" | string;
  report_id: string;
  workflow_run_id: string;
  strategy: StockScreenStrategy;
  as_of?: string | null;
  universe_count?: number;
  filtered_count?: number;
  candidates: StockScreenCandidate[];
  filter_statistics?: StockScreenFilterStatistic[];
  validation?: StockScreenValidation;
  data_quality?: StockScreenDataQuality;
  missing_fields?: string[];
  source_ids?: string[];
  error?: { code?: string; message?: string } | null;
  catalyst_capture?: StockCatalystCapture | null;
  event_capture?: StockCatalystCapture | null;
  stale?: boolean;
  /** Nullable second-layer AI research. Old selection-only reports omit it. */
  opportunity_research?: StockOpportunityResearch | null;
  research_status?: StockOpportunityResearchStatus;
  has_opportunity_research?: boolean;
}

export interface StockScreenHistoryItem {
  run_id: string;
  workflow_run_id?: string;
  report_id?: string | null;
  strategy_id?: string;
  strategy_name?: string;
  status: string;
  as_of?: string | null;
  candidate_count?: number;
  data_quality?: StockScreenDataQuality | StockScreenDataQualityStatus;
  created_at?: string;
  research_status?: StockOpportunityResearchStatus;
  has_opportunity_research?: boolean;
}

export interface StockScreenCompareResult {
  candidates?: StockScreenCandidate[];
  items?: StockScreenCandidate[];
  /** Normalized snake_case field; dataQuality remains for legacy callers. */
  data_quality?: StockScreenDataQuality;
  dataQuality?: StockScreenDataQuality;
  dimensions?: Array<{ key: string; label: string; values: Record<string, string | number | null> }>;
  note?: string;
}

export interface StockWatchlistItem {
  instrumentId: string;
  symbol: string;
  exchange: string;
  name: string;
  instrumentType: StockInstrumentType;
  focus: boolean;
  addedAt?: string;
}

export interface StockWatchlistAddInput {
  symbol: string;
  exchange: string;
  name: string;
  instrumentType: StockInstrumentType;
  focus?: boolean;
}

export interface StockWatchlistImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  items: StockWatchlistItem[];
}

export interface StockSearchResult {
  instrumentId: string;
  symbol: string;
  exchange: string;
  name: string;
  instrumentType: StockInstrumentType;
}

export interface StockQuoteError {
  code: string;
  message: string;
}

export interface StockQuote {
  instrumentId: string;
  instrumentType?: string;
  name?: string;
  price?: number;
  changePct?: number;
  volume?: number;
  pe?: number | null;
  pb?: number | null;
  marketCap?: number | null;
  asOf?: string | null;
  error?: StockQuoteError;
}

export interface StockKlineBar {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface StockKlineIndicators {
  ma: {
    ma5: (number | null)[];
    ma20: (number | null)[];
    ma60: (number | null)[];
  };
  macd?: {
    dif: (number | null)[];
    dea: (number | null)[];
    hist: (number | null)[];
  };
  rsi14?: (number | null)[];
  swing?: {
    support: number | null;
    resistance: number | null;
    method: string;
    window: number;
  };
  volumeChangePct?: number | null;
}

export interface StockSourceRef {
  provider: string;
  fetchedAt: string;
}

export interface StockKlineResponse {
  instrumentId: string;
  instrumentType: string;
  bars: StockKlineBar[];
  indicators: StockKlineIndicators;
  source: StockSourceRef;
}

export type StockIntradayStatus =
  | "preopen"
  | "trading"
  | "lunch_break"
  | "closed"
  | "suspended"
  | "unavailable";
export type StockIntradayQuality =
  | "complete"
  | "degraded"
  | "stale"
  | "unavailable";

export interface StockIntradayPoint {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  price: number;
  average: number;
  /** 分钟成交量，单位：手。 */
  volume: number;
  /** 分钟成交额，单位：元。 */
  amount: number;
}

export interface StockIntradaySource extends StockSourceRef {
  id: string;
  url: string;
  publishedAt: string | null;
  contentHash: string;
  fields: string[];
}

export interface StockIntradaySeries {
  instrumentId: string;
  instrumentType: string;
  tradingDate: string;
  previousClose: number;
  status: StockIntradayStatus;
  asOf: string | null;
  source: StockIntradaySource;
  points: StockIntradayPoint[];
  stale: boolean;
  quality: StockIntradayQuality;
  error: string | null;
}

export interface StockIntradayStatusEvent {
  instrumentId: string;
  status: StockIntradayStatus;
  stale?: boolean;
  quality?: StockIntradayQuality;
  error?: string | null;
}

export interface StockIntradayStreamHandlers {
  onSnapshot?: (series: StockIntradaySeries) => void;
  onPoint?: (point: StockIntradayPoint | StockIntradaySeries) => void;
  onStatus?: (status: StockIntradayStatusEvent) => void;
  onError?: (event: Event) => void;
}

/** Small EventSource surface so tests can inject a deterministic fake. */
export interface StockIntradayEventSource {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener?: (type: string, listener: (event: Event) => void) => void;
  close(): void;
}

export type StockIntradayEventSourceFactory = (
  url: string,
) => StockIntradayEventSource;

export interface StockIntradayStream {
  source: StockIntradayEventSource;
  close: () => void;
}

export type StockResearchSectionStatus = "available" | "unavailable" | "not_applicable";

export interface StockResearchSource extends StockSourceRef {
  id: string;
  url: string;
  publishedAt: string | null;
  contentHash: string;
  fields: string[];
}

export interface StockFundamentals {
  instrumentId: string;
  instrumentType: StockInstrumentType;
  reportPeriod: string | null;
  metrics: Record<string, number | null>;
  source: StockResearchSource;
}

export interface StockNewsItem {
  instrumentId: string;
  instrumentType: StockInstrumentType;
  title: string;
  url: string;
  publishedAt: string | null;
  summary: string;
  source: StockResearchSource;
}

export interface StockResearchContext {
  instrumentId: string;
  instrumentType: StockInstrumentType;
  fundamentals: {
    status: StockResearchSectionStatus;
    data: StockFundamentals | null;
    error: StockQuoteError | null;
  };
  news: {
    status: Exclude<StockResearchSectionStatus, "not_applicable">;
    items: StockNewsItem[];
    error: StockQuoteError | null;
  };
}

export interface StockReportInstrument {
  instrumentId: string;
  symbol: string;
  exchange: string;
  name: string;
  instrumentType: StockInstrumentType;
}

/** Immutable data-quality snapshot shown before a six-agent run starts. */
export interface StockResearchPreflight {
  contextId: string;
  instrument: {
    symbol: string;
    exchange: string;
    instrument_type?: StockInstrumentType;
    name?: string;
  };
  researchCutoffAt: string | null;
  marketAsOf: string | null;
  evidenceCoverage: StockEvidenceCoverage;
  dataQuality: Record<string, unknown>;
}

/** User-controlled PDF evidence records shown during research preflight. */
export interface StockMaterialBinding {
  binding_id: string;
  material_id?: string | null;
  instrument_id?: string | null;
  report_type?: string | null;
  report_period: string | null;
  first_published_at?: string | null;
  publisher?: string | null;
  pages: number[];
  confirmed_facts: StockConfirmedFinancialFact[];
  user_confirmed?: boolean;
  confirmed_at: string | null;
  status: string;
  status_code?: string | null;
  invalidation_reason: string | null;
}

/** A manually transcribed value that the user checked against one selected PDF page. */
export interface StockConfirmedFinancialFact {
  metric_name: string;
  value_text: string;
  unit: string;
  page: number;
  excerpt: string;
}

export interface StockConfirmedFinancialFactInput {
  metric: string;
  value_text: string;
  unit: string;
  page: number;
  excerpt: string;
}

export interface StockMaterialItem {
  material_id: string;
  material_name: string;
  extraction_status: string;
  extraction_status_code?: string | null;
  page_count: number;
  bindings: StockMaterialBinding[];
}

export interface StockMaterialsResponse {
  instrument_id: string;
  materials: StockMaterialItem[];
}

export interface StockMaterialBindingInput {
  instrument_id: string;
  material_id: string;
  report_period: string;
  first_published_at: string;
  publisher: string;
  pages: number[];
}

export interface StockMaterialPagePreview {
  material_name: string | null;
  page: number;
  page_count: number | null;
  text: string;
}

export type StockHorizonStatus = "available" | "insufficient_data";
export type StockEvidenceCoverageStatus =
  | "available"
  | "degraded"
  | "missing"
  | "insufficient_data";
export type StockDataStatus = "available" | "degraded" | "missing";
export type StockClaimType = "fact" | "inference" | "hypothesis";
export type StockConditionKind = "manual" | "trigger";
export type StockConditionOperator =
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "crosses_above"
  | "crosses_below";
export type StockConflictStatus = "aligned" | "mixed" | "insufficient_data";

export interface StockHorizonStance {
  stance: StockStance;
  status: StockHorizonStatus;
}

export interface StockHorizonStances {
  shortTerm: StockHorizonStance;
  mediumTerm: StockHorizonStance;
  longTerm: StockHorizonStance;
}

export interface StockEvidenceCoverageSection {
  status: StockEvidenceCoverageStatus;
  missing_fields?: string[];
  source_ids?: string[];
  [key: string]: unknown;
}

export interface StockEvidenceCoverageHorizon {
  status: StockEvidenceCoverageStatus;
  required_sections?: string[];
  missing_sections?: string[];
  degraded_sections?: string[];
  missing_fields?: string[];
  [key: string]: unknown;
}

/** Evidence coverage is server-authored; the client only renders it. */
export interface StockEvidenceCoverage {
  schema_version?: string;
  sections?: Record<string, StockEvidenceCoverageSection>;
  short_term?: StockEvidenceCoverageHorizon;
  medium_term?: StockEvidenceCoverageHorizon;
  long_term?: StockEvidenceCoverageHorizon;
  [key: string]: unknown;
}

interface StockLegacyReportProjection {
  schemaVersion?: never;
  horizonStances?: never;
  researchCutoffAt?: never;
  marketAsOf?: never;
  evidenceCoverage?: never;
  stance: StockStance | null;
  dataQuality: string | null;
}

interface StockV4ReportProjection {
  schemaVersion: 4;
  horizonStances: StockHorizonStances;
  researchCutoffAt: string | null;
  marketAsOf: string | null;
  evidenceCoverage: StockEvidenceCoverage;
  /** V4 deliberately has no composite stance or quality. */
  stance: null;
  dataQuality: null;
}

export type StockReportProjection =
  | StockLegacyReportProjection
  | StockV4ReportProjection;

interface StockReportListFields {
  reportId: string;
  runId: string;
  kind: StockReportKind;
  instrument: StockReportInstrument | null;
  symbols: string[];
  asOf: string | null;
  modifiedAt: string;
}

export type StockReportListItem = StockReportListFields & StockReportProjection;

export type StockDashboardLatest = Omit<StockReportListFields, "instrument" | "symbols" | "modifiedAt"> & StockReportProjection;

/** Raw report instrument in persisted snake_case documents. */
export interface StockRawReportInstrument {
  symbol: string;
  exchange: string;
  name?: string;
  instrument_type?: StockInstrumentType;
}

export interface StockRawReportSource {
  id: string;
  provider: string;
  url: string;
  published_at: string | null;
  period_end: string | null;
  fetched_at: string;
  content_hash: string;
  fields: string[];
  material_id?: string | null;
  material_name?: string | null;
  page?: number | null;
  location_label?: string | null;
  source_role?: string | null;
}

export interface StockViewPoint {
  claim: string;
  evidence?: string;
  claim_type: StockClaimType;
  basis?: string | null;
  source_ids: string[];
}

export interface StockHorizonCondition {
  kind: StockConditionKind;
  text: string;
  observed_metric_ref?: string | null;
  operator?: StockConditionOperator | null;
  threshold_metric_ref?: string | null;
  /** @deprecated V4 conditions must use threshold_metric_ref. Kept only so old documents remain readable. */
  threshold?: number | null;
  source_ids: string[];
}

export interface StockBenchmark {
  name: string;
  instrument_id?: string | null;
  relative_view: "outperform" | "inline" | "underperform" | "unknown";
  basis?: string | null;
  source_ids?: string[];
}

export interface StockHorizonView {
  stance: StockStance;
  status: StockHorizonStatus;
  /** Evidence dimensions consumed when forming this horizon judgment. */
  dimension_keys: StockDimensionKey[];
  thesis: string;
  drivers: StockViewPoint[];
  priced_in: "not_priced_in" | "partially_priced_in" | "fully_priced_in" | "unknown";
  benchmark: StockBenchmark;
  action:
    | "observe"
    | "wait_for_confirmation"
    | "conditional_participation"
    | "reduce_exposure"
    | "not_applicable";
  priced_in_basis?: StockViewPoint | null;
  participation_conditions: StockHorizonCondition[];
  confirmation_conditions: StockHorizonCondition[];
  watch_conditions: StockHorizonCondition[];
  invalidation_conditions: StockHorizonCondition[];
  time_stop: string;
  tradeability_risks: StockViewPoint[];
  blind_spots: StockViewPoint[];
  evidence_strength: StockEvidenceStrength;
  data_status: "complete" | "degraded";
  missing_fields: string[];
  source_ids: string[];
}

export interface StockHorizonViews {
  short_term: StockHorizonView;
  medium_term: StockHorizonView;
  long_term: StockHorizonView;
}

export interface StockCycleState {
  status: StockDataStatus;
  stage: string;
  leading_indicators: StockViewPoint[];
  confirmation_indicators: StockViewPoint[];
  turning_conditions: StockHorizonCondition[];
  observation_window: string;
  evidence_strength: StockEvidenceStrength;
  missing_fields: string[];
  source_ids: string[];
}

export interface StockCycleStates {
  policy: StockCycleState;
  industry: StockCycleState;
  earnings: StockCycleState;
  valuation: StockCycleState;
}

export interface StockMarketBreadthProjection {
  status?: StockDataStatus | null;
  member_count?: number | null;
  available_change_count?: number | null;
  advancing?: number | null;
  declining?: number | null;
  unchanged?: number | null;
  suspended?: number | null;
  advance_ratio?: number | null;
  turnover_amount?: number | null;
  observed_at?: string | null;
  basis?: string | null;
  method?: string | null;
  coverage?: {
    complete?: boolean | null;
    loaded_count?: number | null;
    expected_count?: number | null;
    coverage?: number | null;
  } | null;
  missing_fields?: string[];
}

export interface StockPublicDisclosureSignal {
  event_type?: string | null;
  title?: string | null;
  published_at?: string | null;
  event_date?: string | null;
  status?: string | null;
  url?: string | null;
  source_ids?: string[];
}

export interface StockPublicActivityProjection {
  status?: StockDataStatus | null;
  turnover?: number | null;
  turnover_rate?: number | null;
  volume?: number | null;
  price_change_pct?: number | null;
  volume_change_pct_5d?: number | null;
  observed_at?: string | null;
  basis?: string | null;
  method?: string | null;
  disclosure_signals?: StockPublicDisclosureSignal[];
  missing_fields?: string[];
}

export interface StockSummarySection {
  status: StockDataStatus;
  summary: string;
  points: StockViewPoint[];
  missing_fields: string[];
  source_ids: string[];
  /** Trusted valuation projection materialized from Evidence. */
  valuation_metrics?: StockValuationMetrics | null;
  research_cutoff_at?: string | null;
  market_as_of?: string | null;
  published_at?: string | null;
  period_end?: string | null;
  /** Trusted Evidence projections for the market and capital dimensions. */
  market_breadth?: StockMarketBreadthProjection | null;
  public_activity?: StockPublicActivityProjection | null;
}

export interface StockValuationMetrics {
  current_pe?: number | null;
  current_pb?: number | null;
  pe_peer_count?: number | null;
  pb_peer_count?: number | null;
  pe_median?: number | null;
  pb_median?: number | null;
  pe_percentile?: number | null;
  pb_percentile?: number | null;
  comparison_method?: string | null;
  comparison_basis?: string | null;
  comparison_as_of?: string | null;
  peer_comparison_status?: "complete" | "insufficient_data" | string | null;
  missing_reasons?: string[];
}

/** Evidence-backed calendar item. Missing event_date is deliberately retained
 * as missing: the UI must not turn an undated announcement into a future event. */
export interface StockEventCalendarItem {
  event_type?: string | null;
  instrument_id?: string | null;
  published_at?: string | null;
  event_date?: string | null;
  status?: string | null;
  title?: string | null;
  summary?: string | null;
  url?: string | null;
  source_ids?: string[];
}

/** Optional trusted Evidence projection on a V4 report. */
export interface StockEventCalendar {
  status?: StockDataStatus;
  claim_type?: StockClaimType;
  events?: StockEventCalendarItem[];
  latest_published_at?: string | null;
  source_ids?: string[];
  missing_fields?: string[];
}

/** The eight evidence dimensions shown by the V4 research decision surface.
 * Optional on the document type only so persisted V3/early-V4 reports remain
 * readable; newly generated V4 reports are expected to fill every key. */
export type StockDimensionKey =
  | "market_environment"
  | "industry"
  | "policy"
  | "cycle"
  | "company_quality"
  | "valuation"
  | "capital_positioning"
  | "event_risk";

export type StockDimensionViews = Record<StockDimensionKey, StockSummarySection>;

export interface StockScenario {
  summary: string;
  conditions: StockHorizonCondition[];
  outcome_direction: string;
  risks: StockViewPoint[];
  source_ids: string[];
}

export interface StockScenarioSet {
  optimistic: StockScenario;
  base: StockScenario;
  pessimistic: StockScenario;
}

export interface StockScenarioSets {
  short_term: StockScenarioSet;
  medium_term: StockScenarioSet;
  long_term: StockScenarioSet;
}

export interface StockCrossHorizonConflict {
  status: StockConflictStatus;
  explanation: string;
  source_ids: string[];
}

/** Chairman's compact ruling for one independent horizon. The UI renders the
 * structured ruling; upstream bull/bear artifacts remain trace-only. */
export interface StockDebateResolution {
  status: StockDataStatus;
  issue: string;
  bull_case: StockViewPoint[];
  bear_case: StockViewPoint[];
  verdict: StockViewPoint[];
  change_conditions: StockHorizonCondition[];
  missing_fields: string[];
  source_ids: string[];
}

export interface StockDebateResolutions {
  short_term: StockDebateResolution;
  medium_term: StockDebateResolution;
  long_term: StockDebateResolution;
}

export interface StockLegacyDecisionConditions {
  confirmation?: string[];
  watch?: string[];
  invalidation?: string[];
}

interface StockLegacyReportFields {
  report_id?: string;
  kind?: StockReportKind;
  research_stance?: StockStance | null;
  data_quality?: string | null;
  as_of?: string | null;
  summary?: string;
  missing_fields?: string[];
  source_ids?: string[];
  market_snapshot?: {
    price: number;
    change_pct: number;
  } | null;
  technical_levels?: {
    support: number | null;
    resistance: number | null;
    method: string;
  } | null;
  risks?: string[];
  catalysts?: string[];
  open_questions?: string[];
  time_horizon?: StockTimeHorizon | null;
  evidence_strength?: StockEvidenceStrength | null;
  decision_conditions?: StockLegacyDecisionConditions | null;
  bull_case_summary?: string | null;
  bear_case_summary?: string | null;
  /** Daily-review digest rows (design §5.3). */
  items?: StockDigestItem[];
}

/** V3 historical deep-research document (snake_case, read-only compatibility). */
export type StockReportV3Document = StockLegacyReportFields & {
  schema_version?: 1 | 2 | 3;
  kind?: "deep_research";
  instrument?: StockRawReportInstrument;
  items?: never;
  [key: string]: unknown;
};

/** Daily-review digest document (schema v3, read-only compatibility). */
export type StockDigestDocument = StockLegacyReportFields & {
  schema_version?: 1 | 2 | 3;
  kind: "daily_review";
  items: StockDigestItem[];
  [key: string]: unknown;
};

/** V4 deep-research document. It has independent horizon views and no
 * composite research_stance/time_horizon fields. */
export interface StockReportV4Document {
  schema_version: 4;
  report_id: string;
  kind: "deep_research";
  workflow_run_id: string;
  instrument: StockRawReportInstrument;
  as_of: string | null;
  research_cutoff_at: string | null;
  market_as_of: string | null;
  summary: string;
  /** Eight independently traceable analysis dimensions. */
  dimension_views?: StockDimensionViews;
  /** Optional Evidence event calendar; absent on old V4 documents. */
  event_calendar?: StockEventCalendar | null;
  horizon_views: StockHorizonViews;
  cycle_states: StockCycleStates;
  market_regime_summary: StockSummarySection;
  industry_policy_summary: StockSummarySection;
  scenario_sets: StockScenarioSets;
  cross_horizon_conflict: StockCrossHorizonConflict;
  evidence_coverage: StockEvidenceCoverage;
  outcome_tracking_id: string;
  analyst_views: Record<string, string>;
  debate: Record<string, string>;
  /** V4 structured multi/bear ruling; absent only on early V4 documents. */
  debate_resolution?: StockDebateResolutions | null;
  /** V4 structured claims live in horizon/cycle/summary/scenario sections. */
  risks: StockViewPoint[];
  catalysts: StockViewPoint[];
  open_questions: StockViewPoint[];
  source_ids: string[];
  sources: StockRawReportSource[];
  selection_origin?: StockSelectionOrigin | null;
  versions: Record<string, string>;
  disclaimer: string;
  market_snapshot?: never;
  technical_levels?: never;
  missing_fields?: never;
  research_stance?: never;
  data_quality?: never;
  time_horizon?: never;
  evidence_strength?: never;
  decision_conditions?: never;
  bull_case_summary?: never;
  bear_case_summary?: never;
  items?: never;
}

/** Raw report/digest response, preserving V3/V4/digest shapes. */
export type StockReportDocument =
  | StockReportV3Document
  | StockReportV4Document
  | StockDigestDocument;

/** Type guard shared by structured V4 surfaces without converting V3 strings. */
export function isStockViewPoint(value: unknown): value is StockViewPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<StockViewPoint>;
  return (
    typeof point.claim === "string" &&
    (point.claim_type === "fact" ||
      point.claim_type === "inference" ||
      point.claim_type === "hypothesis") &&
    Array.isArray(point.source_ids)
  );
}

/** Render one legacy string or one V4 claim without changing its shape. */
export function stockClaimText(
  value: string | StockViewPoint | null | undefined,
): string {
  return typeof value === "string" ? value : value?.claim ?? "";
}

/** One watchlist row inside a daily-review digest (snake_case JSON). */
export interface StockDigestItem {
  instrument: {
    symbol: string;
    exchange: string;
    name?: string;
    instrument_type?: string;
  };
  stance: StockStance;
  one_liner: string;
  data_quality: string;
  missing?: string[];
}

export interface StockReportDetail {
  report: StockReportDocument;
  markdown: string;
}

export type StockOutcomeHorizon = "short_term" | "medium_term" | "long_term";
export type StockOutcomeWindow = 5 | 10 | 20 | 60 | 120 | 250;

export interface StockOutcomeBenchmark {
  name: string;
  instrument_id: string;
  instrument_type: string;
}

export interface StockOutcomeConditionReplay {
  horizon: StockOutcomeHorizon;
  condition: Record<string, unknown>;
  status: "manual" | "unsupported" | "triggered" | "not_triggered" | string;
  reason?: string | null;
  date?: string | null;
  value?: number | null;
}

export interface StockOutcomeObservation {
  tracking_id: string;
  report_id: string;
  horizon: StockOutcomeHorizon;
  window: StockOutcomeWindow;
  stance: StockStance | null;
  source_hash: string;
  benchmark_source_hash: string;
  status: "complete" | "incomplete" | "pending" | string;
  data_status: string;
  entry_date: string | null;
  exit_date: string | null;
  entry_price: number | null;
  exit_price: number | null;
  absolute_return_pct: number | null;
  mfe_pct: number | null;
  mae_pct: number | null;
  relative_market_return_pct: number | null;
  relative_market_status: string;
  declared_benchmark_id: string | null;
  declared_benchmark_return_pct: number | null;
  declared_benchmark_status: string;
  calculation_method: string;
  calculation_version: string;
  conditions: StockOutcomeConditionReplay[];
  calculated_at?: string | null;
  pending_reason?: string | null;
}

export interface StockOutcomeAggregate {
  horizon: StockOutcomeHorizon;
  window: StockOutcomeWindow;
  sample_count: number;
  complete_count: number;
  total_count: number;
  incomplete_count: number;
  scored_count: number;
  status: "insufficient_sample" | "available" | string;
  directional_accuracy: number | null;
  average_absolute_return_pct: number | null;
  average_mfe_pct: number | null;
  average_mae_pct: number | null;
}

export interface StockOutcomeTrackingHorizon {
  stance: StockStance | null;
  status: string | null;
  conditions: Array<Record<string, unknown>>;
  benchmark: Record<string, unknown>;
}

export interface StockOutcomeTracking {
  schema_version: number;
  tracking: { id: string };
  tracking_id: string;
  report: { id: string; schema_version: number };
  report_id: string;
  run: { id: string };
  workflow_run_id: string;
  instrument: Record<string, unknown>;
  research_cutoff_at: string | null;
  market_as_of: string | null;
  report_as_of: string | null;
  horizons: Record<StockOutcomeHorizon, StockOutcomeTrackingHorizon>;
  public_market_benchmark: StockOutcomeBenchmark;
  evidence: Record<string, unknown>;
  versions: Record<string, string>;
  source_ids: string[];
}

export interface StockOutcomesResponse {
  reportId: string | null;
  tracking: StockOutcomeTracking | null;
  observations: StockOutcomeObservation[];
  pending: StockOutcomeObservation[];
  aggregate: Record<StockOutcomeHorizon, Record<string, StockOutcomeAggregate>>;
  samples: StockOutcomeObservation[];
  sampleCount: number;
  updated: boolean;
  appendCount: number;
  publicMarketBenchmark: StockOutcomeBenchmark;
}

/** Read-only outcomes produced for a deterministic stock-selection run. */
export interface StockScreenOutcomeObservation {
  selection_tracking_id: string | null;
  report_id: string | null;
  workflow_run_id: string | null;
  instrument_id: string;
  rank: number | null;
  name: string | null;
  window: 5 | 20 | 60;
  status: "complete" | "incomplete" | "pending" | string;
  status_label: string | null;
  data_status: string | null;
  data_status_label: string | null;
  entry_date: string | null;
  exit_date: string | null;
  entry_price: number | null;
  exit_price: number | null;
  target_return_pct: number | null;
  benchmark_return_pct: number | null;
  relative_return_pct: number | null;
  source_hash: string | null;
  benchmark_source_hash: string | null;
  calculation_method: string | null;
  calculation_version: string | null;
  benchmark: StockOutcomeBenchmark | null;
}

export interface StockScreenOutcomeWindowSummary {
  window: 5 | 20 | 60;
  sample_count: number;
  mature_window_count: number;
  complete_count: number;
  incomplete_count: number;
  pending_count: number;
  total_window_count: number;
  data_completeness_pct: number | null;
}

export interface StockScreenOutcomeSummary {
  candidate_count: number;
  total_window_count: number;
  mature_window_count: number;
  sample_count: number;
  data_completeness_pct: number | null;
  windows: StockScreenOutcomeWindowSummary[];
  note: string | null;
}

export interface StockScreenOutcomeTracking {
  schema_version: number;
  tracking_id: string;
  report_id: string;
  workflow_run_id: string;
  report_as_of: string | null;
  candidate_count: number;
  candidates: Array<Record<string, unknown>>;
  benchmark: StockOutcomeBenchmark;
  calculation: Record<string, unknown>;
}

export interface StockScreenOutcomesResponse {
  run_id: string | null;
  report_id: string | null;
  tracking: StockScreenOutcomeTracking | null;
  observations: StockScreenOutcomeObservation[];
  pending: StockScreenOutcomeObservation[];
  summary: StockScreenOutcomeSummary;
  calculation: Record<string, unknown>;
  public_market_benchmark: StockOutcomeBenchmark;
  updated: boolean;
  append_count: number;
}

export interface StockDashboardItem {
  instrumentId: string;
  name: string;
  instrumentType: StockInstrumentType;
  focus: boolean;
  latest: StockDashboardLatest | null;
}

/** Structured run input for the deep-research template (design §4.2). */
export interface StockRunInputs {
  symbols: string[];
}

export class StockApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "StockApiError";
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { code?: string; message?: string } })
    | null;
  if (!res.ok) {
    const err = body?.error;
    throw new StockApiError(
      err?.code ?? `http_${res.status}`,
      err?.message ?? `HTTP ${res.status}`,
      res.status,
    );
  }
  return body as T;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function servicesFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const request = async () => {
    const base = await getServicesHttpBase();
    return httpFetch(`${base}${path}`, init);
  };
  let res: Response;
  try {
    res = await request();
  } catch (error) {
    if (isAbortError(error)) throw error;
    resetServicesHttpBase();
    res = await request();
  }
  return parseResponse<T>(res);
}

async function wsFetch<T>(token: string, path: string): Promise<T> {
  const base = await getApiBase();
  const res = await httpFetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseResponse<T>(res);
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// --- watchlist (services port) ---

export async function fetchStockWatchlist(): Promise<StockWatchlistItem[]> {
  const data = await servicesFetch<{ items: StockWatchlistItem[] }>(
    "/api/stock/watchlist",
    { method: "GET" },
  );
  return data.items;
}

export async function addStockWatchlist(
  input: StockWatchlistAddInput,
): Promise<StockWatchlistItem[]> {
  const data = await servicesFetch<{ items: StockWatchlistItem[] }>(
    "/api/stock/watchlist",
    jsonInit("POST", input),
  );
  return data.items;
}

export async function removeStockWatchlist(
  instrumentId: string,
): Promise<StockWatchlistItem[]> {
  const data = await servicesFetch<{ items: StockWatchlistItem[] }>(
    `/api/stock/watchlist?id=${encodeURIComponent(instrumentId)}`,
    { method: "DELETE" },
  );
  return data.items;
}

/** Toggle the focus marker feeding review_scope="focus" (design §11). */
export async function setStockWatchlistFocus(
  instrumentId: string,
  focus: boolean,
): Promise<StockWatchlistItem[]> {
  const data = await servicesFetch<{ items: StockWatchlistItem[] }>(
    "/api/stock/watchlist/focus",
    jsonInit("POST", { id: instrumentId, focus }),
  );
  return data.items;
}

/** Persist a drag-and-drop order; ids must cover the current watchlist. */
export async function reorderStockWatchlist(
  instrumentIds: string[],
): Promise<StockWatchlistItem[]> {
  const data = await servicesFetch<{ items: StockWatchlistItem[] }>(
    "/api/stock/watchlist/order",
    jsonInit("POST", { ids: instrumentIds }),
  );
  return data.items;
}

export async function importStockWatchlist(
  text: string,
): Promise<StockWatchlistImportResult> {
  return servicesFetch<StockWatchlistImportResult>(
    "/api/stock/watchlist/import",
    jsonInit("POST", { text }),
  );
}

// --- market data (services port) ---

export async function searchStocks(
  keyword: string,
): Promise<StockSearchResult[]> {
  const data = await servicesFetch<{ results: StockSearchResult[] }>(
    `/api/stock/search?q=${encodeURIComponent(keyword)}`,
    { method: "GET" },
  );
  return data.results;
}

export async function fetchStockQuotes(
  instrumentIds: string[],
): Promise<StockQuote[]> {
  const data = await servicesFetch<{ quotes: StockQuote[] }>(
    `/api/stock/quote?ids=${encodeURIComponent(instrumentIds.join(","))}`,
    { method: "GET" },
  );
  return data.quotes;
}

export async function fetchStockKline(
  instrumentId: string,
  limit = 120,
  /** K线周期：101 日K / 102 周K / 103 月K（默认日K）。 */
  klt: 101 | 102 | 103 = 101,
): Promise<StockKlineResponse> {
  return servicesFetch<StockKlineResponse>(
    `/api/stock/kline?id=${encodeURIComponent(instrumentId)}&limit=${limit}&klt=${klt}`,
    { method: "GET" },
  );
}

export async function fetchStockIntraday(
  instrumentId: string,
  signal?: AbortSignal,
): Promise<StockIntradaySeries> {
  return servicesFetch<StockIntradaySeries>(
    `/api/stock/intraday?id=${encodeURIComponent(instrumentId)}`,
    { method: "GET", signal },
  );
}

export async function fetchStockOutcomes(
  reportId?: string,
): Promise<StockOutcomesResponse> {
  const query = reportId ? `?reportId=${encodeURIComponent(reportId)}` : "";
  return servicesFetch<StockOutcomesResponse>(
    `/api/stock/outcomes${query}`,
    { method: "GET" },
  );
}

export async function refreshStockOutcomes(
  reportId: string,
): Promise<StockOutcomesResponse> {
  return servicesFetch<StockOutcomesResponse>(
    "/api/stock/outcomes/refresh",
    jsonInit("POST", { reportId }),
  );
}

function eventData(event: Event): unknown {
  const raw = (event as MessageEvent<string>).data;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function defaultIntradayEventSource(url: string): StockIntradayEventSource {
  if (typeof EventSource === "undefined") {
    throw new Error("EventSource is not available");
  }
  return new EventSource(url);
}

/** Open one SSE connection; the caller owns its lifecycle and may inject a fake. */
export async function openStockIntradayStream(
  instrumentId: string,
  handlers: StockIntradayStreamHandlers,
  options: {
    eventSourceFactory?: StockIntradayEventSourceFactory;
    signal?: AbortSignal;
  } = {},
): Promise<StockIntradayStream> {
  if (options.signal?.aborted) {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  }
  const base = await getServicesHttpBase();
  const url = `${base.replace(/\/$/, "")}/api/stock/intraday/stream?id=${encodeURIComponent(instrumentId)}`;
  const source = (options.eventSourceFactory ?? defaultIntradayEventSource)(url);
  const listeners: Array<[string, (event: Event) => void]> = [];
  let closed = false;
  const add = (type: string, listener: (event: Event) => void) => {
    listeners.push([type, listener]);
    source.addEventListener(type, listener);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const [type, listener] of listeners) {
      source.removeEventListener?.(type, listener);
    }
    options.signal?.removeEventListener("abort", close);
    source.close();
  };
  const snapshot = (event: Event) => {
    const payload = eventData(event);
    if (payload && typeof payload === "object" && Array.isArray((payload as StockIntradaySeries).points)) {
      handlers.onSnapshot?.(payload as StockIntradaySeries);
    }
  };
  const point = (event: Event) => {
    const payload = eventData(event);
    if (payload && typeof payload === "object") {
      handlers.onPoint?.(payload as StockIntradayPoint | StockIntradaySeries);
    }
  };
  const status = (event: Event) => {
    const payload = eventData(event);
    if (payload && typeof payload === "object") {
      handlers.onStatus?.(payload as StockIntradayStatusEvent);
    }
  };
  add("snapshot", snapshot);
  add("point", point);
  add("status", status);
  add("error", handlers.onError ?? (() => undefined));
  const stream = { source, close };
  if (options.signal) {
    options.signal.addEventListener("abort", close, { once: true });
    if (options.signal.aborted) close();
  }
  return stream;
}

export async function fetchStockResearchContext(
  instrumentId: string,
): Promise<StockResearchContext> {
  return servicesFetch<StockResearchContext>(
    `/api/stock/research-context?id=${encodeURIComponent(instrumentId)}`,
    { method: "GET" },
  );
}

export async function preflightStockResearch(
  instrumentId: string,
  name?: string,
): Promise<StockResearchPreflight> {
  return servicesFetch<StockResearchPreflight>(
    "/api/stock/research/preflight",
    jsonInit("POST", { instrumentId, ...(name ? { name } : {}) }),
  );
}

export async function fetchStockMaterials(
  instrumentId: string,
): Promise<StockMaterialsResponse> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>(
    `/api/stock/materials?instrumentId=${encodeURIComponent(instrumentId)}`,
    { method: "GET" },
  ));
  return normalizeStockMaterialsResponse(data);
}

export async function createStockMaterialBinding(
  input: StockMaterialBindingInput,
): Promise<StockMaterialBinding | null> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>(
    "/api/stock/materials/bind",
    jsonInit("POST", {
      instrumentId: input.instrument_id,
      materialId: input.material_id,
      reportPeriod: input.report_period,
      firstPublishedAt: input.first_published_at,
      publisher: input.publisher,
      pages: input.pages,
    }),
  ));
  return normalizeStockMaterialBindingResult(data);
}

export async function confirmStockMaterialBinding(
  bindingId: string,
  confirmedFacts?: StockConfirmedFinancialFactInput[],
): Promise<StockMaterialBinding | null> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>(
    "/api/stock/materials/confirm",
    jsonInit("POST", {
      bindingId,
      ...(confirmedFacts !== undefined
        ? {
            confirmedFacts: confirmedFacts.map((fact) => ({
              metric: fact.metric,
              valueText: fact.value_text,
              unit: fact.unit,
              page: fact.page,
              excerpt: fact.excerpt,
            })),
          }
        : {}),
    }),
  ));
  return normalizeStockMaterialBindingResult(data);
}

export async function fetchStockMaterialPage(
  materialId: string,
  page: number,
): Promise<StockMaterialPagePreview> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>(
    `/api/stock/materials/preview?materialId=${encodeURIComponent(materialId)}&page=${encodeURIComponent(String(page))}`,
    { method: "GET" },
  ));
  return normalizeStockMaterialPagePreview(data);
}

// --- opportunity discovery / deterministic screening (services port) ---

function unwrapList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

/** Normalize the stock-screen service's pydantic aliases once at the HTTP
 * boundary. The rest of the UI uses the domain's snake_case contract. */
function normalizeScreenKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeScreenKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      // Object keys inside dimensions/contribution maps are domain values,
      // not API fields.  Keep identifiers such as XSHG:600519 and all-caps
      // factor names intact while normalizing actual camelCase fields.
      key.includes(":") || /^[A-Z0-9_]+$/.test(key)
        ? key
        : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      normalizeScreenKeys(child),
    ]),
  );
}

function normalizeStockMaterialBinding(value: unknown): StockMaterialBinding | null {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!record) return null;
  const pages = Array.isArray(record.pages)
    ? record.pages.filter((page): page is number => typeof page === "number" && Number.isInteger(page) && page > 0)
    : [];
  const statusRecord = record.status && typeof record.status === "object" && !Array.isArray(record.status)
    ? record.status as Record<string, unknown>
    : null;
  const statusCode = typeof record.status_code === "string"
    ? record.status_code
    : typeof statusRecord?.status_code === "string"
      ? statusRecord.status_code
      : null;
  const status = typeof record.status === "string"
    ? record.status
    : statusCode === "confirmed"
      ? "已确认"
      : statusCode === "invalidated"
        ? "已失效"
        : "待用户确认";
  const confirmedFacts = Array.isArray(record.confirmed_facts)
    ? record.confirmed_facts.flatMap((fact) => {
      const item = fact && typeof fact === "object" && !Array.isArray(fact)
        ? fact as Record<string, unknown>
        : null;
      if (!item) return [];
      const page = typeof item.page === "number" && Number.isInteger(item.page) && item.page > 0
        ? item.page
        : null;
      if (
        typeof item.metric_name !== "string"
        || typeof item.value_text !== "string"
        || typeof item.unit !== "string"
        || page === null
        || typeof item.excerpt !== "string"
      ) return [];
      return [{
        metric_name: item.metric_name,
        value_text: item.value_text,
        unit: item.unit,
        page,
        excerpt: item.excerpt,
      }];
    })
    : [];
  return {
    binding_id: typeof record.binding_id === "string" ? record.binding_id : "",
    material_id: typeof record.material_id === "string" ? record.material_id : null,
    instrument_id: typeof record.instrument_id === "string" ? record.instrument_id : null,
    report_type: typeof record.report_type === "string" ? record.report_type : null,
    report_period: typeof record.report_period === "string" ? record.report_period : null,
    first_published_at: typeof record.first_published_at === "string" ? record.first_published_at : null,
    publisher: typeof record.publisher === "string" ? record.publisher : null,
    pages,
    confirmed_facts: confirmedFacts,
    user_confirmed: record.user_confirmed === true,
    confirmed_at: typeof record.confirmed_at === "string" ? record.confirmed_at : null,
    status,
    status_code: statusCode,
    invalidation_reason: typeof record.invalidation_reason === "string" ? record.invalidation_reason : null,
  };
}

function normalizeStockMaterialsResponse(value: unknown): StockMaterialsResponse {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const materials = Array.isArray(payload.materials)
    ? payload.materials.flatMap((item) => {
      const record = item && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : null;
      if (!record) return [];
      const bindings = Array.isArray(record.bindings)
        ? record.bindings.flatMap((binding) => {
          const normalized = normalizeStockMaterialBinding(binding);
          return normalized ? [normalized] : [];
        })
        : [];
      return [{
        material_id: typeof record.material_id === "string" ? record.material_id : "",
        material_name: typeof record.material_name === "string" ? record.material_name : "未命名财报",
        extraction_status: typeof record.extraction_status === "string" ? record.extraction_status : "提取状态待确认",
        extraction_status_code: typeof record.extraction_status_code === "string" ? record.extraction_status_code : null,
        page_count: typeof record.page_count === "number" && Number.isFinite(record.page_count) ? record.page_count : 0,
        bindings,
      }];
    })
    : [];
  return {
    instrument_id: typeof payload.instrument_id === "string" ? payload.instrument_id : "",
    materials,
  };
}

function normalizeStockMaterialBindingResult(value: unknown): StockMaterialBinding | null {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return normalizeStockMaterialBinding(payload.binding ?? payload);
}

function normalizeStockMaterialPagePreview(value: unknown): StockMaterialPagePreview {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const preview = payload.preview && typeof payload.preview === "object" && !Array.isArray(payload.preview)
    ? payload.preview as Record<string, unknown>
    : payload;
  const text = [preview.text, preview.page_text, preview.content, preview.extracted_text]
    .find((item): item is string => typeof item === "string") ?? "";
  return {
    material_name: typeof preview.material_name === "string"
      ? preview.material_name
      : typeof preview.materialName === "string"
        ? preview.materialName
        : null,
    page: typeof preview.page === "number" && Number.isInteger(preview.page) ? preview.page : 0,
    page_count: typeof preview.page_count === "number" && Number.isFinite(preview.page_count) ? preview.page_count : null,
    text,
  };
}

function normalizeStockScreenOutcomeResponse(value: unknown): StockScreenOutcomesResponse {
  const payload = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const asRecord = (item: unknown): Record<string, unknown> | null =>
    item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null;
  const asString = (item: unknown): string | null =>
    typeof item === "string" ? item : null;
  const asNumber = (item: unknown): number | null =>
    typeof item === "number" && Number.isFinite(item) ? item : null;
  const asBenchmark = (item: unknown): StockOutcomeBenchmark | null => {
    const record = asRecord(item);
    if (!record) return null;
    return {
      name: asString(record.name) ?? "",
      instrument_id: asString(record.instrument_id) ?? "",
      instrument_type: asString(record.instrument_type) ?? "",
    };
  };
  const normalizeObservation = (item: unknown): StockScreenOutcomeObservation | null => {
    const row = asRecord(item);
    const window = row?.window;
    if (!row || (window !== 5 && window !== 20 && window !== 60)) return null;
    return {
      selection_tracking_id: asString(row.selection_tracking_id),
      report_id: asString(row.report_id),
      workflow_run_id: asString(row.workflow_run_id),
      instrument_id: asString(row.instrument_id) ?? "",
      rank: asNumber(row.rank),
      name: asString(row.name),
      window,
      status: asString(row.status) ?? "incomplete",
      status_label: asString(row.status_label),
      data_status: asString(row.data_status),
      data_status_label: asString(row.data_status_label),
      entry_date: asString(row.entry_date),
      exit_date: asString(row.exit_date),
      entry_price: asNumber(row.entry_price),
      exit_price: asNumber(row.exit_price),
      target_return_pct: asNumber(row.target_return_pct),
      benchmark_return_pct: asNumber(row.benchmark_return_pct),
      relative_return_pct: asNumber(row.relative_return_pct),
      source_hash: asString(row.source_hash),
      benchmark_source_hash: asString(row.benchmark_source_hash),
      calculation_method: asString(row.calculation_method),
      calculation_version: asString(row.calculation_version),
      benchmark: asBenchmark(row.benchmark),
    };
  };
  const summaryRecord = asRecord(payload.summary) ?? {};
  const windows = Array.isArray(summaryRecord.windows)
    ? summaryRecord.windows.flatMap((item) => {
      const row = asRecord(item);
      const window = row?.window;
      if (!row || (window !== 5 && window !== 20 && window !== 60)) return [];
      return [{
        window: window as StockScreenOutcomeWindowSummary["window"],
        sample_count: asNumber(row.sample_count) ?? 0,
        mature_window_count: asNumber(row.mature_window_count) ?? 0,
        complete_count: asNumber(row.complete_count) ?? 0,
        incomplete_count: asNumber(row.incomplete_count) ?? 0,
        pending_count: asNumber(row.pending_count) ?? 0,
        total_window_count: asNumber(row.total_window_count) ?? 0,
        data_completeness_pct: asNumber(row.data_completeness_pct),
      }];
    })
    : [];
  const summary: StockScreenOutcomeSummary = {
    candidate_count: asNumber(summaryRecord.candidate_count) ?? 0,
    total_window_count: asNumber(summaryRecord.total_window_count) ?? 0,
    mature_window_count: asNumber(summaryRecord.mature_window_count) ?? 0,
    sample_count: asNumber(summaryRecord.sample_count) ?? 0,
    data_completeness_pct: asNumber(summaryRecord.data_completeness_pct),
    windows,
    note: asString(summaryRecord.note),
  };
  const tracking = asRecord(payload.tracking);
  const benchmark = asBenchmark(payload.public_market_benchmark) ?? {
    name: "中证全指",
    instrument_id: "",
    instrument_type: "index",
  };
  return {
    run_id: asString(payload.run_id),
    report_id: asString(payload.report_id),
    tracking: tracking ? {
      schema_version: asNumber(tracking.schema_version) ?? 0,
      tracking_id: asString(tracking.tracking_id) ?? "",
      report_id: asString(tracking.report_id) ?? "",
      workflow_run_id: asString(tracking.workflow_run_id) ?? "",
      report_as_of: asString(tracking.report_as_of),
      candidate_count: asNumber(tracking.candidate_count) ?? 0,
      candidates: Array.isArray(tracking.candidates)
        ? tracking.candidates.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)))
        : [],
      benchmark: asBenchmark(tracking.benchmark) ?? benchmark,
      calculation: asRecord(tracking.calculation) ?? {},
    } : null,
    observations: Array.isArray(payload.observations)
      ? payload.observations.flatMap((item) => {
        const row = normalizeObservation(item);
        return row ? [row] : [];
      })
      : [],
    pending: Array.isArray(payload.pending)
      ? payload.pending.flatMap((item) => {
        const row = normalizeObservation(item);
        return row ? [row] : [];
      })
      : [],
    summary,
    calculation: asRecord(payload.calculation) ?? {},
    public_market_benchmark: benchmark,
    updated: payload.updated === true,
    append_count: asNumber(payload.append_count) ?? 0,
  };
}

export async function fetchStockScreenTemplates(): Promise<StockScreenTemplate[]> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>("/api/stock/screen/templates", { method: "GET" }));
  return unwrapList<StockScreenTemplate>(data, "templates");
}

export async function fetchStockScreenStrategies(): Promise<StockScreenStrategy[]> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>("/api/stock/screen/strategies", { method: "GET" }));
  return unwrapList<StockScreenStrategy>(data, "strategies");
}

export async function saveStockScreenStrategy(
  strategy: StockScreenStrategy,
): Promise<StockScreenStrategy> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>(
    "/api/stock/screen/strategies",
    jsonInit("POST", strategy),
  ));
  if (data && typeof data === "object") {
    const value = (data as Record<string, unknown>).strategy;
    if (value && typeof value === "object") return value as StockScreenStrategy;
  }
  return data as StockScreenStrategy;
}

export async function deleteStockScreenStrategy(strategyId: string): Promise<void> {
  await servicesFetch<unknown>(
    `/api/stock/screen/strategies?id=${encodeURIComponent(strategyId)}`,
    { method: "DELETE" },
  );
}

export async function fetchStockScreenResult(runId: string): Promise<StockScreenReport> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>(
    `/api/stock/screen/results?runId=${encodeURIComponent(runId)}`,
    { method: "GET" },
  ));
  if (data && typeof data === "object") {
    const value = (data as Record<string, unknown>).report;
    if (value && typeof value === "object") return value as StockScreenReport;
  }
  return data as StockScreenReport;
}

export async function fetchStockScreenOutcomes(
  runId: string,
  signal?: AbortSignal,
): Promise<StockScreenOutcomesResponse> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>(
    `/api/stock/screen/outcomes?runId=${encodeURIComponent(runId)}`,
    { method: "GET", signal },
  ));
  return normalizeStockScreenOutcomeResponse(data);
}

export async function refreshStockScreenOutcomes(
  runId: string,
  signal?: AbortSignal,
): Promise<StockScreenOutcomesResponse> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>(
    "/api/stock/screen/outcomes/refresh",
    { ...jsonInit("POST", { runId }), signal },
  ));
  return normalizeStockScreenOutcomeResponse(data);
}

export async function fetchStockOpportunitySource(
  runId: string,
  contextId: string,
  sourceId: string,
): Promise<StockOpportunitySource> {
  const query = new URLSearchParams({ runId, contextId, sourceId });
  const data = normalizeScreenKeys(await servicesFetch<unknown>(
    `/api/stock/screen/opportunity/source?${query.toString()}`,
    { method: "GET" },
  ));
  if (data && typeof data === "object") {
    const source = (data as Record<string, unknown>).source;
    if (source && typeof source === "object") return source as StockOpportunitySource;
  }
  return data as StockOpportunitySource;
}

export async function fetchStockScreenHistory(): Promise<StockScreenHistoryItem[]> {
  const data = normalizeScreenKeys(await servicesFetch<unknown>("/api/stock/screen/history", { method: "GET" }));
  const rows = unwrapList<Record<string, unknown>>(data, "items");
  const compatibleRows = rows.length > 0
    ? rows
    : unwrapList<Record<string, unknown>>(data, "history");
  return compatibleRows.map((item) => {
    const strategy = item.strategy && typeof item.strategy === "object"
      ? item.strategy as Record<string, unknown>
      : {};
    const candidateIds = Array.isArray(item._candidate_ids) ? item._candidate_ids : [];
    const runId = String(item.run_id ?? item.workflow_run_id ?? "");
    const rawStatus = String(item.status ?? "unknown");
    return {
      ...(item as unknown as StockScreenHistoryItem),
      run_id: runId,
      workflow_run_id: runId,
      strategy_id: String(item.strategy_id ?? strategy.strategy_id ?? ""),
      strategy_name: String(item.strategy_name ?? strategy.name ?? "选股策略"),
      candidate_count: Number(item.candidate_count ?? candidateIds.length),
      status: rawStatus === "completed" ? "succeeded" : rawStatus,
    };
  });
}

export async function compareStockScreenCandidates(
  instrumentIds: string[],
  runId: string,
): Promise<StockScreenCompareResult> {
  const data = normalizeScreenKeys(await servicesFetch<StockScreenCompareResult>(
    "/api/stock/screen/compare",
    jsonInit("POST", { runId, instrumentIds }),
  )) as StockScreenCompareResult;
  if (!data.candidates && data.items) return { ...data, candidates: data.items };
  return data;
}

// --- reports (WebSocket port, workspace-scoped, bearer token) ---

export async function fetchStockReports(
  token: string,
): Promise<StockReportListItem[]> {
  const data = await wsFetch<{ reports: StockReportListItem[] }>(
    token,
    "/api/stock/reports",
  );
  return data.reports;
}

export async function fetchStockReport(
  token: string,
  reportId: string,
): Promise<StockReportDetail> {
  return wsFetch<StockReportDetail>(
    token,
    `/api/stock/reports/${encodeURIComponent(reportId)}`,
  );
}

/** 手动清理（design §9）：删除报告所属运行的整个产物目录。 */
export async function deleteStockReport(
  token: string,
  reportId: string,
): Promise<void> {
  await wsFetch<{ deleted: boolean }>(
    token,
    `/api/stock/report-delete?id=${encodeURIComponent(reportId)}`,
  );
}

export async function fetchStockDashboard(
  token: string,
): Promise<StockDashboardItem[]> {
  const data = await wsFetch<{ items: StockDashboardItem[] }>(
    token,
    "/api/stock/dashboard",
  );
  return data.items;
}
