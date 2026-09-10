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

/** Quantitative observations are descriptive until P7 calibration is enabled. */
export type StockQuantValidationStatus =
  | "uncalibrated"
  | "support"
  | "unconfirmed"
  | "oppose"
  | "insufficient_data";
export type StockQuantSignal = "positive" | "neutral" | "negative" | "insufficient_data";
export type StockQuantHorizon = "short_term" | "medium_term" | "long_term";

export interface StockQuantFactorObservation {
  field: string;
  raw_value?: number | null;
  percentile_or_rank?: number | null;
  direction?: "asc" | "desc";
  scope?: "industry" | "market_fallback" | "market" | "mixed";
  sample_count?: number;
  missing_count?: number;
  as_of?: string | null;
  source_ids?: string[];
  method_version?: string;
  validation_status?: StockQuantValidationStatus;
}

export interface StockQuantHorizonValidation {
  validation_status?: StockQuantValidationStatus;
  quant_signal?: StockQuantSignal;
  factor_observations?: StockQuantFactorObservation[];
}

export interface StockQuantCandidateValidation {
  validation_status?: StockQuantValidationStatus;
  quant_signal?: StockQuantSignal;
  horizons?: Partial<Record<StockQuantHorizon, StockQuantHorizonValidation>>;
}

export interface StockQuantPointInTimeQuality {
  status?: "not_requested" | "verified" | "incompatible" | "unknown" | string;
  requested_as_of?: string | null;
  latest_observed_at?: string | null;
  missing_observed_at?: number;
}

export interface StockQuantDataQuality {
  status?: StockScreenDataQualityStatus;
  quant_validation_status?: StockQuantValidationStatus;
  reason?: string;
  point_in_time?: StockQuantPointInTimeQuality;
  missing_factor_fields?: string[];
}

export interface StockQuantUniverse {
  universe_count?: number;
  hard_filter_count?: number;
  cheap_count?: number;
  enriched_count?: number;
  unprocessed_after_cap?: number;
  preselection_basis?: string | null;
}

export interface StockQuantFactorScope {
  scope?: "industry" | "market_fallback" | "market" | "mixed";
  sample_count?: number;
  missing_count?: number;
  direction?: "asc" | "desc";
  weight?: number;
}

