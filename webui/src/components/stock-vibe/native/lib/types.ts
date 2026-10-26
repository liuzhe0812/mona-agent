// Selected original Vibe interfaces and their recursive type dependencies.


// --- Types matching backend API contracts ---

export interface RunListItem {
  run_id: string;
  status: string;
  created_at: string;
  prompt?: string;
  total_return?: number;
  sharpe?: number;
  codes?: string[];
  start_date?: string;
  end_date?: string;
}


export interface PriceBar {
  time: string;
  timestamp?: string;
  code?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}


export interface TradeMarker {
  time: string;
  timestamp?: string;
  code?: string;
  side: "BUY" | "SELL";
  price: number;
  qty?: number;
  reason?: string;
  text?: string;
}


export interface EquityPoint {
  time: string;
  equity: string | number;
  drawdown: string | number;
}


/** Monte Carlo fan-chart payload: percentile envelope + sampled paths over trade order. */
export interface MonteCarloEquityPaths {
  steps: number[];
  initial_capital: number;
  actual: number[];
  band_p5: number[];
  band_p25: number[];
  band_p50: number[];
  band_p75: number[];
  band_p95: number[];
  samples: number[][];
}


export interface ValidationData {
  monte_carlo?: {
    actual_sharpe: number;
    actual_max_dd: number;
    p_value_sharpe: number;
    p_value_max_dd: number;
    simulated_sharpe_mean: number;
    simulated_sharpe_std: number;
    simulated_sharpe_p5: number;
    simulated_sharpe_p95: number;
    n_simulations: number;
    n_trades: number;
    sharpe_samples?: number[];
    equity_paths?: MonteCarloEquityPaths;
    error?: string;
  };
  bootstrap?: {
    observed_sharpe: number;
    ci_lower: number;
    ci_upper: number;
    median_sharpe: number;
    prob_positive: number;
    confidence: number;
    n_bootstrap: number;
    sharpe_samples?: number[];
    error?: string;
  };
  walk_forward?: {
    n_windows: number;
    windows: Array<{
      window: number;
      start: string;
      end: string;
      return: number;
      sharpe: number;
      max_dd: number;
      trades: number;
      win_rate: number;
    }>;
    profitable_windows: number;
    consistency_rate: number;
    return_mean: number;
    return_std: number;
    sharpe_mean: number;
    sharpe_std: number;
    error?: string;
  };
}


export interface RiskXRayPayload {
  inputs?: {
    symbols?: string[];
    weights?: Record<string, number>;
    aligned_days?: number;
    return_observations?: number;
    first_date?: string;
    last_date?: string;
  };
  concentration?: { hhi?: number; effective_n?: number; top_weight?: number };
  volatility?: { annualized_vol?: number };
  drawdown?: { max_drawdown?: number };
  tail_risk?: Record<string, unknown>;
  diversification?: Record<string, unknown>;
  correlation?: Record<string, unknown>;
  skipped?: string[];
  warnings?: string[];
}


export interface RebalanceNotesPayload {
  rebalances?: Array<{
    date: string;
    turnover: number;
    entries?: Array<{ code: string; to: number }>;
    exits?: Array<{ code: string; from: number }>;
    top_moves?: Array<{ code: string; from: number; to: number; delta: number }>;
  }>;
  summary?: {
    target_change_count: number;
    /** Legacy key on runs produced before the #1275 execution-evidence fix. */
    rebalance_count?: number;
    turnover_total: number;
    turnover_mean: number;
    turnover_max: number;
    largest_rebalance_date?: string | null;
    rebalance_executed_bars?: number;
    rebalance_executed_fills?: number;
    rebalance_realized_turnover?: number;
  };
}


export interface FactorIcStats {
  ic_mean?: number | null;
  ic_std?: number | null;
  ir?: number | null;
  ic_positive_ratio?: number | null;
  ic_count?: number | null;
  [key: string]: unknown;
}


export interface FactorResult {
  name: string;
  path: string;
  ic_series: Array<{ date: string; ic: number }>;
  ic_stats?: FactorIcStats;
  group_equity: Array<{ date: string } & Record<string, number | string>>;
  n_groups: number;
  long_short_spread: number | null;
  group_final_equity: Record<string, number>;
  truncated?: {
    ic_series?: boolean;
    ic_stats?: boolean;
    group_equity?: boolean;
  };
}


export interface FactorReportPayload {
  exists: boolean;
  factors: FactorResult[];
  ic_correlation: { labels: string[]; matrix: number[][] } | null;
}


export interface RunData {
  status: string;
  run_id: string;
  prompt?: string;
  elapsed_seconds?: number;
  run_directory?: string;
  run_stage?: string;
  run_context?: Record<string, unknown>;

  metrics?: BacktestMetrics;
  artifacts?: ArtifactInfo[];
  run_card?: RunCard;
  risk_xray?: RiskXRayPayload;
  rebalance_notes?: RebalanceNotesPayload;
  validation?: ValidationData;
  has_factor_artifacts?: boolean;