export interface StockQuantSnapshot {
  schema_version?: number;
  strategy_id?: string;
  strategy_fingerprint?: string;
  as_of?: string | null;
  factor_algorithm_version?: string;
  rank_algorithm_version?: string;
  validation_status?: StockQuantValidationStatus;
  reason?: string;
  universe?: StockQuantUniverse;
  factor_scopes?: Record<string, StockQuantFactorScope>;
  candidate_ids_hash?: string;
  source_ids?: string[];
  data_quality?: StockQuantDataQuality;
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
  quant_validation?: StockQuantCandidateValidation | null;
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
  quant_snapshot?: StockQuantSnapshot | null;
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

/** Public V5 list/dashboard projection returned by the report routes.
 *
 * The API intentionally keeps the list payload compact: the full transaction
 * and position plans are only returned by the detail route.  Keep these
 * camelCase names aligned with `mona.services.stock.reports._report_projection`.
 */
export interface StockReportV5HorizonProjection {
  direction: StockReportV5Direction;
  action: StockReportV5Action;
  validUntil: string;
  isExpired: boolean;
}

export interface StockReportV5ListProjection {
  schemaVersion: 5;
  resultStatus: "completed";
  horizonDecisions: {
    shortTerm: StockReportV5HorizonProjection;
    mediumTerm: StockReportV5HorizonProjection;
    longTerm: StockReportV5HorizonProjection;
  };
  researchCutoffAt: string;
  marketAsOf: string;
  generatedAt: string;
  isExpired: boolean;
  hasExpiredHorizon: boolean;
  stance: null;
  dataQuality: null;
}

export type StockReportV5Direction = "positive" | "neutral" | "negative";
export type StockReportV5Action =
  | "conditional_participation"
  | "wait"
  | "hold"
  | "reduce"
  | "exit"
  | "avoid";
export type StockReportV5NotHoldingAction = "participate" | "wait" | "avoid";
export type StockReportV5HoldingAction = "hold" | "reduce" | "exit";
export type StockReportV5EvidenceStrength = "strong" | "medium" | "weak";

export interface StockReportV5TradingPlan {
  referenceBuyLow: number;
  referenceBuyHigh: number;
  pullbackBuyLow: number;
  pullbackBuyHigh: number;
  stopLoss: number;
  firstTakeProfit: number;
  firstReduceFraction: number;
  secondTakeProfit: number;
  secondReduceFraction: number;
  riskRewardFirst: number;
  riskRewardSecond: number;
  currency: "元";
}

export interface StockReportV5PositionPlan {
  riskBudgetPct: number;
  initialPositionPct: number;
  maxPositionPct: number;
  stopDistancePct: number;
}

export interface StockReportV5HorizonDecision {
  direction: StockReportV5Direction;
  action: StockReportV5Action;
  thesis: string;
  notHoldingAction: StockReportV5NotHoldingAction;
  holdingAction: StockReportV5HoldingAction;
  tradingPlan: StockReportV5TradingPlan;
  positionPlan: StockReportV5PositionPlan;
  validUntil: string;
  reviewTrigger: string;
  keyReasons: string[];
  keyRisks: string[];
  evidenceStrength: StockReportV5EvidenceStrength;
  marketAsOf: string;
  generatedAt: string;
  isExpired: boolean;
}

/** User-facing V5 detail projection.  It is deliberately separate from the
 * persisted snake_case report and contains no agent/provenance internals. */
export interface StockReportV5Document {
  schemaVersion: 5;
  resultStatus: "completed";
  reportId: string;
  runId: string;
  kind: "deep_research";
  instrument: StockReportInstrument;
  summary: string;
  researchCutoffAt: string;
  marketAsOf: string;
  generatedAt: string;
  isExpired: boolean;
  hasExpiredHorizon: boolean;
  horizonDecisions: {
    shortTerm: StockReportV5HorizonDecision;
    mediumTerm: StockReportV5HorizonDecision;
    longTerm: StockReportV5HorizonDecision;
  };
  /** Compatibility properties intentionally do not exist in V5. */
  schema_version?: never;
  as_of?: never;
  research_stance?: never;
  data_quality?: never;
  source_ids?: never;
  open_questions?: never;
  technical_levels?: never;
  time_horizon?: never;
  evidence_strength?: never;
  decision_conditions?: never;
  report_id?: never;
  workflow_run_id?: never;
  analyst_views?: never;
  debate?: never;
  risks?: never;
  catalysts?: never;
  bull_case_summary?: never;
  bear_case_summary?: never;
}

export type StockReportV6Direction = "positive" | "neutral" | "negative" | "avoid";
export type StockReportV6DecisionMode = "research_only" | "reference_plan";
export type StockReportV6ResearchStatus = "ready" | "unavailable";
export type StockReportV6TradeStatus = "ready" | "unavailable";
export type StockReportV6PlanStatus = "proxy" | "limited" | "blocked";
export type StockReportV6CurrentAction =
  | "participate"
  | "wait"
  | "hold"
  | "reduce"
  | "exit"
  | "avoid"
  | "execution_blocked";

/** Compact status projection used by V6 list/dashboard responses. */
export interface StockReportV6HorizonProjection {
  direction: StockReportV6Direction;
  action: StockReportV5Action;
  researchStatus: StockReportV6ResearchStatus;
  tradeStatus: StockReportV6TradeStatus;
}

export interface StockReportV6ListProjection {
  schemaVersion: 6;
  resultStatus: "completed";
  decisionMode: StockReportV6DecisionMode;
  researchStatus: StockReportV6ResearchStatus;
  tradeStatus: StockReportV6TradeStatus;
  horizonDecisions: {
    shortTerm: StockReportV6HorizonProjection;
    mediumTerm: StockReportV6HorizonProjection;
    longTerm: StockReportV6HorizonProjection;
  };
  researchCutoffAt: string;
  marketAsOf: string;
  valuation?: StockReportV6ConclusionSection | Record<string, unknown>;
  marketSentiment?: StockReportV6MarketSentiment | null;
  publicOpinion?: StockReportV6PublicOpinion | null;
  stance: null;
  dataQuality: null;
}

export interface StockReportV6ExecutionAssessment {
  executionStatus?: "proxy" | "limited" | "blocked";
  rulesStatus?: "confirmed" | "limited";
  liquidityStatus?: "proxy" | "limited";
  buyStatus?: "proxy" | "limited" | "blocked" | "not_applicable";
  sellStatus?: "proxy" | "limited" | "blocked" | "not_applicable";
  tPlusOneStatus?: "allowed" | "restricted" | "not_applicable" | "unknown";
  immediateExecutionAllowed?: false;
  executionMode?: "research_only";
  warnings?: string[];
  [key: string]: unknown;
}

/** Public V6 plan. All numeric fields are optional because research-only and
 * direction-aware plans intentionally expose only the applicable boundaries. */
export interface StockReportV6MaterializedPlan {
  direction?: StockReportV6Direction;
  action?: StockReportV5Action;
  holdingState?: "not_holding" | "holding";
  currentAction?: StockReportV6CurrentAction;
  planStatus?: StockReportV6PlanStatus;
  execution?: StockReportV6ExecutionAssessment;
  buyLow?: number | null;
  buyHigh?: number | null;
  pullbackLow?: number | null;
  pullbackHigh?: number | null;
  confirmationPrice?: number | null;
  invalidationPrice?: number | null;
  exitPrice?: number | null;
  reentryConfirmationPrice?: number | null;
  stopLoss?: number | null;
  firstTakeProfit?: number | null;
  secondTakeProfit?: number | null;
  initialPositionPct?: number;
  maxPositionPct?: number;
  targetMaxPositionPct?: number;
  additionalPositionPct?: number;
  liquidityCapPct?: number | null;
  riskBudgetPct?: number;
  riskRewardFirstAfterCost?: number | null;
  riskRewardSecondAfterCost?: number | null;
  riskProfileName?: string;
  riskProfileConfigured?: boolean;
  positionCapReasons?: string[];
  executionMode?: "research_only";
  [key: string]: unknown;
}

export interface StockReportV6ConclusionSection {
  status?: string;
  summary?: string;
  conclusion?: string;
  label?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface StockReportV6MarketSentiment {
  status?: string | null;
  direction?: "偏多" | "偏空" | "震荡" | "暂不判断" | null;
  strength?: string | null;
  asOf?: string | null;
  decisionImpact?: string | null;
}

export interface StockReportV6PublicOpinion {
  status?: string | null;
  direction?: "偏多" | "偏空" | "分歧" | null;
  asOf?: string | null;
  coverageAccountCount?: number | null;
  redfoxIndex?: number | null;
  decisionImpact?: string | null;
}

export interface StockReportV6HorizonDecision {
  direction: StockReportV6Direction;
  action: StockReportV5Action;
  thesis: string;
  keyReasons: string[];
  keyRisks: string[];
  researchStatus: StockReportV6ResearchStatus;
  tradeStatus: StockReportV6TradeStatus;
  materializedPlan: StockReportV6MaterializedPlan | null;
  validUntil?: string | null;
  reviewTrigger?: string | null;
  disagreementMatrix?: Record<string, unknown> | null;
}

export interface StockReportV6Document {
  schemaVersion: 6;
  resultStatus: "completed";
  reportId: string;
  runId: string;
  kind: "deep_research";
  instrument: StockReportInstrument;
  decisionMode: StockReportV6DecisionMode;
  researchStatus: StockReportV6ResearchStatus;
  tradeStatus: StockReportV6TradeStatus;
  summary: string;
  researchCutoffAt: string;
  marketAsOf: string;
  generatedAt: string;
  currentPrice?: number | null;
  benchmarkPrice?: number | null;
  sourceCount?: number;
  horizonDecisions: {
    shortTerm: StockReportV6HorizonDecision;
    mediumTerm: StockReportV6HorizonDecision;
    longTerm: StockReportV6HorizonDecision;
  };
  researchReady?: StockReportV6ConclusionSection | Record<string, unknown>;
  tradeReady?: StockReportV6ConclusionSection | Record<string, unknown>;
  quantValidation?: StockReportV6QuantValidation | StockReportQuantValidation | null;
  quantPromotion?: StockReportV6ConclusionSection | Record<string, unknown>;
  valuation?: StockReportV6ConclusionSection | Record<string, unknown>;
  marketSentiment?: StockReportV6MarketSentiment | null;
  publicOpinion?: StockReportV6PublicOpinion | null;
  executionQualification?: StockReportV6ConclusionSection | Record<string, unknown>;
  /** V6 public detail never uses the historical snake_case report shape. */
  schema_version?: never;
  report_id?: never;
  workflow_run_id?: never;
  as_of?: never;
  research_stance?: never;
  data_quality?: never;
  source_ids?: never;
  risks?: never;
  catalysts?: never;
  open_questions?: never;
  analyst_views?: never;
  debate?: never;
  technical_levels?: never;
  time_horizon?: never;
  evidence_strength?: never;
  decision_conditions?: never;
  bull_case_summary?: never;
  bear_case_summary?: never;
}

export type StockReportProjection =
  | StockLegacyReportProjection
  | StockV4ReportProjection
  | StockReportV5ListProjection
  | StockReportV6ListProjection;

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

export type StockDashboardLatest = Omit<StockReportListFields, "instrument" | "symbols" | "modifiedAt"> &
  Partial<Pick<StockReportListFields, "modifiedAt">> &
  StockReportProjection;

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
  /** Optional on legacy conditions; required by new stop/take conditions. */
  claim_type?: StockClaimType | null;
  observed_metric_ref?: string | null;
  operator?: StockConditionOperator | null;
  threshold_metric_ref?: string | null;
  /** @deprecated V4 conditions must use threshold_metric_ref. Kept only so old documents remain readable. */
  threshold?: number | null;
  source_ids: string[];
}

export type StockDecisionConditionStatus = "matched" | "not_matched" | "not_evaluable";
export type StockDecisionConditionGroup =
  | "participation"
  | "confirmation"
  | "watch"
  | "invalidation"
  | "stop_loss"
  | "take_profit"
  | "other";
export type StockDecisionHorizonKey = "shortTerm" | "mediumTerm" | "longTerm";

export interface StockDecisionConditionEvaluation {
  group: StockDecisionConditionGroup;
  groupLabel: string;
  text: string;
  sourceIds: string[];
  status: StockDecisionConditionStatus;
  statusLabel: "已满足" | "未满足" | "暂无法判断";
  evaluatedAt: string | null;
  methodVersion: string | null;
  reason: string | null;
}

export interface StockDecisionRiskRewardEvaluation {
  status: StockDecisionConditionStatus;
  statusLabel: "已满足" | "未满足" | "暂无法判断";
  ratio: number | null;
  direction: "long" | "short" | "unknown";
  evaluatedAt: string | null;
  methodVersion: string | null;
  reason: string | null;
}

export interface StockDecisionHorizonEvaluation {
  conditions: StockDecisionConditionEvaluation[];
  riskReward: StockDecisionRiskRewardEvaluation;
}

export interface StockDecisionEvaluation {
  reportId: string | null;
  evaluatedAt: string | null;
  methodVersion: string;
  horizons: Partial<Record<StockDecisionHorizonKey, StockDecisionHorizonEvaluation>> &
    Record<string, unknown>;
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
  /** Optional so old V4 JSON without P6 fields remains readable. */
  stop_loss_conditions?: StockHorizonCondition[];
  take_profit_conditions?: StockHorizonCondition[];
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

/** Quantitative verification embedded in a trusted V4 deep-research report.
 * This is intentionally separate from the selection-result quant snapshot. */
export type StockReportQuantValidationStatus =
  | "uncalibrated"
  | "support"
  | "unconfirmed"
  | "oppose"
  | "insufficient_data";
export type StockReportQuantSignal = "positive" | "neutral" | "negative" | "insufficient_data";

export interface StockReportQuantFactorObservation {
  field: string;
  raw_value: number | null;
  percentile_or_rank: number | null;
  direction: "asc" | "desc";
  scope: "industry" | "market_fallback" | "market" | "mixed";
  sample_count: number;
  missing_count: number;
  as_of: string | null;
  source_ids: string[];
  source_count?: number;
  method_version: string;
  validation_status: StockReportQuantValidationStatus;
}

export interface StockReportQuantHorizon {
  status: StockReportQuantValidationStatus;
  signal: StockReportQuantSignal;
  factor_observations: StockReportQuantFactorObservation[];
  /** Optional metadata from the deterministic horizon method registry. */
  method_id?: string | null;
  method_version?: string | null;
  target_window_sessions?: number | null;
  target_definition?: string | null;
}

export interface StockReportQuantValidation {
  selection_run_id?: string;
  report_id?: string;
  strategy_id: string;
  as_of: string | null;
  factor_algorithm_version: string;
  rank_algorithm_version: string;
  validation_status: StockReportQuantValidationStatus;
  quant_signal: StockReportQuantSignal;
  horizons: {
    short_term: StockReportQuantHorizon;
    medium_term: StockReportQuantHorizon;
    long_term: StockReportQuantHorizon;
  };
  source_ids: string[];
  snapshot_hash?: string;
  reason: string;
  promotion_status?: "research_only" | "calibrated" | "rejected";
  promotion_reason?: string;
  eligible_for_trading?: boolean;
  validation_metrics?: Record<string, unknown>;
  method_registry?: Record<string, Record<string, unknown>>;
  target_windows?: Record<string, {
    sessions?: number | null;
    definition?: string | null;
  }>;
  target_window_sessions?: number | null;
  target_definition?: string | null;
}

/** Public V6 quantitative contract returned by the report detail route. */
export interface StockReportV6QuantFactorObservation {
  field: string;
  rawValue: number | null;
  percentileOrRank: number | null;
  direction: "asc" | "desc";
  scope: "industry" | "market_fallback" | "market" | "mixed";
  sampleCount: number;
  missingCount: number;
  asOf: string | null;
  methodVersion: string;
  validationStatus: StockReportQuantValidationStatus;
  sourceCount: number;
}

export interface StockReportV6QuantHorizon {
  status: StockReportQuantValidationStatus | null;
  signal: StockReportQuantSignal | null;
  factorObservations: StockReportV6QuantFactorObservation[];
  methodId?: string | null;
  methodVersion?: string | null;
  targetWindowSessions?: number | null;
  targetDefinition?: string | null;
}

export interface StockReportV6QuantValidation {
  strategyId: string;
  asOf: string | null;
  factorAlgorithmVersion: string;
  rankAlgorithmVersion: string;
  validationStatus: StockReportQuantValidationStatus;
  quantSignal: StockReportQuantSignal;
  horizons: {
    shortTerm: StockReportV6QuantHorizon;
    mediumTerm: StockReportV6QuantHorizon;
    longTerm: StockReportV6QuantHorizon;
  };
  promotionStatus?: "research_only" | "calibrated" | "rejected" | null;
  eligibleForTrading?: boolean | null;
  targetWindowSessions?: number | null;
  targetDefinition?: string | null;
  targetWindows?: Record<string, { sessions?: number | null; definition?: string | null }>;
  methodRegistry?: Record<string, Record<string, unknown>>;
}

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
  /** Optional P7 quantitative verification; old V4 reports omit it. */
  quant_validation?: StockReportQuantValidation | null;
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
  | StockReportV5Document
  | StockReportV6Document
  | StockDigestDocument;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const V5_HORIZON_KEYS = ["shortTerm", "mediumTerm", "longTerm"] as const;
const V5_DIRECTIONS = ["positive", "neutral", "negative"] as const;
const V5_ACTIONS = ["conditional_participation", "wait", "hold", "reduce", "exit", "avoid"] as const;
const V5_NOT_HOLDING_ACTIONS = ["participate", "wait", "avoid"] as const;
const V5_HOLDING_ACTIONS = ["hold", "reduce", "exit"] as const;
const V5_EVIDENCE_STRENGTHS = ["strong", "medium", "weak"] as const;
const V5_INSTRUMENT_TYPES = ["equity", "etf", "index"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDateString(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown, minLength = 1, maxLength = Number.POSITIVE_INFINITY): value is string[] {
  return Array.isArray(value) && value.length >= minLength && value.length <= maxLength && value.every(isNonEmptyString);
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function isPublicInstrument(value: unknown): value is StockReportInstrument {
  if (!isRecord(value)) return false;
  const symbol = value.symbol;
  const exchange = value.exchange;
  const instrumentType = value.instrumentType;
  return (
    typeof value.instrumentId === "string" &&
    typeof symbol === "string" &&
    /^\d{6}$/.test(symbol) &&
    (exchange === "XSHG" || exchange === "XSHE" || exchange === "BJSE") &&
    value.instrumentId === `${exchange}:${symbol}` &&
    typeof value.name === "string" &&
    isOneOf(instrumentType, V5_INSTRUMENT_TYPES)
  );
}

function isV5TradingPlan(value: unknown): value is StockReportV5TradingPlan {
  if (!isRecord(value) || value.currency !== "元") return false;
  const numericFields = [
    "referenceBuyLow", "referenceBuyHigh", "pullbackBuyLow", "pullbackBuyHigh",
    "stopLoss", "firstTakeProfit", "firstReduceFraction", "secondTakeProfit",
    "secondReduceFraction", "riskRewardFirst", "riskRewardSecond",
  ];
  if (!numericFields.every((key) => isFiniteNumber(value[key]))) return false;
  const entry = ((value.referenceBuyLow as number) + (value.referenceBuyHigh as number)) / 2;
  return (
    (value.referenceBuyLow as number) > 0 &&
    (value.referenceBuyLow as number) <= (value.referenceBuyHigh as number) &&
    (value.pullbackBuyLow as number) > 0 &&
    (value.pullbackBuyLow as number) <= (value.pullbackBuyHigh as number) &&
    (value.stopLoss as number) > 0 &&
    (value.stopLoss as number) < entry &&
    (value.firstTakeProfit as number) > entry &&
    (value.secondTakeProfit as number) > (value.firstTakeProfit as number) &&
    (value.firstReduceFraction as number) > 0 &&
    (value.firstReduceFraction as number) <= 1 &&
    (value.secondReduceFraction as number) > 0 &&
    (value.secondReduceFraction as number) <= 1 &&
    (value.firstReduceFraction as number) + (value.secondReduceFraction as number) <= 1 + 1e-8
  );
}

function isV5PositionPlan(value: unknown): value is StockReportV5PositionPlan {
  if (!isRecord(value)) return false;
  const numericFields = ["riskBudgetPct", "initialPositionPct", "maxPositionPct", "stopDistancePct"];
  if (!numericFields.every((key) => isFiniteNumber(value[key]))) return false;
  return (
    (value.riskBudgetPct as number) > 0 &&
    (value.initialPositionPct as number) > 0 &&
    (value.maxPositionPct as number) > 0 &&
    (value.stopDistancePct as number) > 0 &&
    (value.initialPositionPct as number) <= (value.maxPositionPct as number)
  );
}

function isV5HorizonDecision(value: unknown): value is StockReportV5HorizonDecision {
  if (!isRecord(value)) return false;
  const validShape = (
    isOneOf(value.direction, V5_DIRECTIONS) &&
    isOneOf(value.action, V5_ACTIONS) &&
    isNonEmptyString(value.thesis) &&
    isOneOf(value.notHoldingAction, V5_NOT_HOLDING_ACTIONS) &&
    isOneOf(value.holdingAction, V5_HOLDING_ACTIONS) &&
    isV5TradingPlan(value.tradingPlan) &&
    isV5PositionPlan(value.positionPlan) &&
    isDateString(value.validUntil) &&
    isNonEmptyString(value.reviewTrigger) &&
    isStringArray(value.keyReasons, 1, 3) &&
    isStringArray(value.keyRisks, 1, 2) &&
    isOneOf(value.evidenceStrength, V5_EVIDENCE_STRENGTHS) &&
    isDateString(value.marketAsOf) &&
    isDateString(value.generatedAt) &&
    typeof value.isExpired === "boolean"
  );
  if (!validShape) return false;
  if (value.direction === "positive" && ["reduce", "exit", "avoid"].includes(value.action as string)) return false;
  if (value.direction === "negative" && ["conditional_participation", "hold"].includes(value.action as string)) return false;
  if (value.direction === "positive" && value.notHoldingAction === "avoid") return false;
  if (value.direction === "negative" && value.notHoldingAction === "participate") return false;
  if (value.direction === "negative" && value.holdingAction === "hold") return false;
  if (value.direction === "positive" && value.holdingAction === "exit") return false;
  return true;
}

/** Runtime guard for the exact camelCase V5 report detail contract. */
export function isStockReportV5Document(value: unknown): value is StockReportV5Document {
  if (!isRecord(value) || value.schemaVersion !== 5 || value.resultStatus !== "completed") return false;
  const decisions = value.horizonDecisions;
  return (
    isNonEmptyString(value.reportId) &&
    isNonEmptyString(value.runId) &&
    value.kind === "deep_research" &&
    isPublicInstrument(value.instrument) &&
    isNonEmptyString(value.summary) &&
    isDateString(value.researchCutoffAt) &&
    isDateString(value.marketAsOf) &&
    isDateString(value.generatedAt) &&
    typeof value.isExpired === "boolean" &&
    typeof value.hasExpiredHorizon === "boolean" &&
    isRecord(decisions) &&
    V5_HORIZON_KEYS.every((key) => isV5HorizonDecision(decisions[key]))
  );
}

/** Runtime guard for the compact V5 list/dashboard projection. */
export function isStockReportV5Projection(value: unknown): value is StockReportV5ListProjection {
  if (!isRecord(value) || value.schemaVersion !== 5 || value.resultStatus !== "completed") return false;
  const decisions = value.horizonDecisions;
  if (!isDateString(value.researchCutoffAt) || !isDateString(value.marketAsOf) || !isDateString(value.generatedAt)) return false;
  if (typeof value.isExpired !== "boolean" || typeof value.hasExpiredHorizon !== "boolean" || !isRecord(decisions)) return false;
  return V5_HORIZON_KEYS.every((key) => {
    const decision = decisions[key];
    return isRecord(decision) && isOneOf(decision.direction, V5_DIRECTIONS) && isOneOf(decision.action, V5_ACTIONS) && isDateString(decision.validUntil) && typeof decision.isExpired === "boolean";
  });
}

const V6_DIRECTIONS = ["positive", "neutral", "negative", "avoid"] as const;
const V6_DECISION_MODES = ["research_only", "reference_plan"] as const;
const V6_RESEARCH_STATUSES = ["ready", "unavailable"] as const;
const V6_TRADE_STATUSES = ["ready", "unavailable"] as const;
const V6_ACTIONS = ["conditional_participation", "wait", "hold", "reduce", "exit", "avoid"] as const;
const V6_HOLDING_STATES = ["not_holding", "holding"] as const;
const V6_CURRENT_ACTIONS = ["participate", "wait", "hold", "reduce", "exit", "avoid", "execution_blocked"] as const;
const V6_PLAN_STATUSES = ["proxy", "limited", "blocked"] as const;
const V6_EXECUTION_STATUSES = ["proxy", "limited", "blocked"] as const;

function isV6Plan(value: unknown): value is StockReportV6MaterializedPlan | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const numericFields = [
    "buyLow", "buyHigh", "pullbackLow", "pullbackHigh", "confirmationPrice",
    "invalidationPrice", "exitPrice", "reentryConfirmationPrice", "stopLoss",
    "firstTakeProfit", "secondTakeProfit", "initialPositionPct", "maxPositionPct",
    "targetMaxPositionPct", "additionalPositionPct", "liquidityCapPct", "riskBudgetPct",
    "riskRewardFirstAfterCost", "riskRewardSecondAfterCost",
  ];
  return (
    (value.direction == null || isOneOf(value.direction, V6_DIRECTIONS)) &&
    (value.action == null || isOneOf(value.action, V6_ACTIONS)) &&
    (value.holdingState == null || isOneOf(value.holdingState, V6_HOLDING_STATES)) &&
    (value.currentAction == null || isOneOf(value.currentAction, V6_CURRENT_ACTIONS)) &&
    (value.planStatus == null || isOneOf(value.planStatus, V6_PLAN_STATUSES)) &&
    numericFields.every((key) => value[key] == null || isFiniteNumber(value[key])) &&
    (value.riskProfileConfigured == null || typeof value.riskProfileConfigured === "boolean") &&
    (value.positionCapReasons == null || isStringArray(value.positionCapReasons, 0)) &&
    (value.executionMode == null || value.executionMode === "research_only") &&
    (value.execution == null || (isRecord(value.execution) && (value.execution.executionStatus == null || isOneOf(value.execution.executionStatus, V6_EXECUTION_STATUSES))))
  );
}

function isV6HorizonDecision(value: unknown): value is StockReportV6HorizonDecision {
  if (!isRecord(value)) return false;
  return (
    isOneOf(value.direction, V6_DIRECTIONS) &&
    isOneOf(value.action, V6_ACTIONS) &&
    isNonEmptyString(value.thesis) &&
    isStringArray(value.keyReasons, 1, 3) &&
    isStringArray(value.keyRisks, 1, 2) &&
    isOneOf(value.researchStatus, V6_RESEARCH_STATUSES) &&
    isOneOf(value.tradeStatus, V6_TRADE_STATUSES) &&
    isV6Plan(value.materializedPlan) &&
    (value.validUntil == null || isDateString(value.validUntil)) &&
    (value.reviewTrigger == null || isNonEmptyString(value.reviewTrigger))
  );
}

/** Runtime guard for the public V6 detail projection. */
export function isStockReportV6Document(value: unknown): value is StockReportV6Document {
  if (!isRecord(value) || value.schemaVersion !== 6 || value.resultStatus !== "completed") return false;
  const decisions = value.horizonDecisions;
  return (
    isNonEmptyString(value.reportId) &&
    isNonEmptyString(value.runId) &&
    value.kind === "deep_research" &&
    isPublicInstrument(value.instrument) &&
    isOneOf(value.decisionMode, V6_DECISION_MODES) &&
    isOneOf(value.researchStatus, V6_RESEARCH_STATUSES) &&
    isOneOf(value.tradeStatus, V6_TRADE_STATUSES) &&
    isNonEmptyString(value.summary) &&
    isDateString(value.researchCutoffAt) &&
    isDateString(value.marketAsOf) &&
    isDateString(value.generatedAt) &&
    (value.currentPrice == null || isFiniteNumber(value.currentPrice)) &&
    (value.benchmarkPrice == null || isFiniteNumber(value.benchmarkPrice)) &&
    isRecord(decisions) &&
    V5_HORIZON_KEYS.every((key) => isV6HorizonDecision(decisions[key]))
  );
}

/** Runtime guard for the compact V6 list/dashboard projection. */
export function isStockReportV6Projection(value: unknown): value is StockReportV6ListProjection {
  if (!isRecord(value) || value.schemaVersion !== 6 || value.resultStatus !== "completed") return false;
  const decisions = value.horizonDecisions;
  if (!isOneOf(value.decisionMode, V6_DECISION_MODES) || !isOneOf(value.researchStatus, V6_RESEARCH_STATUSES) || !isOneOf(value.tradeStatus, V6_TRADE_STATUSES)) return false;
  if (!isDateString(value.researchCutoffAt) || !isDateString(value.marketAsOf) || !isRecord(decisions)) return false;
  return V5_HORIZON_KEYS.every((key) => {
    const decision = decisions[key];
    return isRecord(decision) && isOneOf(decision.direction, V6_DIRECTIONS) && isOneOf(decision.action, V6_ACTIONS) && isOneOf(decision.researchStatus, V6_RESEARCH_STATUSES) && isOneOf(decision.tradeStatus, V6_TRADE_STATUSES);
  });
}

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

/** Standard single-agent diagnosis contract (StockDiagnosisV1).  It is kept
 * separate from the deep-research report types so the two histories cannot be
 * rendered as one product. */
export type StockDiagnosisStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type StockDiagnosisDirection = "positive" | "neutral" | "negative" | "unavailable";
export type StockDiagnosisAction = "conditional_participation" | "wait" | "hold" | "reduce" | "exit" | "avoid";
export type StockDiagnosisValidationStatus = "descriptive" | "calibrated" | "rejected" | "unavailable";

export interface StockDiagnosisClaim {
  text?: string;
  claim?: string;
  source_ids?: string[];
  claim_type?: "fact" | "inference" | "hypothesis" | string;
}

export interface StockDiagnosisFactor {
  name: string;
  value?: number | null;
  percentile?: number | null;
  direction?: StockDiagnosisDirection | null;
  group?: string | null;
  unit?: string | null;
  comparison_scope?: string | null;
  as_of?: string | null;
  weight?: number | null;
  contribution?: number | null;
  source_ids?: string[];
}

export interface StockDiagnosisFactorHorizon {
  status?: "available" | "degraded" | "unavailable";
  validation_status?: StockDiagnosisValidationStatus;
  promotion_status?: "calibrated" | "research_only" | "rejected" | "unavailable";
  validation_reason?: string | null;
  validation_metrics?: Record<string, unknown>;
  target_window_sessions?: number | null;
  factor_score?: number | null;
  market_percentile?: number | null;
  industry_percentile?: number | null;
  rank?: number | null;
  sample_count?: number | null;
  industry_sample_count?: number | null;
  missing_count?: number | null;
  fallback_scope?: "none" | "market" | "unavailable";
  factors?: StockDiagnosisFactor[];
  factor_contributions?: Record<string, number>;
  method_version?: string;
  source_ids?: string[];
}

export interface StockDiagnosisFactorSnapshot {
  short_term: StockDiagnosisFactorHorizon;
  medium_term: StockDiagnosisFactorHorizon;
  long_term: StockDiagnosisFactorHorizon;
  snapshot_as_of?: string | null;
  universe_definition?: string | null;
  content_hash?: string | null;
  sample_count?: number | null;
  missing_count?: number | null;
  source_ids?: string[];
}

export interface StockDiagnosisMaterializedPlan {
  reference_entry?: number | null;
  reference_entry_low?: number | null;
  reference_entry_high?: number | null;
  pullback_entry?: number | null;
  pullback_entry_low?: number | null;
  pullback_entry_high?: number | null;
  stop_loss?: number | null;
  first_take_profit?: number | null;
  second_take_profit?: number | null;
  risk_reference_price?: number | null;
  risk_per_share?: number | null;
  risk_pct?: number | null;
  first_reward_pct?: number | null;
  second_reward_pct?: number | null;
  risk_reward_first?: number | null;
  risk_reward_second?: number | null;
  risk_reward_method_version?: string | null;
  risk_reward_first_after_cost?: number | null;
  risk_reward_second_after_cost?: number | null;
  risk_reward_first_after_fees?: number | null;
  risk_reward_second_after_fees?: number | null;
  estimated_slippage_pct?: number | null;
  cost_assumptions?: Record<string, unknown>;
  cost_scope?: "fees_and_slippage_proxy" | "unavailable";
  cost_method_version?: string | null;
  slippage_method_version?: string | null;
  minimum_risk_reward_first?: number;
  minimum_risk_reward_second?: number;
  risk_reward_gate_status?: "passed" | "failed" | "unavailable";
  risk_reward_gate_method_version?: string;
  fee_gate_status?: "passed" | "failed" | "unavailable";
  fee_gate_method_version?: string;
  slippage_stress_status?: "passed" | "failed" | "unavailable";
  slippage_stress_method_version?: string;
  entry_condition_status?: "triggered" | "not_triggered" | "unavailable";
  entry_condition?: string | null;
  entry_condition_count?: number;
  entry_condition_realtime_eligible?: boolean;
  value_status?: "available" | "partial" | "unavailable";
  unavailable_fields?: string[];
  invalidation?: string[];
  boundaries?: string[];
  max_risk_pct?: number | null;
  source_ids?: string[];
}

export interface StockDiagnosisPositionPlan {
  reference_position_pct?: number | null;
  max_position_pct?: number | null;
  risk_budget_pct?: number | null;
  stop_distance_pct?: number | null;
  volatility_adjustment?: number | null;
  liquidity_cap_pct?: number | null;
  conservative_risk_cap_pct?: number | null;
  calculation_method?: string | null;
  calculation_version?: string | null;
  risk_cap_method_version?: string | null;
  value_status?: "available" | "partial" | "unavailable";
  source_ids?: string[];
}

export interface StockDiagnosisSourceRecord {
  id: string;
  provider: string;
  url: string;
  published_at?: string | null;
  period_end?: string | null;
}

export interface StockDiagnosisHorizonDecision {
  direction: StockDiagnosisDirection;
  action: StockDiagnosisAction;
  decision_score?: number | null;
  positive_threshold?: number;
  negative_threshold?: number;
  component_scores?: Record<string, number>;
  component_weights?: Record<string, number>;
  factor_score?: number | null;
  market_percentile?: number | null;
  industry_percentile?: number | null;
  factor_contributions?: Record<string, number>;
  validation_status: StockDiagnosisValidationStatus;
  not_holding_action: StockDiagnosisAction;
  holding_action: StockDiagnosisAction;
  current_action?: "wait" | "participate" | "hold" | "reduce" | "exit" | "avoid";
  thesis?: string | null;
  materialized_plan: StockDiagnosisMaterializedPlan;
  position_plan: StockDiagnosisPositionPlan;
  review_trigger?: string;
  valid_until?: string | null;
  key_reasons?: StockDiagnosisClaim[];
  key_risks?: StockDiagnosisClaim[];
  confidence?: "high" | "medium" | "low";
  source_ids?: string[];
}

export interface StockDiagnosisFundamentalResearch {
  status: "available" | "degraded" | "unavailable";
  business_understandable?: boolean | null;
  company_understanding?: string | null;
  business_model?: string | null;
  business_model_summary?: string | null;
  revenue_sources?: string[];
  competitive_advantages?: StockDiagnosisClaim[];
  competitive_advantage?: StockDiagnosisClaim[];
  competitive_counterevidence?: StockDiagnosisClaim[];
  competitive_advantage_counterevidence?: StockDiagnosisClaim[];
  management_governance?: StockDiagnosisClaim[];
  governance?: StockDiagnosisClaim[];
  industry_supply_demand?: StockDiagnosisClaim[];
  industry_context?: StockDiagnosisClaim[];
  policy_transmission?: StockDiagnosisClaim[];
  policy_context?: StockDiagnosisClaim[];
  cycle_position?: StockDiagnosisClaim[];
  cycle_context?: StockDiagnosisClaim[];
  key_assumptions?: StockDiagnosisClaim[];
  risks?: StockDiagnosisClaim[];
  conclusion_change_conditions?: StockDiagnosisClaim[];
  change_conditions?: StockDiagnosisClaim[];
  source_ids?: string[];
}

export interface StockDiagnosisDecisionBasisRow {
  key: "fundamental" | "quant" | "sentiment" | "risk";
  label: string;
  stance: "positive" | "neutral" | "cautious" | "negative" | "strict";
  stance_label: string;
  summary: string;
  source_ids?: string[];
}

export interface StockDiagnosisV1 {
  schema_version: 1;
  kind: "ai_diagnosis";
  diagnosis_id: string;
  instrument: StockRawReportInstrument;
  research_cutoff_at: string;
  market_as_of?: string | null;
  current_price?: number | null;
  price_source_ids?: string[];
  generated_at: string;
  evidence_context_id: string;
  source_ids: string[];
  sources?: StockDiagnosisSourceRecord[];
  data_quality: {
    status: "complete" | "available" | "degraded" | "unavailable";
    confidence: "high" | "medium" | "low";
    missing_fields?: string[];
    degraded_fields?: string[];
    sample_counts?: Record<string, number>;
  };
  fundamental_research: StockDiagnosisFundamentalResearch;
  fundamental_factors: StockDiagnosisFactorSnapshot;
  quant_factors: StockDiagnosisFactorSnapshot;
  technical_execution: {
    status: "available" | "degraded" | "unavailable";
    horizons?: Record<string, StockDiagnosisMaterializedPlan>;
    position?: Record<string, StockDiagnosisPositionPlan>;
    review_triggers?: Record<string, string>;
    valid_until?: Record<string, string | null>;
    source_ids?: string[];
  };
  horizon_decisions: {
    short_term: StockDiagnosisHorizonDecision;
    medium_term: StockDiagnosisHorizonDecision;
    long_term: StockDiagnosisHorizonDecision;
  };
  decision_radar: {
    current_decision?: StockDiagnosisHorizonDecision | null;
    basis_rows?: StockDiagnosisDecisionBasisRow[];
    short_term: StockDiagnosisHorizonDecision;
    medium_term: StockDiagnosisHorizonDecision;
    long_term: StockDiagnosisHorizonDecision;
    holding_state?: "not_holding" | "holding";
    overall_confidence?: "high" | "medium" | "low";
    deterministic?: boolean;
  };
  method_versions?: Record<string, string>;
}

export interface StockDiagnosisRun {
  diagnosisId: string;
  workflowId: string;
  status: StockDiagnosisStatus;
  instrument: StockRawReportInstrument;
  evidenceContextId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  attempt?: number;
  agentSteps?: Array<Record<string, unknown>>;
  agentStepCount?: number;
  llmAgentSteps?: number;
  inputHash?: string | null;
  holdingState?: "not_holding" | "holding";
  error?: string | null;
  errorCode?: string | null;
  report?: StockDiagnosisV1;
  markdown?: string;
}

export interface StockDiagnosisOutcome {
  schemaVersion: 1;
  diagnosisId: string;
  trackingId: string;
  status: "pending" | "available";
  outcomeLabel: string;
  windowSessions: number;
  observedSessions: number;
  reportAsOf?: string | null;
  observationStartDate?: string | null;
  exitDate?: string | null;
  referencePrice?: number | null;
  direction?: StockDiagnosisDirection | null;
  action?: StockDiagnosisAction | null;
  directionReturnPct?: number | null;
  directionMfePct?: number | null;
  directionMaePct?: number | null;
  directionHit?: boolean | null;
  tradeStatus?: "entered" | "not_entered" | "not_applicable" | "research_only" | null;
  entryDate?: string | null;
  entryPrice?: number | null;
  firstTriggerType?: "ambiguous_same_bar" | "stop_loss" | "first_take_profit" | "second_take_profit" | null;
  firstTriggerDate?: string | null;
  conservativeRule?: string | null;
  tradeReturnPct?: number | null;
  tradeMfePct?: number | null;
  tradeMaePct?: number | null;
  calculatedAt?: string | null;
  calculationVersion: string;
  dailyBarProxy: boolean;
}

export const STOCK_DIAGNOSIS_ROOM_CHAT_ID = "stock_ai_diagnosis";

export function isStockDiagnosisV1Document(value: unknown): value is StockDiagnosisV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema_version === 1 && record.kind === "ai_diagnosis"
    && typeof record.diagnosis_id === "string"
    && typeof record.research_cutoff_at === "string"
    && typeof record.generated_at === "string"
    && record.horizon_decisions != null;
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

export type StockRiskLevel = "conservative" | "balanced" | "aggressive";
export type StockFundsRange = "under_100k" | "100k_500k" | "500k_2m" | "over_2m";

export interface StockRiskProfile {
  profile_name: string;
  configured: boolean;
  risk_level: StockRiskLevel;
  max_drawdown_tolerance_pct: number;
  total_funds_range: StockFundsRange | null;
  risk_budget_pct: number;
  max_single_position_pct: number;
  max_industry_exposure_pct: number;
  max_correlated_exposure_pct: number;
}

export interface StockRiskProfileResponse {
  profile: StockRiskProfile;
  configured: boolean;
  riskLevelLabel?: string;
  displayMetadata?: Record<string, unknown>;
  storage?: { localOnly?: boolean; brokerConnected?: boolean };
}

export type StockHoldingState = "not_holding" | "holding";
export type StockPositionInputMode = "percentage" | "assets_shares";

export interface StockPortfolioContext {
  holding_state: StockHoldingState;
  /** New UI input mode; omitted by older stored contexts. */
  position_input_mode?: StockPositionInputMode;
  holding_quantity?: number | null;
  portfolio_value_yuan?: number | null;
  current_position_pct: number;
  industry_exposure_pct: number;
  correlated_exposure_pct: number;
  today_bought_quantity: number | null;
  holding_cost: number | null;
  portfolio_value_configured?: boolean;
}

export interface StockPortfolioContextResponse {
  instrumentId: string;
  context: StockPortfolioContext;
  configured: boolean;
  storage?: { localOnly?: boolean; brokerConnected?: boolean };
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

const DECISION_HORIZON_KEYS: StockDecisionHorizonKey[] = ["shortTerm", "mediumTerm", "longTerm"];
const DECISION_GROUP_LABELS: Record<StockDecisionConditionGroup, string> = {
  participation: "参与条件",
  confirmation: "确认条件",
  watch: "观察条件",
  invalidation: "退出条件",
  stop_loss: "止损条件",
  take_profit: "止盈条件",
  other: "其他条件",
};
const DECISION_STATUS_LABELS: Record<StockDecisionConditionStatus, "已满足" | "未满足" | "暂无法判断"> = {
  matched: "已满足",
  not_matched: "未满足",
  not_evaluable: "暂无法判断",
};

function safeDecisionReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && !/[A-Za-z_]{2,}/.test(text) ? text : null;
}

function normalizeDecisionCondition(value: unknown): StockDecisionConditionEvaluation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const rawGroup = typeof raw.group === "string" ? raw.group.replace(/_conditions$/, "") : "";
  const group = (Object.prototype.hasOwnProperty.call(DECISION_GROUP_LABELS, rawGroup)
    ? rawGroup
    : "other") as StockDecisionConditionGroup;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) return null;
  const status = raw.status === "matched" || raw.status === "not_matched" || raw.status === "not_evaluable"
    ? raw.status
    : "not_evaluable";
  return {
    group,
    groupLabel: DECISION_GROUP_LABELS[group],
    text,
    sourceIds: Array.isArray(raw.sourceIds)
      ? raw.sourceIds.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
    status,
    statusLabel: DECISION_STATUS_LABELS[status],
    evaluatedAt: typeof raw.evaluatedAt === "string" ? raw.evaluatedAt : null,
    methodVersion: typeof raw.methodVersion === "string" ? raw.methodVersion : null,
    reason: safeDecisionReason(raw.reason),
  };
}

function normalizeDecisionRiskReward(value: unknown): StockDecisionRiskRewardEvaluation {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const status = raw.status === "matched" || raw.status === "not_matched" || raw.status === "not_evaluable"
    ? raw.status
    : "not_evaluable";
  const ratio = typeof raw.ratio === "number" && Number.isFinite(raw.ratio) ? raw.ratio : null;
  const direction = raw.direction === "long" || raw.direction === "short" ? raw.direction : "unknown";
  return {
    status,
    statusLabel: DECISION_STATUS_LABELS[status],
    ratio,
    direction,
    evaluatedAt: typeof raw.evaluatedAt === "string" ? raw.evaluatedAt : null,
    methodVersion: typeof raw.methodVersion === "string" ? raw.methodVersion : null,
    reason: safeDecisionReason(raw.reason),
  };
}

function normalizeDecisionEvaluation(value: unknown): StockDecisionEvaluation {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawHorizons = raw.horizons && typeof raw.horizons === "object" && !Array.isArray(raw.horizons)
    ? raw.horizons as Record<string, unknown>
    : {};
  const horizons: StockDecisionEvaluation["horizons"] = {};
  for (const key of DECISION_HORIZON_KEYS) {
    const rawHorizon = rawHorizons[key];
    if (!rawHorizon || typeof rawHorizon !== "object" || Array.isArray(rawHorizon)) continue;
    const horizon = rawHorizon as Record<string, unknown>;
    const conditions = Array.isArray(horizon.conditions)
      ? horizon.conditions.map(normalizeDecisionCondition).filter((item): item is StockDecisionConditionEvaluation => item != null)
      : [];
    horizons[key] = {
      conditions,
      riskReward: normalizeDecisionRiskReward(horizon.riskReward),
    };
  }
  return {
    reportId: typeof raw.reportId === "string" ? raw.reportId : null,
    evaluatedAt: typeof raw.evaluatedAt === "string" ? raw.evaluatedAt : null,
    methodVersion: typeof raw.methodVersion === "string" ? raw.methodVersion : "",
    horizons,
  };
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

export async function fetchStockRiskProfile(): Promise<StockRiskProfileResponse> {
  return servicesFetch<StockRiskProfileResponse>("/api/stock/risk-profile", { method: "GET" });
}

export async function saveStockRiskProfile(profile: Omit<StockRiskProfile, "configured" | "profile_name"> & Partial<Pick<StockRiskProfile, "profile_name">>): Promise<StockRiskProfileResponse> {
  return servicesFetch<StockRiskProfileResponse>(
    "/api/stock/risk-profile",
    jsonInit("PUT", { profile }),
  );
}

export async function deleteStockRiskProfile(): Promise<StockRiskProfileResponse> {
  return servicesFetch<StockRiskProfileResponse>("/api/stock/risk-profile", { method: "DELETE" });
}

export async function fetchStockPortfolioContext(instrumentId: string): Promise<StockPortfolioContextResponse> {
  return servicesFetch<StockPortfolioContextResponse>(
    `/api/stock/portfolio-context?instrumentId=${encodeURIComponent(instrumentId)}`,
    { method: "GET" },
  );
}

export async function saveStockPortfolioContext(
  instrumentId: string,
  context: StockPortfolioContext,
): Promise<StockPortfolioContextResponse> {
  return servicesFetch<StockPortfolioContextResponse>(
    `/api/stock/portfolio-context?instrumentId=${encodeURIComponent(instrumentId)}`,
    jsonInit("PUT", { instrumentId, context }),
  );
}

export async function deleteStockPortfolioContext(instrumentId: string): Promise<StockPortfolioContextResponse> {
  return servicesFetch<StockPortfolioContextResponse>(
    `/api/stock/portfolio-context?instrumentId=${encodeURIComponent(instrumentId)}`,
    { method: "DELETE" },
  );
}

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

export async function fetchStockDecisionConditions(
  _token: string,
  reportId: string,
): Promise<StockDecisionEvaluation> {
  const data = await servicesFetch<unknown>(
    `/api/stock/decision-conditions?reportId=${encodeURIComponent(reportId)}`,
    { method: "GET" },
  );
  return normalizeDecisionEvaluation(data);
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

// --- standard AI diagnosis (services port) ---

export async function fetchStockDiagnoses(
  instrumentId?: string,
  status?: StockDiagnosisStatus,
): Promise<StockDiagnosisRun[]> {
  const query = new URLSearchParams();
  if (instrumentId) query.set("instrumentId", instrumentId);
  if (status) query.set("status", status);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  const data = await servicesFetch<{ items?: StockDiagnosisRun[] }>(
    `/api/stock/diagnosis${suffix}`,
    { method: "GET" },
  );
  return Array.isArray(data.items) ? data.items : [];
}

export async function fetchStockDiagnosis(
  diagnosisId: string,
): Promise<StockDiagnosisRun> {
  return servicesFetch<StockDiagnosisRun>(
    `/api/stock/diagnosis/${encodeURIComponent(diagnosisId)}`,
    { method: "GET" },
  );
}

export async function fetchStockDiagnosisOutcome(
  diagnosisId: string,
): Promise<StockDiagnosisOutcome> {
  return servicesFetch<StockDiagnosisOutcome>(
    `/api/stock/diagnosis/${encodeURIComponent(diagnosisId)}/outcome`,
    { method: "GET" },
  );
}

export async function deleteStockDiagnosis(
  diagnosisId: string,
): Promise<void> {
  await servicesFetch<{ deleted: string }>(
    `/api/stock/diagnosis/${encodeURIComponent(diagnosisId)}`,
    { method: "DELETE" },
  );
}

/** Direct standard-diagnosis API entry point for callers that do not use the
 * hidden workflow. The stock workbench uses the hidden workflow for the
 * cancellable run and reads its StockDiagnosisV1 result through this API. */
export async function createStockDiagnosis(
  instrumentId: string,
  options: {
    evidenceContextId?: string;
    holdingState?: "not_holding" | "holding";
    execute?: boolean;
  } = {},
): Promise<StockDiagnosisRun> {
  return servicesFetch<StockDiagnosisRun>(
    "/api/stock/diagnosis",
    jsonInit("POST", {
      instrumentId,
      ...(options.evidenceContextId ? { evidenceContextId: options.evidenceContextId } : {}),
      holdingState: options.holdingState ?? "not_holding",
      execute: options.execute ?? true,
    }),
  );
}

export async function cancelStockDiagnosis(
  diagnosisId: string,
): Promise<StockDiagnosisRun> {
  return servicesFetch<StockDiagnosisRun>(
    `/api/stock/diagnosis/${encodeURIComponent(diagnosisId)}/cancel`,
    jsonInit("POST", { reason: "用户取消AI诊股" }),
  );
}

export async function retryStockDiagnosis(
  diagnosisId: string,
  execute = true,
): Promise<StockDiagnosisRun> {
  return servicesFetch<StockDiagnosisRun>(
    `/api/stock/diagnosis/${encodeURIComponent(diagnosisId)}/retry`,
    jsonInit("POST", { execute }),
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