  chart_symbols?: string[];
  price_series?: Record<string, PriceBar[]>;
  indicator_series?: Record<string, Record<string, IndicatorPoint[]>>;
  trade_markers?: TradeMarker[];
  equity_curve?: EquityPoint[];
  trade_log?: Array<Record<string, string>>;
  /** Full equity.csv rows (timestamp/equity/drawdown as strings); not capped like equity_curve. */
  artifacts_equity_csv?: Array<Record<string, string>>;
  artifacts_metrics_csv?: Array<Record<string, string>>;
  artifacts_trades_csv?: Array<Record<string, string>>;
  /** Filled portfolio weights per date (rows: {timestamp, <symbol>: weight-string}). */
  artifacts_positions_csv?: Array<Record<string, string>>;
  /** Requested target weights per date, same row shape as artifacts_positions_csv. */
  artifacts_target_positions_csv?: Array<Record<string, string>>;
  run_logs?: Array<{ source?: string; line_number?: number; message?: string }>;
}


export interface RunCardToolTrace {
  tool: "backtest" | "load_data" | "generate_signals";
  started_at: string;
  ended_at: string;
  status: "ok" | "error" | "cancelled";
  args_hash: string;
  result_hash: string;
}


export interface RunCardCitation {
  metric: string;
  artifact_id: string;
  column: string;
  /** One-based data row, excluding the CSV header. */
  row: number;
  sha256: string;
}


export interface RunCard {
  schema_version?: string;
  generated_at?: string;
  run_dir?: string;
  backtest?: Record<string, unknown>;
  reproducibility?: Record<string, unknown>;
  data_sources?: string[];
  metrics?: Record<string, unknown>;
  // Carried alongside `metrics`, which is scalar-only: dict/list-shaped metrics
  // (e.g. which sleeve a plan rejection dropped) reach the card here.
  structured_metrics?: Record<string, unknown>;
  validation?: unknown;
  warnings?: string[];
  artifacts?: RunCardArtifact[];
  tool_traces?: RunCardToolTrace[];
  citations?: RunCardCitation[];
  [key: string]: unknown;
}


export interface RunCardArtifact {
  path: string;
  size_bytes: number;
  sha256: string;
}


export interface BacktestMetrics {
  final_value: number;
  total_return: number;
  annual_return: number;
  max_drawdown: number;
  sharpe: number;
  win_rate: number;
  trade_count: number;
  [key: string]: number;
}



export interface IndicatorPoint {
  time: string;
  value: number;
}


export interface ArtifactInfo {
  name: string;
  path: string;
  type: string;
  size: number;
  exists: boolean;
}


// --- Alpha Zoo types ---

export interface AlphaListParams {
  zoo?: string;
  theme?: string;
  universe?: string;
  limit?: number;
}


export interface AlphaSummary {
  id: string;
  zoo: string;
  theme: string[];
  universe: string[];
  nickname?: string;
  decay_horizon?: number | null;
  min_warmup_bars?: number | null;
  requires_sector?: boolean;
}


export interface AlphaListResponse {
  status: string;
  alphas: AlphaSummary[];
  total: number;
  returned: number;
  truncated: boolean;
}


export interface AlphaDetail {
  id: string;
  zoo: string;
  module_path?: string;
  meta: Record<string, unknown>;
}


export interface AlphaDetailResponse {
  status: string;
  alpha: AlphaDetail;
  source_code: string;
}


export interface AlphaBenchRequest {
  request_id?: string;
  zoo: string;
  universe: string;
  period: string;
  top?: number;
  alpha_id?: string;
}


export interface AlphaReadiness {
  universes: Record<string, { ready: boolean; reason: "public_data" | "tushare_ready" | "tushare_token_missing" | "tushare_dependency_missing" | "single_asset" }>;
  zoo_counts: Record<string, number>;
}


export interface AlphaProgress { n_done: number; n_total: number; current_alpha_id?: string; stage?: "loading_data" | "preparing_returns" | "computing" }

export interface AlphaJobSnapshot<T> { job_id: string; status: "queued" | "running" | "done" | "error"; progress: AlphaProgress; result: T | null; error: string | null }


export interface AlphaBenchTopRow {
  id: string;
  ic_mean: number;
  ir: number;
  theme: string[];
  formula_latex: string;
  category: "alive" | "reversed" | "dead";
}


export interface AlphaDataMeta {
  fetched_instruments?: number;
  requested_instruments?: number;
  missing_instruments?: string[];
  survivorship_bias?: boolean;
  degraded?: boolean;
}


export interface AlphaBenchResult {
  n_alphas_tested?: number;
  meta?: AlphaDataMeta;
  alive: number;
  reversed: number;
  dead: number;
  skipped?: number;
  top5_by_ir: AlphaBenchTopRow[];
  dead_examples: AlphaBenchTopRow[];
  by_theme: Record<string, { alive: number; reversed: number; dead: number }>;
}


export interface AlphaCompareRequest {
  request_id?: string;
  alpha_ids: string[];
  universe: string;
  period: string;
  /** One of: ir | ic_mean | ic_positive_ratio | ic_count (default ir). */
  sort?: string;
}


export interface AlphaCompareRow {
  rank: number;
  id: string;
  zoo: string;
  ic_mean: number;
  ic_std: number;
  ir: number;
  ic_positive_ratio: number;
  ic_count: number;
  /** `delta_<sort>_vs_best` — gap to the top-ranked alpha on the active metric. */
  [deltaKey: string]: number | string;
}


export interface AlphaCompareSkip {
  id: string;
  reason: string;
}


export interface AlphaCompareResult {
  meta?: AlphaDataMeta;
  universe: string;
  period: string;
  sort: string;
  n_compared: number;
  n_skipped: number;
  winner: string;
  ranking: AlphaCompareRow[];
  skipped: AlphaCompareSkip[];
}
