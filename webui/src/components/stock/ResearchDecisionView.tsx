import { useState } from "react";
import type { ReactNode } from "react";

import type {
  StockClaimType,
  StockCycleState,
  StockDimensionKey,
  StockHorizonCondition,
  StockHorizonView,
  StockMarketBreadthProjection,
  StockPublicActivityProjection,
  StockPublicDisclosureSignal,
  StockReportDocument,
  StockReportQuantFactorObservation,
  StockReportQuantHorizon,
  StockReportQuantValidation,
  StockReportV6QuantValidation,
  StockReportV4Document,
  StockReportV6Document,
  StockReportV6HorizonDecision,
  StockDiagnosisV1,
  StockDiagnosisDecisionBasisRow,
  StockDiagnosisFactor,
  StockDiagnosisFactorHorizon,
  StockDiagnosisHorizonDecision,
  StockSelectionOrigin,
  StockScenario,
  StockStance,
  StockSummarySection,
  StockViewPoint,
} from "@/lib/stock-api";
import { isStockReportV6Document } from "@/lib/stock-api";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { evidenceCountLabel, evidenceStrengthLabel, evidenceTextLabel, factorLabel, fieldLabel, missingFieldsLabel, stanceLabel, thesisLabel } from "./labels";
import { DebateResolutionPanel, ResearchEvidenceDetail, ValuationAnalysis } from "./ResearchEvidenceDetail";
import { OutcomeCalibrationPanel } from "./OutcomeCalibrationPanel";

type HorizonKey = "short_term" | "medium_term" | "long_term";
type ScenarioKey = "optimistic" | "base" | "pessimistic";

type ResearchDocument = StockReportDocument | StockDiagnosisV1;

const HORIZONS: Array<{ key: HorizonKey; label: string; range: string }> = [
  { key: "short_term", label: "短线", range: "1–10 个交易日" },
  { key: "medium_term", label: "中线", range: "2 周–6 个月" },
  { key: "long_term", label: "长线", range: "6 个月以上" },
];

const SCENARIOS: Array<{ key: ScenarioKey; label: string }> = [
  { key: "optimistic", label: "乐观" },
  { key: "base", label: "基准" },
  { key: "pessimistic", label: "悲观" },
];

const CYCLES: Array<{ key: keyof StockReportV4Document["cycle_states"]; label: string }> = [
  { key: "policy", label: "宏观与流动性周期" },
  { key: "industry", label: "行业供需与产品价格周期" },
  { key: "earnings", label: "公司盈利与现金流周期" },
  { key: "valuation", label: "市场风格与筹码周期" },
];

const DIMENSIONS: Array<{ key: StockDimensionKey; label: string }> = [
  { key: "market_environment", label: "市场环境" },
  { key: "industry", label: "行业信息" },
  { key: "policy", label: "政策信息" },
  { key: "cycle", label: "周期判断" },
  { key: "company_quality", label: "公司质量" },
  { key: "valuation", label: "估值" },
  { key: "capital_positioning", label: "资金与筹码" },
  { key: "event_risk", label: "事件与风险" },
];

const EMPTY_VALUATION_SECTION: StockSummarySection = {
  status: "missing",
  summary: "",
  points: [],
  missing_fields: ["valuation_metrics", "peer_valuation"],
  source_ids: [],
};

function isV4(report: StockReportDocument): report is StockReportV4Document {
  return report.schema_version === 4;
}

function isV6(report: StockReportDocument): report is StockReportV6Document {
  return isStockReportV6Document(report);
}

function isDiagnosis(report: ResearchDocument): report is StockDiagnosisV1 {
  return report.kind === "ai_diagnosis" && report.schema_version === 1;
}

function diagnosisClaim(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return typeof record.text === "string" ? record.text : typeof record.claim === "string" ? record.claim : "";
}

function diagnosisClaims(values: unknown): string[] {
  if (typeof values === "string") return values.trim() ? [values.trim()] : [];
  return Array.isArray(values) ? values.map(diagnosisClaim).filter(Boolean).slice(0, 4) : [];
}

function diagnosisDirection(value: string): string {
  return value === "positive" ? "看涨" : value === "negative" ? "看跌" : value === "neutral" ? "中性" : "暂无方向";
}

function diagnosisAction(value: string): string {
  const labels: Record<string, string> = {
    conditional_participation: "满足条件再参与",
    wait: "等待确认",
    hold: "继续持有",
    reduce: "减仓",
    exit: "退出",
    avoid: "回避",
  };
  return labels[value] ?? "暂不参与";
}

function diagnosisValidation(value: string | undefined): string {
  if (value === "descriptive") return "当前相对强弱（仅描述性排名）";
  if (value === "calibrated") return "历史效果已验证";
  if (value === "rejected") return "历史效果未通过验证";
  return "暂无可用横截面样本";
}

function diagnosisPercentile(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `第${Math.round(value * 100)}百分位` : "暂未形成排名";
}

function diagnosisNumber(value: number | null | undefined, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : "本次未形成";
}

function diagnosisFactorAssessment(factor: StockDiagnosisFactor): string {
  if (factor.direction === "positive") return "偏强";
  if (factor.direction === "negative") return "偏弱";
  if (factor.direction === "neutral") return "中性";
  return typeof factor.value === "number" ? "已有当前值，排名待更新" : "本次未形成";
}

function diagnosisFactorTone(factor: StockDiagnosisFactor): string {
  if (factor.direction === "positive") return "text-stock-up";
  if (factor.direction === "negative") return "text-stock-down";
  return "text-muted-foreground";
}

function diagnosisViewBasisRows(report: StockDiagnosisV1): StockDiagnosisDecisionBasisRow[] {
  if (report.decision_radar.basis_rows?.length) return report.decision_radar.basis_rows;
  const factors = report.fundamental_factors.short_term.factors ?? [];
  const valueAt = (index: number) => factors[index]?.value;
  const revenue = valueAt(4);
  const profit = valueAt(5);
  const cashflow = valueAt(8);
  const fundamentalSummary = typeof revenue === "number" && typeof profit === "number"
    ? `${revenue > 0 && profit > 0 ? "盈利修复" : revenue < 0 && profit < 0 ? "营收与利润承压" : "营收与利润分化"}${typeof cashflow === "number" ? `，${cashflow < 0.8 ? "现金流偏弱" : cashflow >= 1 ? "现金流匹配利润" : "现金流尚可"}` : ""}`
    : "经营结论已形成，因子评分待更新";
  const current = report.decision_radar.current_decision ?? report.horizon_decisions.short_term;
  const bearish = current.direction === "negative" || current.not_holding_action === "avoid";
  const holding = current.holding_action;
  return [
    { key: "fundamental", label: "基本面", stance: "neutral", stance_label: "中性", summary: fundamentalSummary },
    { key: "quant", label: "量化验证", stance: bearish ? "negative" : "neutral", stance_label: bearish ? "偏空" : "中性", summary: bearish ? "短期趋势走弱，暂不新增仓位" : "量价信号分化，等待确认" },
    { key: "sentiment", label: "情绪与预期", stance: "cautious", stance_label: "谨慎", summary: bearish ? "暂无反转信号，不提高仓位" : "等待市场与个股方向确认" },
    { key: "risk", label: "风控纪律", stance: "strict", stance_label: "严格", summary: current.not_holding_action === "avoid" ? `回避新增，已持有${holding === "exit" ? "执行退出" : "优先降风险"}` : "按买入、止损和仓位纪律执行" },
  ];
}

function diagnosisBasisTone(value: StockDiagnosisDecisionBasisRow["stance"]): string {
  if (value === "positive") return "text-stock-up";
  if (value === "negative" || value === "strict") return "text-stock-down";
  if (value === "cautious") return "text-warning";
  return "text-foreground";
}

function DiagnosisFactorBlock({ title, snapshot }: { title: string; snapshot: StockDiagnosisV1["fundamental_factors"] }) {
  const isFundamental = title === "基本面因子";
  const horizons: Array<[keyof StockDiagnosisV1["fundamental_factors"], string]> = [
    ["short_term", isFundamental ? "综合基本面" : "当前量化验证"],
  ];
  return (
    <section className="rounded border px-3 py-3" data-testid={`diagnosis-${title === "量化因子" ? "quant" : "fundamental"}-factors`}>
      <h2 className="text-caption font-semibold">{title}</h2>
      <div className="mt-2 space-y-3">
        {horizons.map(([key, label]) => {
          const horizon = snapshot[key] as StockDiagnosisFactorHorizon;
          const factors = (horizon.factors ?? []).filter(
            (factor) => typeof factor.value === "number" && Number.isFinite(factor.value),
          );
          return (
            <div key={key} className="border-t pt-2 first:border-t-0 first:pt-0" data-testid={`diagnosis-factor-${key}`}>
              <div className="flex items-center justify-between gap-2 text-caption font-medium"><span>{label}</span><span>{typeof horizon.factor_score === "number" ? `${Math.round(horizon.factor_score * 100)}分` : "评分待更新"}</span></div>
              {!isFundamental && <p className="mt-1 text-micro text-muted-foreground">市场：{diagnosisPercentile(horizon.market_percentile)} · 行业：{diagnosisPercentile(horizon.industry_percentile)} · 样本：{horizon.sample_count ?? "待更新"}</p>}
              {!isFundamental && <p className="mt-1 text-micro text-muted-foreground">{diagnosisValidation(horizon.validation_status)}{horizon.fallback_scope === "market" ? "；行业样本不足，已回退市场比较" : ""}</p>}
              {factors.length > 0 ? (
                <div className="mt-1 grid gap-x-3 gap-y-1 text-micro sm:grid-cols-2">
                  {factors.map((factor) => <div key={factor.name}><span>{factorLabel(factor.name)}</span>：{diagnosisNumber(factor.value)} · <span className={diagnosisFactorTone(factor)}>{diagnosisFactorAssessment(factor)}</span></div>)}
                </div>
              ) : <p className="mt-1 text-micro text-muted-foreground">暂无可解释因子</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DiagnosisDecisionCard({ label, decision }: { label: string; decision: StockDiagnosisHorizonDecision }) {
  const plan = decision.materialized_plan;
  const position = decision.position_plan;
  const reasons = diagnosisClaims(decision.key_reasons);
  const risks = diagnosisClaims(decision.key_risks);
  return (
    <section className="rounded border px-3 py-3" data-testid={`diagnosis-horizon-${label}`}>
      <div className="flex items-center justify-between gap-2"><h2 className="text-ui font-semibold">{label}</h2><span className="text-caption">{diagnosisDirection(decision.direction)} · {diagnosisAction(decision.action)}</span></div>
      <p className="mt-2 text-caption">未持有：{diagnosisAction(decision.not_holding_action)} · 已持有：{diagnosisAction(decision.holding_action)}</p>
      <div className="mt-2 grid gap-x-4 gap-y-1 text-caption sm:grid-cols-2">
        <div>因子评分：{diagnosisNumber(decision.factor_score)}</div>
        <div>市场分位：{diagnosisPercentile(decision.market_percentile)}</div>
        <div>行业分位：{diagnosisPercentile(decision.industry_percentile)}</div>
        <div>量化状态：{diagnosisValidation(decision.validation_status)}</div>
      </div>
      <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-3 gap-y-1 text-caption" data-testid={`diagnosis-plan-${label}`}>
        <dt className="text-muted-foreground">参考买入</dt><dd>{diagnosisNumber(plan.reference_entry, " 元")}</dd>
        <dt className="text-muted-foreground">回踩参与</dt><dd>{diagnosisNumber(plan.pullback_entry, " 元")}</dd>
        <dt className="text-muted-foreground">止损参考</dt><dd>{diagnosisNumber(plan.stop_loss, " 元")}</dd>
        <dt className="text-muted-foreground">第一止盈</dt><dd>{diagnosisNumber(plan.first_take_profit, " 元")}</dd>
        <dt className="text-muted-foreground">第二止盈</dt><dd>{diagnosisNumber(plan.second_take_profit, " 元")}</dd>
        <dt className="text-muted-foreground">参考仓位</dt><dd>{diagnosisNumber(position.reference_position_pct, "%")} / 最大 {diagnosisNumber(position.max_position_pct, "%")}</dd>
        <dt className="text-muted-foreground">计划边界</dt><dd>{plan.boundaries?.join("；") || "暂无可确认边界"}</dd>
      </dl>
      <p className="mt-2 text-micro text-muted-foreground">复评条件：{decision.review_trigger || "暂无可确认的复评条件"}{decision.valid_until ? ` · 有效至 ${decision.valid_until.slice(0, 10)}` : ""}</p>
      {reasons.length > 0 && <p className="mt-2 text-micro">主要依据：{reasons.join("；")}</p>}
      {risks.length > 0 && <p className="mt-1 text-micro text-warning">主要风险：{risks.join("；")}</p>}
    </section>
  );
}

function DiagnosisDecisionView({ report }: { report: StockDiagnosisV1 }) {
  const fundamental = report.fundamental_research;
  const semantic = [
    ...diagnosisClaims(fundamental.company_understanding),
    ...diagnosisClaims(fundamental.business_model_summary ?? fundamental.business_model),
    ...diagnosisClaims(fundamental.industry_context ?? fundamental.industry_supply_demand),
    ...diagnosisClaims(fundamental.policy_context ?? fundamental.policy_transmission),
    ...diagnosisClaims(fundamental.cycle_context ?? fundamental.cycle_position),
    ...diagnosisClaims(fundamental.governance ?? fundamental.management_governance),
  ].slice(0, 8);
  const currentDecision = report.decision_radar.current_decision ?? report.horizon_decisions.short_term;
  const basisRows = diagnosisViewBasisRows(report);
  return (
    <div className="space-y-4" data-testid="ai-diagnosis-result">
      <header>
        <h1 className="text-title font-semibold">AI诊股结论</h1>
        <p className="mt-1 text-caption text-muted-foreground">研究截至：{report.research_cutoff_at || "未提供"} · 行情截至：{report.market_as_of || "未提供"}</p>
      </header>
      <section className="rounded border bg-muted/10 px-3 py-3" data-testid="diagnosis-four-step">
        <h2 className="text-caption font-semibold">四步决策依据</h2>
        <div className="mt-2 divide-y divide-border/60 text-caption">{basisRows.map((row) => <div key={row.key} className="grid grid-cols-[5.5rem_3.5rem_minmax(0,1fr)] gap-2 py-2"><span>{row.label}</span><span className={cn("font-medium", diagnosisBasisTone(row.stance))}>{row.stance_label}</span><span>{row.summary}</span></div>)}</div>
      </section>
      {semantic.length > 0 && <section className="rounded border px-3 py-3" data-testid="diagnosis-fundamental-research"><h2 className="text-caption font-semibold">基本面语义</h2><ul className="mt-2 space-y-1 text-caption">{semantic.map((value) => <li key={value}>{value}</li>)}</ul></section>}
      <DiagnosisFactorBlock title="基本面因子" snapshot={report.fundamental_factors} />
      <DiagnosisFactorBlock title="量化因子" snapshot={report.quant_factors} />
      <section className="space-y-2" data-testid="diagnosis-horizon-conclusions"><h2 className="text-caption font-semibold">当前结论</h2><DiagnosisDecisionCard label="当前" decision={currentDecision} /></section>
      <p className="text-micro text-muted-foreground">数据质量：{report.data_quality.status === "complete" || report.data_quality.status === "available" ? "可用" : report.data_quality.status === "degraded" ? "部分可用" : "暂无"} · 结论由确定性规则生成</p>
    </div>
  );
}

function v6Text(value: unknown): string {
  if (typeof value !== "string") return "";
  return evidenceTextLabel(value)
    .replace(/\b(positive|negative|neutral|avoid|research_only|reference_plan|execution_blocked)\b/gi, (token) => {
      const labels: Record<string, string> = {
        positive: "看涨",
        negative: "看跌",
        neutral: "中性",
        avoid: "回避",
        research_only: "研究模式",
        reference_plan: "参考计划",
        execution_blocked: "当前无法执行",
      };
      return labels[token.toLowerCase()] ?? token;
    });
}

function v6StatusLabel(value: string | null | undefined): string {
  if (value === "ready") return "已形成";
  if (value === "unavailable") return "待补充";
  if (value === "blocked") return "受限";
  if (value === "limited") return "有限";
  return "待确认";
}

function v6TradeStatusLabel(value: string | null | undefined): string {
  if (value === "ready") return "已形成参考计划";
  if (value === "unavailable") return "交易条件未通过，仅显示研究结论";
  if (value === "blocked" || value === "limited") return "执行条件受限";
  return "交易计划待确认";
}

function v6DirectionLabel(value: StockReportV6HorizonDecision["direction"]): string {
  return value === "positive" ? "看涨" : value === "negative" ? "看跌" : value === "avoid" ? "回避" : "中性";
}

function v6ActionLabel(value: StockReportV6HorizonDecision["action"]): string {
  const labels: Record<StockReportV6HorizonDecision["action"], string> = {
    conditional_participation: "等待买入",
    wait: "等待确认",
    hold: "继续持有",
    reduce: "减仓",
    exit: "退出",
    avoid: "回避",
  };
  return labels[value];
}

function v6SectionSummary(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  return v6Text(record.conclusion ?? record.summary ?? record.reason) || fallback;
}

function v6UniqueTexts(values: string[], limit = 2): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value.trim().replace(/[。；;]+$/g, "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function v6JoinConclusion(values: string[], fallback: string): string {
  const parts = v6UniqueTexts(values);
  return parts.length > 0 ? `${parts.join("；")}。` : fallback;
}

function v6MarketSentimentConclusion(report: StockReportV6Document): { label: string; impact: string } {
  const section = report.marketSentiment;
  const direction = section?.direction && ["偏多", "偏空", "震荡", "暂不判断"].includes(section.direction)
    ? section.direction
    : "暂不判断";
  return {
    label: `市场情绪：${direction}`,
    impact: v6Text(section?.decisionImpact) || "仅作为市场环境参考，不单独改变个股交易计划。",
  };
}

function v6PublicOpinionConclusion(report: StockReportV6Document): string {
  const section = report.publicOpinion;
  if (!section || section.direction == null || section.status !== "available") {
    return "市场舆论风向：暂无覆盖，不参与决策。";
  }
  const coverage = typeof section.coverageAccountCount === "number"
    ? `覆盖 ${section.coverageAccountCount} 个账号`
    : "覆盖数量待确认";
  const asOf = section.asOf ? ` · 截至 ${section.asOf.slice(0, 16).replace("T", " ")}` : "";
  return `市场舆论风向：${section.direction} · ${coverage}${asOf}`;
}

function v6SectionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function v6ValuationConclusion(report: StockReportV6Document, fallback: string): string {
  const valuation = v6SectionRecord(report.valuation);
  const assessment = v6SectionRecord(valuation.assessment);
  const view = typeof assessment.view === "string" ? assessment.view : "暂不判断";
  const metricText = (["pe", "pb"] as const).map((key) => {
    const metric = v6SectionRecord(assessment[key]);
    const percentile = metric.percentile;
    return typeof percentile === "number" && Number.isFinite(percentile)
      ? `${key.toUpperCase()}第${Math.round(percentile * 100)}百分位`
      : "";
  }).filter(Boolean).join("、");
  return view !== "暂不判断" || metricText ? `估值${view}${metricText ? `（${metricText}）` : ""}` : fallback;
}

/** Adapt the public V6 camelCase contract to the shared legacy detail renderer. */
function v6QuantValidationCompat(value: StockReportV6QuantValidation | StockReportQuantValidation): StockReportQuantValidation {
  const raw = value as unknown as Record<string, any>;
  const read = (camel: string, snake: string) => raw[camel] ?? raw[snake];
  const horizons = read("horizons", "horizons") ?? {};
  const targetWindows = read("targetWindows", "target_windows") ?? {};
  const methodRegistry = read("methodRegistry", "method_registry") ?? {};
  const horizon = (key: "shortTerm" | "mediumTerm" | "longTerm", legacyKey: "short_term" | "medium_term" | "long_term") => {
    const item = horizons[key] ?? horizons[legacyKey] ?? {};
    const target = targetWindows[key] ?? targetWindows[legacyKey] ?? {};
    const registry = methodRegistry[key] ?? methodRegistry[legacyKey] ?? {};
    return {
      status: item.status ?? item.validation_status ?? "unconfirmed",
      signal: item.signal ?? item.quant_signal ?? "neutral",
      target_window_sessions: item.targetWindowSessions ?? item.target_window_sessions ?? target.sessions ?? registry.targetWindowSessions ?? registry.target_window_sessions ?? null,
      target_definition: item.targetDefinition ?? item.target_definition ?? target.definition ?? registry.targetDefinition ?? registry.target_definition ?? null,
      method_id: item.methodId ?? item.method_id ?? registry.id ?? registry.methodId ?? registry.method_id ?? null,
      method_version: item.methodVersion ?? item.method_version ?? registry.version ?? registry.methodVersion ?? registry.method_version ?? null,
      factor_observations: (item.factorObservations ?? item.factor_observations ?? []).map((observation: Record<string, any>) => ({
        field: observation.field,
        raw_value: observation.rawValue ?? observation.raw_value ?? null,
        percentile_or_rank: observation.percentileOrRank ?? observation.percentile_or_rank ?? null,
        direction: observation.direction,
        scope: observation.scope,
        sample_count: observation.sampleCount ?? observation.sample_count ?? 0,
        missing_count: observation.missingCount ?? observation.missing_count ?? 0,
        as_of: observation.asOf ?? observation.as_of ?? null,
        source_ids: [],
        source_count: observation.sourceCount ?? observation.source_count ?? 0,
        method_version: observation.methodVersion ?? observation.method_version ?? "",
        validation_status: observation.validationStatus ?? observation.validation_status ?? item.status ?? "unconfirmed",
      })),
    };
  };
  return {
    strategy_id: read("strategyId", "strategy_id") ?? "",
    as_of: read("asOf", "as_of") ?? null,
    factor_algorithm_version: read("factorAlgorithmVersion", "factor_algorithm_version") ?? "",
    rank_algorithm_version: read("rankAlgorithmVersion", "rank_algorithm_version") ?? "",
    validation_status: read("validationStatus", "validation_status") ?? "unconfirmed",
    quant_signal: read("quantSignal", "quant_signal") ?? "neutral",
    horizons: {
      short_term: horizon("shortTerm", "short_term"),
      medium_term: horizon("mediumTerm", "medium_term"),
      long_term: horizon("longTerm", "long_term"),
    },
    source_ids: [],
    reason: "",
    promotion_status: read("promotionStatus", "promotion_status") ?? undefined,
    eligible_for_trading: read("eligibleForTrading", "eligible_for_trading") ?? undefined,
    target_windows: {
      short_term: targetWindows.shortTerm ?? targetWindows.short_term,
      medium_term: targetWindows.mediumTerm ?? targetWindows.medium_term,
      long_term: targetWindows.longTerm ?? targetWindows.long_term,
    },
    method_registry: {
      short_term: methodRegistry.shortTerm ?? methodRegistry.short_term,
      medium_term: methodRegistry.mediumTerm ?? methodRegistry.medium_term,
      long_term: methodRegistry.longTerm ?? methodRegistry.long_term,
    },
    target_window_sessions: read("targetWindowSessions", "target_window_sessions") ?? null,
    target_definition: read("targetDefinition", "target_definition") ?? null,
  };
}

function V6ResearchView({ report }: { report: StockReportV6Document }) {
  const horizonRows = [
    ["shortTerm", "短线"],
    ["mediumTerm", "中线"],
    ["longTerm", "长线"],
  ] as const;
  const mediumReasons = v6UniqueTexts(report.horizonDecisions.mediumTerm.keyReasons.map(v6Text).filter(Boolean));
  const shortReasons = v6UniqueTexts(report.horizonDecisions.shortTerm.keyReasons.map(v6Text).filter(Boolean));
  const longReasons = v6UniqueTexts(report.horizonDecisions.longTerm.keyReasons.map(v6Text).filter(Boolean));
  const valuationGate = v6SectionSummary(report.valuation, "");
  const valuation = v6ValuationConclusion(report, v6JoinConclusion([valuationGate, ...longReasons], "估值待交叉验证。"));
  const marketSentiment = v6MarketSentimentConclusion(report);
  const publicOpinion = v6PublicOpinionConclusion(report);
  const industry = v6JoinConclusion(mediumReasons, "行业与政策结论待确认。");
  const cycle = v6JoinConclusion(shortReasons.length > 0 ? shortReasons : mediumReasons, "周期判断待确认。");
  const quant = v6JoinConclusion(
    [v6SectionSummary(report.quantPromotion, ""), report.quantValidation ? quantHistoricalValidationLabel(v6QuantValidationCompat(report.quantValidation)) : ""],
    "量化尚未晋级。",
  );
  const riskRows = horizonRows.map(([key, label]) => {
    const risk = v6UniqueTexts(report.horizonDecisions[key].keyRisks.map(v6Text).filter(Boolean), 1)[0];
    return `${label}：${risk || "暂未形成"}`;
  });
  return (
    <div className="space-y-5 px-1" data-testid="research-decision-v6">
      <section className="border-b pb-4" data-testid="research-v6-summary">
        <h1 className="text-title font-semibold">投研结论</h1>
        <p className="mt-2 text-body">{v6Text(report.summary)}</p>
        <p className="mt-1 text-micro text-muted-foreground">{report.decisionMode === "reference_plan" ? "参考计划" : "研究模式"} · 研究结论：{v6StatusLabel(report.researchStatus)} · {v6TradeStatusLabel(report.tradeStatus)}</p>
      </section>

      <section data-testid="research-v6-horizon-conclusions">
        <h2 className="text-ui font-semibold">三周期结论</h2>
        <div className="mt-2 divide-y">
          {horizonRows.map(([key, label]) => {
            const decision = report.horizonDecisions[key];
            return (
              <article key={key} className="py-3 first:pt-0" data-testid={`research-v6-horizon-${key}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-ui font-medium">{label}{v6DirectionLabel(decision.direction)}</h3>
                  <span className="text-caption text-muted-foreground">{v6ActionLabel(decision.action)}</span>
                </div>
                <p className="mt-1.5 text-body">{v6Text(decision.thesis)}</p>
                <p className="mt-1 text-caption text-muted-foreground">研究状态：{v6StatusLabel(decision.researchStatus)} · 交易状态：{v6TradeStatusLabel(decision.tradeStatus)}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section data-testid="research-v6-conclusion-dimensions">
        <h2 className="text-ui font-semibold">关键结论</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {[["估值", valuation], ["行业与政策", industry], ["周期判断", cycle], ["量化验证", quant]].map(([label, text]) => (
            <article key={label} className="bg-muted/20 px-3 py-3">
              <h3 className="text-caption font-medium">{label}</h3>
              <p className="mt-1 text-caption text-muted-foreground">{text}</p>
            </article>
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <article className="bg-muted/20 px-3 py-3" data-testid="research-v6-market-sentiment">
            <h3 className="text-caption font-medium">市场情绪</h3>
            <p className="mt-1 text-caption text-muted-foreground">{marketSentiment.label}</p>
            <p className="mt-1 text-micro text-muted-foreground">影响：{marketSentiment.impact}</p>
          </article>
          <article className="bg-muted/20 px-3 py-3" data-testid="research-v6-public-opinion">
            <h3 className="text-caption font-medium">市场舆论风向</h3>
            <p className="mt-1 text-caption text-muted-foreground">{publicOpinion}</p>
          </article>
        </div>
        <article className="mt-3 bg-muted/20 px-3 py-3">
          <h3 className="text-caption font-medium">主要风险</h3>
          <ul className="mt-1 space-y-1 text-caption text-muted-foreground">
            {riskRows.map((risk) => <li key={risk}>{risk}</li>)}
          </ul>
        </article>
      </section>
      <QuantObservationSection title="量化依据" validation={report.quantValidation ? v6QuantValidationCompat(report.quantValidation) : null} />
      <p className="text-micro text-muted-foreground" data-testid="research-v6-role-handoff">各研究角色依据见下方，可展开查看</p>
    </div>
  );
}

function statusLabel(value: string | null | undefined): string {
  switch (value) {
    case "available":
    case "complete":
      return "可用";
    case "degraded":
      return "部分缺失";
    case "missing":
      return "部分条件待确认";
    case "insufficient_data":
      return "部分条件待确认";
    default:
      return "未提供";
  }
}

function statusTone(value: string | null | undefined): string {
  if (value === "insufficient_data" || value === "missing") return "text-destructive";
  if (value === "degraded") return "text-warning";
  return "text-foreground";
}

function stanceTone(value: StockStance | null | undefined): string {
  if (value === "positive") return "text-stock-up";
  if (value === "negative") return "text-stock-down";
  if (value === "insufficient_data") return "text-warning";
  return "text-foreground";
}

function horizonStanceLabel(value: StockStance | null | undefined): string {
  switch (value) {
    case "positive":
      return "看涨";
    case "negative":
      return "看跌";
    case "neutral":
      return "中性";
    case "insufficient_data":
      return "研究待更新";
    default:
      return "观点待确认";
  }
}

function horizonThesisLabel(value: string | null | undefined): string {
  const text = thesisLabel(evidenceTextLabel(value ?? "")) || "未提供";
  return text
    .replace(/^(positive|negative|neutral|insufficient_data)\b/i, (token) => {
      const normalized = token.toLowerCase();
      if (normalized === "positive") return "看涨";
      if (normalized === "negative") return "看跌";
      if (normalized === "neutral") return "中性";
      return "研究待更新";
    })
    .replace(/(看涨|看跌|中性|研究待更新)\s+的/g, "$1的");
}

function pricedInLabel(value: StockHorizonView["priced_in"]): string {
  switch (value) {
    case "not_priced_in":
      return "尚未计价";
    case "partially_priced_in":
      return "部分计价";
    case "fully_priced_in":
      return "已充分计价";
    default:
      return "未知";
  }
}

function selectionOriginHorizonLabel(value: string): string {
  switch (value) {
    case "short_term": return "短线（1—10 个交易日）";
    case "swing": return "波段（数周）";
    case "medium_term": return "中线（2 周—6 个月）";
    case "long_term": return "长线（6 个月以上）";
    default: return "观察周期待确认";
  }
}

const SELECTION_ORIGIN_DISPLAY_LABELS: Record<string, string> = {
  short_term: "短线",
  swing: "波段",
  medium_term: "中线",
  long_term: "长线",
  operating_cashflow: "经营活动现金流",
  momentum20: "20日价格动量",
  momentum60: "60日价格动量",
  volatility20: "20日波动幅度",
  industry_context: "行业信息",
  policy_context: "政策信息",
  insufficient_data: "尚未形成量化结论",
  partial: "部分缺失",
  stale: "可能已过期",
  unavailable: "暂不可用",
};

function selectionOriginDisplayText(value: string): string {
  return Object.entries(SELECTION_ORIGIN_DISPLAY_LABELS).reduce(
    (text, [code, label]) => text.replace(new RegExp(`\\b${code}\\b`, "gi"), label),
    evidenceTextLabel(value),
  );
}

function selectionOriginTime(value: string | null): string {
  return value ? fmtDateTime(value, "zh-CN") || "时间待确认" : "时间待确认";
}

function SelectionOriginCard({ origin }: { origin: StockSelectionOrigin }) {
  return <section className="border-l-2 border-info/50 bg-info/5 px-3 py-2.5" data-testid="selection-origin-report">
    <div className="flex items-center justify-between gap-2">
      <div>
        <h2 className="text-caption font-medium">选股线索</h2>
      </div>
      <span className="text-micro text-muted-foreground">来自人工智能选股</span>
    </div>
    <dl className="mt-2 grid gap-1 text-micro text-muted-foreground sm:grid-cols-2">
      <div><dt className="inline">策略：</dt><dd className="inline text-foreground">{selectionOriginDisplayText(origin.strategy_name)}</dd></div>
      <div><dt className="inline">原始排名：</dt><dd className="inline text-foreground">第 {origin.deterministic_rank} 名</dd></div>
      <div><dt className="inline">选股周期：</dt><dd className="inline text-foreground">{selectionOriginHorizonLabel(origin.strategy_horizon)}</dd></div>
      <div><dt className="inline">选股时间：</dt><dd className="inline text-foreground">{selectionOriginTime(origin.selection_as_of)}</dd></div>
      <div><dt className="inline">来源数量：</dt><dd className="inline text-foreground">{origin.source_count} 条</dd></div>
    </dl>
    <div className="mt-2 grid gap-2 text-micro">
      <div><div className="text-muted-foreground">为什么入选</div><div className="mt-0.5 text-foreground">{origin.selection_reasons.length > 0 ? origin.selection_reasons.map(selectionOriginDisplayText).join("；") : "未提供"}</div></div>
      <div><div className="text-muted-foreground">为什么值得继续研究</div><div className="mt-0.5 text-foreground">{origin.why_now ? selectionOriginDisplayText(origin.why_now) : "未提供"}</div></div>
      <div><div className="text-muted-foreground">需要重点核验</div><div className="mt-0.5 text-foreground">{origin.focus_questions.length > 0 ? origin.focus_questions.map(selectionOriginDisplayText).join("；") : "未提供"}</div></div>
    </div>
  </section>;
}

function relativeViewLabel(value: StockHorizonView["benchmark"]["relative_view"]): string {
  switch (value) {
    case "outperform":
      return "相对跑赢";
    case "underperform":
      return "相对跑输";
    case "inline":
      return "大致同步";
    default:
      return "未知";
  }
}

function actionLabel(value: StockHorizonView["action"]): string {
  switch (value) {
    case "conditional_participation":
      return "满足条件再参与";
    case "wait_for_confirmation":
      return "等待确认";
    case "reduce_exposure":
      return "减仓或回避";
    case "observe":
      return "继续观察";
    default:
      return "不适用";
  }
}

function claimTypeLabel(value: StockClaimType): string {
  switch (value) {
    case "fact":
      return "事实";
    case "inference":
      return "推断";
    default:
      return "假设";
  }
}

function PointList({ points, empty = "未提供" }: { points: StockViewPoint[]; empty?: string }) {
  if (!points.length) return <p className="text-caption text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1 text-caption">
      {points.map((point, index) => (
        <li key={`${point.claim}-${index}`} className="flex gap-1.5">
          <span className="shrink-0 text-micro text-muted-foreground">{claimTypeLabel(point.claim_type)}</span>
          <span className="min-w-0">{evidenceTextLabel(point.claim)}</span>
        </li>
      ))}
    </ul>
  );
}

function ConditionList({
  conditions,
  title,
  testId,
  kindLabelMode = "full",
}: {
  conditions: StockHorizonCondition[];
  title: string;
  testId?: string;
  kindLabelMode?: "full" | "decision";
}) {
  return (
    <div data-testid={testId}>
      <div className="text-micro font-medium text-muted-foreground">{title}</div>
      {conditions.length ? (
        <ul className="mt-1 space-y-1 text-caption">
          {conditions.map((condition, index) => (
            <li key={`${condition.text}-${index}`} className="flex items-start gap-1.5">
              {kindLabelMode === "full" && (
                <span className="shrink-0 px-1 text-[10px] leading-4 text-muted-foreground">
                  {condition.kind === "manual" ? "人工观察（不会自动触发）" : "系统可计算"}
                </span>
              )}
              {kindLabelMode === "decision" && condition.kind === "manual" && (
                <span className="shrink-0 px-1 text-[10px] leading-4 text-muted-foreground">需人工观察</span>
              )}
              <span className="min-w-0">{evidenceTextLabel(condition.text) || "未提供"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-caption text-muted-foreground">未提供</p>
      )}
    </div>
  );
}

function ConditionTraceSection({ report }: { report: StockReportV4Document }) {
  const groups = (view: StockHorizonView) => [
    ["参与/买入条件", [...view.participation_conditions, ...view.confirmation_conditions]],
    ["止损条件", view.stop_loss_conditions ?? []],
    ["逻辑失效/退出条件", view.invalidation_conditions],
    ["止盈条件", view.take_profit_conditions ?? []],
    ["观察条件", view.watch_conditions],
  ] as Array<[string, StockHorizonCondition[]]>;
  const rows = HORIZONS.flatMap((meta) => groups(report.horizon_views[meta.key])
    .flatMap(([title, conditions]) => conditions.map((condition) => ({
      horizon: meta.label,
      title,
      condition,
    }))));
  if (rows.length === 0) return null;
  return (
    <section className="border-t pt-4" data-testid="research-condition-trace">
      <h2 className="text-caption font-medium">条件证据追溯</h2>
      <ul className="mt-2 space-y-2 text-micro text-muted-foreground">
        {rows.map(({ horizon, title, condition }, index) => (
          <li key={`${horizon}-${title}-${condition.text}-${index}`}>
            <div className="text-caption text-foreground">{horizon} · {title}：{evidenceTextLabel(condition.text) || "未提供"}</div>
            <div className="mt-0.5">
              {condition.kind === "manual" ? "人工观察条件" : "系统可计算条件"} · {condition.claim_type ? `声明：${claimTypeLabel(condition.claim_type)}` : "声明类型待确认"} · {condition.source_ids.length > 0 ? `证据来源：${condition.source_ids.length} 条` : "证据来源待确认"}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const QUANT_PERCENT_FIELDS = new Set([
  "momentum20", "momentum60", "volatility20", "revenue_yoy", "profit_yoy",
  "roe", "roic", "gross_margin", "net_margin", "debt_ratio", "change_pct",
]);
const QUANT_MULTIPLE_FIELDS = new Set(["pe", "pb"]);
const QUANT_PRICE_FIELDS = new Set(["price", "ma5", "ma20", "ma60"]);
const QUANT_AMOUNT_FIELDS = new Set(["turnover", "market_cap", "net_profit", "operating_cashflow"]);

function quantFactorLabel(field: string): string {
  return factorLabel(field);
}

function quantValidationLabel(value: StockReportQuantValidation["validation_status"]): string {
  switch (value) {
    case "uncalibrated": return "未校准";
    case "insufficient_data": return "尚未形成量化结论";
    case "support": return "历史验证支持";
    case "oppose": return "历史验证不支持";
    case "unconfirmed": return "历史验证待确认";
    default: return "状态待确认";
  }
}

function quantHistoricalValidationLabel(validation: StockReportQuantValidation): string {
  if (validation.eligible_for_trading === true || validation.promotion_status === "calibrated") {
    return "已通过历史样本外验证";
  }
  if (validation.promotion_status === "rejected") return "历史样本外验证未通过";
  if (validation.validation_status === "uncalibrated") return "尚未经过历史样本外验证";
  if (validation.validation_status === "insufficient_data") return "历史样本不足";
  return "历史样本外验证待确认";
}

function quantStrategyLabel(value: string): string {
  switch (value) {
    case "deep_research_factor_observation": return "三周期因子观察";
    case "quality_growth": return "业绩成长";
    case "quality": return "经营质量";
    case "trend": return "趋势机会";
    case "catalyst": return "近期催化";
    default: return "量化策略";
  }
}

function quantVersionLabel(value: string | null | undefined): string {
  if (!value) return "计算版本待确认";
  if (value.includes("short-term-volume-price")) return "短线价量模型";
  if (value.includes("medium-term-quality-growth")) return "中线质量成长模型";
  if (value.includes("long-term-quality-value")) return "长线质量估值模型";
  if (value.includes("deep-research-factor-observation")) return "三周期因子观察";
  if (value.includes("rolling-oos")) return "滚动样本外验证";
  if (value.includes("percentile-rank")) return "横截面分位排名";
  if (value.includes("screening-factor")) return "筛选因子计算";
  return "计算版本已记录";
}

function quantScopeLabel(value: StockReportQuantFactorObservation["scope"]): string {
  switch (value) {
    case "industry": return "行业横截面";
    case "market": return "全市场横截面";
    case "market_fallback": return "全市场回退比较";
    case "mixed": return "混合比较";
    default: return "比较口径待确认";
  }
}

function quantNumber(value: number | null | undefined, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`
    : "暂无可核验数值";
}

function quantScaledValue(value: number, unit: string): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000_000) return `${quantNumber(value / 1_000_000_000_000)}万亿${unit}`;
  if (absolute >= 100_000_000) return `${quantNumber(value / 100_000_000)}亿${unit}`;
  if (absolute >= 10_000) return `${quantNumber(value / 10_000)}万${unit}`;
  return `${quantNumber(value)}${unit}`;
}

function quantRawValueLabel(field: string, value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "暂无可核验数值";
  if (QUANT_PERCENT_FIELDS.has(field)) return quantNumber(value, "%");
  if (QUANT_MULTIPLE_FIELDS.has(field)) return quantNumber(value, "倍");
  if (field === "eps") return quantNumber(value, "元/股");
  if (QUANT_PRICE_FIELDS.has(field)) return quantNumber(value, "元");
  if (field === "volume") return quantScaledValue(value, "股");
  if (QUANT_AMOUNT_FIELDS.has(field)) return quantScaledValue(value, "元");
  if (field === "listing_days") return quantNumber(value, "天");
  return `${quantNumber(value)}（单位未提供）`;
}

function quantPercentileLabel(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "暂无可核验数值";
  return value >= 0 && value <= 1 ? quantNumber(value * 100, "%") : quantNumber(value);
}

function quantDirectionLabel(value: StockReportQuantFactorObservation["direction"]): string {
  if (value === "asc") return "数值越低越优";
  if (value === "desc") return "数值越高越优";
  return "方向待确认";
}

function quantFactorCoverage(horizon: StockReportQuantHorizon | undefined): string {
  const observations = horizon?.factor_observations;
  if (!observations || observations.length === 0) return "因子数据待确认";
  const available = observations.filter((item) => item.raw_value != null).length;
  return `${available} 个可用 / ${observations.length - available} 个缺失`;
}

function quantHorizonFactors(horizon: StockReportQuantHorizon | undefined): string {
  const factors = [...new Set((horizon?.factor_observations ?? []).map((item) => quantFactorLabel(item.field)))];
  return factors.length > 0 ? factors.join("、") : "尚未形成因子观测";
}

function quantTargetWindowLabel(
  validation: StockReportQuantValidation,
  horizonKey: HorizonKey,
): string {
  const horizon = validation.horizons?.[horizonKey];
  const target = validation.target_windows?.[horizonKey];
  const registry = validation.method_registry?.[horizonKey];
  const sessions = horizon?.target_window_sessions
    ?? target?.sessions
    ?? (typeof registry?.targetWindowSessions === "number" ? registry.targetWindowSessions : null)
    ?? (typeof registry?.target_window_sessions === "number" ? registry.target_window_sessions : null)
    ?? validation.target_window_sessions;
  const definition = horizon?.target_definition
    ?? target?.definition
    ?? (typeof registry?.targetDefinition === "string" ? registry.targetDefinition : null)
    ?? (typeof registry?.target_definition === "string" ? registry.target_definition : null)
    ?? validation.target_definition;
  if (typeof sessions === "number" && Number.isFinite(sessions) && sessions > 0) return `${sessions} 个交易日`;
  if (typeof definition === "string" && definition.trim()) return evidenceTextLabel(definition);
  return "待提供";
}

function quantHorizonBasisSummary(
  validation: StockReportQuantValidation,
  horizonKey: HorizonKey,
  label: string,
): string {
  const horizon = validation.horizons?.[horizonKey];
  const observations = horizon?.factor_observations ?? [];
  const available = observations.filter((item) => item.raw_value != null).length;
  const coverage = observations.length > 0 ? `${available}/${observations.length} 项因子可用` : "因子覆盖待确认";
  const registry = validation.method_registry?.[horizonKey];
  const method = horizon?.method_version
    ?? (typeof registry?.version === "string" ? registry.version : null)
    ?? validation.factor_algorithm_version;
  return `${label}：${quantHorizonFactors(horizon)}；${coverage}；目标窗口：${quantTargetWindowLabel(validation, horizonKey)}；方法：${quantVersionLabel(method)}`;
}

function QuantFactorDetails({ observation }: { observation: StockReportQuantFactorObservation }) {
  return (
    <li>
      <div className="text-caption text-foreground">{quantFactorLabel(observation.field)}</div>
      <div className="mt-0.5 grid gap-x-3 gap-y-0.5 text-micro sm:grid-cols-2">
        <span>原始值：{quantRawValueLabel(observation.field, observation.raw_value)}</span>
        <span>分位/排名：{quantPercentileLabel(observation.percentile_or_rank)}</span>
        <span>比较口径：{quantScopeLabel(observation.scope)}</span>
        <span>排序方向：{quantDirectionLabel(observation.direction)}</span>
        {typeof observation.sample_count === "number" && <span>样本数：{observation.sample_count}</span>}
        <span>来源数量：{typeof observation.source_count === "number" ? observation.source_count : Array.isArray(observation.source_ids) ? observation.source_ids.length : "待确认"}</span>
        <span>计算版本：{quantVersionLabel(observation.method_version)}</span>
        <span>数据时点：{observation.as_of ? fmtDateTime(observation.as_of, "zh-CN") || "时间待确认" : "时间待确认"}</span>
      </div>
    </li>
  );
}

function QuantObservationSection({
  validation,
  title = "量化观察",
}: {
  validation?: StockReportQuantValidation | null;
  title?: string;
}) {
  return (
    <section className="border-t pt-4" data-testid="research-quant-observation">
      <h2 className="text-caption font-medium">{title}</h2>
      {!validation ? (
        <p className="mt-1 text-caption text-muted-foreground">本报告暂无可核验的量化依据</p>
      ) : (
        <>
          <div className="mt-2 grid gap-x-4 gap-y-1 text-caption sm:grid-cols-2">
            <div>状态：{quantValidationLabel(validation.validation_status)} · 历史验证：{quantHistoricalValidationLabel(validation)}</div>
            <div>数据时点：{validation.as_of ? fmtDateTime(validation.as_of, "zh-CN") || "时间待确认" : "时间待确认"}</div>
            <div>策略：{quantStrategyLabel(validation.strategy_id)}</div>
            <div>计算版本：{quantVersionLabel(validation.factor_algorithm_version)} / {quantVersionLabel(validation.rank_algorithm_version)}</div>
          </div>
          <p className="mt-2 text-micro text-muted-foreground">
            {validation.eligible_for_trading === true || validation.promotion_status === "calibrated"
              ? "已通过历史样本外验证，可作为交易计划的量化依据。"
              : "未经过样本外校准，不构成支持或反对结论。"}
          </p>
          <div className="mt-3 space-y-1 border-t border-border/60 pt-2">
            {HORIZONS.map((meta) => {
              const horizon = validation.horizons?.[meta.key];
              return (
                <details key={meta.key} data-testid={`quant-horizon-details-${meta.key}`}>
                  <summary className="cursor-pointer py-1 text-caption">
                    <span className="font-medium">{quantHorizonBasisSummary(validation, meta.key, meta.label)}</span>
                    <span className="ml-2 text-muted-foreground">{quantFactorCoverage(horizon)}</span>
                  </summary>
                  <p className="border-t pt-2 text-micro text-muted-foreground">
                    本周期验证：{horizon ? quantValidationLabel(horizon.status) : "待确认"} · 目标窗口：{quantTargetWindowLabel(validation, meta.key)}
                  </p>
                  {horizon?.factor_observations?.length ? (
                    <ul className="space-y-2 border-t py-2 text-muted-foreground">
                      {horizon.factor_observations.map((observation, index) => (
                        <QuantFactorDetails key={`${observation.field}-${index}`} observation={observation} />
                      ))}
                    </ul>
                  ) : (
                    <p className="border-t py-2 text-micro text-muted-foreground">暂无可展示的因子观察</p>
                  )}
                </details>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function SummarySection({
  title,
  section,
  compact = false,
  testId,
  className,
  children,
}: {
  title: string;
  section: StockSummarySection;
  compact?: boolean;
  testId?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cn("border-b border-border/70 px-0 py-3", className)} data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-caption font-medium">{title}</h3>
        <span className="flex items-center gap-2">
          <span className={cn("text-micro", statusTone(section.status))}>{statusLabel(section.status)}</span>
          <span className="text-micro text-muted-foreground">{section.source_ids.length} 个来源</span>
          {section.missing_fields.length > 0 && <span className="text-micro text-warning">{section.missing_fields.length} 项缺失</span>}
        </span>
      </div>
      <p className={cn("mt-1 text-caption", compact && "line-clamp-2")}>
        {evidenceTextLabel(section.summary) || "未提供总结"}
      </p>
      {children}
      {!compact && section.points.length > 0 && <div className="mt-2"><PointList points={section.points} /></div>}
      {!compact && section.missing_fields.length > 0 && (
        <p className="mt-2 text-micro text-warning">缺失：{missingFieldsLabel(section.missing_fields)}</p>
      )}
    </section>
  );
}

const MARKET_BREADTH_MISSING_LABELS: Record<string, string> = {
  market_snapshot: "市场快照",
  breadth: "涨跌分布",
  market_snapshot_complete: "市场快照完整性",
  "coverage.complete": "覆盖完整性",
  "coverage.loaded_count": "已加载数量",
  "coverage.expected_count": "应加载数量",
  member_count: "市场成员数",
  available_change_count: "可用涨跌幅数量",
  change_pct: "涨跌幅数据",
  advancing: "上涨数量",
  declining: "下跌数量",
  unchanged: "平盘数量",
  suspended: "停牌数量",
  limit_up_count: "涨停数量",
  limit_down_count: "跌停数量",
  advance_ratio: "上涨占比",
  turnover_amount: "市场快照成交额",
  observed_at: "数据时点",
  basis: "统计依据",
  method: "计算口径",
};

const PUBLIC_ACTIVITY_MISSING_LABELS: Record<string, string> = {
  turnover: "个股成交额",
  turnover_rate: "换手率",
  volume: "成交量",
  price_change_pct: "涨跌幅",
  volume_change_pct_5d: "近5日成交量变化",
  observed_at: "数据时点",
  disclosure_signals: "公开披露信号",
  "disclosure_signals.source_ids": "公开披露信号可追溯来源",
  share_unlock: "限售股解禁",
  share_reduction: "股东减持",
  share_pledge: "股权质押",
  unlock: "限售股解禁",
  reduction: "股东减持",
  pledge: "股权质押",
  financing_balance: "融资余额",
  short_balance: "融券余额",
  financing_flow: "融资融券变化",
  institutional_flow: "机构资金流",
  etf_flow: "交易型开放式指数基金（ETF）资金流",
  shareholder_concentration: "股东集中度",
  basis: "统计依据",
  method: "计算口径",
};

function referenceMissingFields(fields: string[] | undefined, labels: Record<string, string>): string[] {
  return [...new Set((fields ?? []).map((field) => labels[field] ?? "其他必要数据"))];
}

function referenceNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
    : "暂无";
}

function formatRatioAsPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`
    : "暂无";
}

function formatPercentValue(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`
    : "暂无";
}

function referenceDateTime(value: string | null | undefined): string {
  return value ? fmtDateTime(value, "zh-CN") || "日期待确认" : "日期待确认";
}

function referenceDate(value: string | null | undefined): string {
  if (!value) return "日期待确认";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (dateOnly) return `${Number(dateOnly[1])}年${Number(dateOnly[2])}月${Number(dateOnly[3])}日`;
  return referenceDateTime(value);
}

function referenceCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : "暂无";
}

function hasMarketBreadthData(projection: StockMarketBreadthProjection): boolean {
  return [
    projection.member_count,
    projection.available_change_count,
    projection.advancing,
    projection.declining,
    projection.unchanged,
    projection.suspended,
    projection.advance_ratio,
    projection.turnover_amount,
  ].some((value) => typeof value === "number" && Number.isFinite(value));
}

function MarketBreadthReference({ projection }: { projection?: StockMarketBreadthProjection | null }) {
  const missing = referenceMissingFields(projection?.missing_fields, MARKET_BREADTH_MISSING_LABELS);
  const coverage = projection?.coverage;
  const hasCoverageCounts = typeof coverage?.loaded_count === "number" && typeof coverage?.expected_count === "number";
  const coverageText = hasCoverageCounts
    ? `覆盖范围：已加载 ${referenceCount(coverage.loaded_count)} / 应加载 ${referenceCount(coverage.expected_count)}（${coverage.complete === true ? "完整" : coverage.complete === false ? "不完整" : "完整性待确认"}）`
    : "覆盖范围：暂无可验证的覆盖数量";
  const hasData = projection ? hasMarketBreadthData(projection) : false;

  return (
    <div className="mt-2 rounded border bg-muted/10 px-2.5 py-2" data-testid="market-breadth-reference">
      <h4 className="text-micro font-medium">市场宽度参考（不是市场情绪）</h4>
      {hasData ? (
        <div className="mt-1 space-y-1 text-micro">
          <div>{coverageText}</div>
          <div>上涨 {referenceCount(projection?.advancing)} · 下跌 {referenceCount(projection?.declining)} · 平盘 {referenceCount(projection?.unchanged)} · 停牌 {referenceCount(projection?.suspended)}</div>
          <div>上涨占比：{formatRatioAsPercent(projection?.advance_ratio)}</div>
          <div>市场快照成交额：{referenceNumber(projection?.turnover_amount)}（按数据源口径）</div>
          <div>数据时点：{referenceDateTime(projection?.observed_at)}</div>
        </div>
      ) : (
        <p className="mt-1 text-micro text-muted-foreground">暂无可验证的市场宽度数据</p>
      )}
      {missing.length > 0 && <p className="mt-1 text-micro text-warning">缺失：{missing.join("、")}</p>}
      <p className="mt-1 text-micro text-muted-foreground">仅反映当前行情快照的涨跌分布，不代表市场情绪</p>
    </div>
  );
}

function disclosureTypeLabel(value: string | null | undefined): string {
  switch (value) {
    case "share_unlock":
      return "限售股解禁";
    case "share_reduction":
      return "股东减持";
    case "share_pledge":
      return "股权质押";
    default:
      return "公开披露事件";
  }
}

function disclosureSignalLabel(signal: StockPublicDisclosureSignal): string {
  const title = typeof signal.title === "string" && signal.title.trim()
    ? signal.title.trim()
    : "标题待确认";
  return `${disclosureTypeLabel(signal.event_type)} · ${referenceDate(signal.event_date ?? signal.published_at)} · ${title}`;
}

function hasPublicActivityData(projection: StockPublicActivityProjection): boolean {
  return [
    projection.turnover,
    projection.turnover_rate,
    projection.volume,
    projection.price_change_pct,
    projection.volume_change_pct_5d,
  ].some((value) => typeof value === "number" && Number.isFinite(value)) || Boolean(projection.observed_at);
}

function PublicActivityReference({ projection }: { projection?: StockPublicActivityProjection | null }) {
  const missing = referenceMissingFields(projection?.missing_fields, PUBLIC_ACTIVITY_MISSING_LABELS);
  const signals = projection?.disclosure_signals ?? [];
  const hasData = projection ? hasPublicActivityData(projection) : false;

  return (
    <div className="mt-2 rounded border bg-muted/10 px-2.5 py-2" data-testid="public-activity-reference">
      <h4 className="text-micro font-medium">公开交易活跃度参考（不代表机构资金）</h4>
      {hasData ? (
        <div className="mt-1 grid gap-x-3 gap-y-1 text-micro sm:grid-cols-2">
          <div>个股成交额：{referenceNumber(projection?.turnover)}（按数据源口径）</div>
          <div>换手率：{formatPercentValue(projection?.turnover_rate)}</div>
          <div>成交量：{referenceNumber(projection?.volume)}（按数据源口径）</div>
          <div>涨跌幅：{formatPercentValue(projection?.price_change_pct)}</div>
          <div>5日成交量变化：{formatPercentValue(projection?.volume_change_pct_5d)}</div>
          <div>数据时点：{referenceDateTime(projection?.observed_at)}</div>
        </div>
      ) : (
        <p className="mt-1 text-micro text-muted-foreground">暂无可验证的公开交易活跃度数据</p>
      )}
      {missing.length > 0 && <p className="mt-1 text-micro text-warning">缺失：{missing.join("、")}</p>}
      <div className="mt-1 text-micro">
        <span className="font-medium">公开披露信号：</span>
        {signals.length > 0 ? (
          <ul className="mt-0.5 space-y-0.5">
            {signals.map((signal, index) => <li key={`${signal.event_type ?? "event"}-${index}`}>{disclosureSignalLabel(signal)}</li>)}
          </ul>
        ) : (
          <span className="text-muted-foreground">暂无可验证的公开披露信号</span>
        )}
      </div>
      <p className="mt-1 text-micro text-muted-foreground">不推断机构净买入或主力控盘</p>
    </div>
  );
}

function DimensionOverview({ report }: { report: StockReportV4Document }) {
  return (
    <section className="border-t pt-4" data-testid="research-dimension-overview">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-caption font-medium">八项分析维度</h2>
        </div>
      </div>
      <div className="mt-2 grid gap-x-4 gap-y-0 sm:grid-cols-2 xl:grid-cols-4">
        {DIMENSIONS.map(({ key, label }) => {
          const section = report.dimension_views?.[key];
          if (section || key === "valuation") {
            const displaySection = section ?? EMPTY_VALUATION_SECTION;
            return (
              <SummarySection
                key={key}
                title={label}
                section={displaySection}
                compact
                className={key === "valuation" ? "xl:col-span-2" : undefined}
                testId={`research-dimension-${key}`}
              >
                {key === "valuation" ? <ValuationAnalysis section={displaySection} /> : null}
                {key === "market_environment" ? <MarketBreadthReference projection={displaySection.market_breadth} /> : null}
                {key === "capital_positioning" ? <PublicActivityReference projection={displaySection.public_activity} /> : null}
              </SummarySection>
            );
          }
          return (
            <div key={key} className="border-b border-dashed border-border/70 px-0 py-3" data-testid={`research-dimension-${key}`}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-caption font-medium">{label}</h3>
                <span className="flex items-center gap-2 text-micro">
                  <span className="text-destructive">缺失</span>
                  <span className="text-muted-foreground">0 个来源</span>
                </span>
              </div>
              <p className="mt-1 text-caption text-muted-foreground">本报告未提供该维度</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CycleState({ title, state }: { title: string; state: StockCycleState }) {
  return (
    <div className="bg-muted/10 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-medium">{title}</span>
        <span className={cn("text-micro", statusTone(state.status))}>{statusLabel(state.status)}</span>
      </div>
      <div className="mt-1 text-caption">阶段：{evidenceTextLabel(state.stage) || "未提供"}</div>
      {state.observation_window && <div className="mt-0.5 text-micro text-muted-foreground">观察窗口：{evidenceTextLabel(state.observation_window)}</div>}
      {state.missing_fields.length > 0 && <div className="mt-1 text-micro text-warning">缺失：{missingFieldsLabel(state.missing_fields)}</div>}
    </div>
  );
}

function ScenarioPanel({ scenario }: { scenario: StockScenario }) {
  return (
    <div className="border-l-2 border-info/30 bg-muted/10 px-3 py-2.5" data-testid="scenario-panel">
      <p className="text-caption">{evidenceTextLabel(scenario.summary) || "未提供情景总结"}</p>
      <div className="mt-1 text-caption">结果方向：{evidenceTextLabel(scenario.outcome_direction) || "未提供"}</div>
      <ConditionList conditions={scenario.conditions} title="触发条件" />
      {scenario.risks.length > 0 && (
        <div className="mt-2"><div className="text-micro font-medium text-muted-foreground">主要风险</div><PointList points={scenario.risks} /></div>
      )}
    </div>
  );
}

const EMPTY_SCENARIO: StockScenario = {
  summary: "",
  conditions: [],
  outcome_direction: "",
  risks: [],
  source_ids: [],
};

function HorizonCard({
  meta,
  view,
  expanded,
  onToggle,
  scenarioKey,
  onScenarioChange,
  scenarios,
}: {
  meta: (typeof HORIZONS)[number];
  view: StockHorizonView;
  expanded: boolean;
  onToggle: () => void;
  scenarioKey: ScenarioKey;
  onScenarioChange: (key: ScenarioKey) => void;
  scenarios: StockReportV4Document["scenario_sets"][HorizonKey];
}) {
  const headingId = `research-horizon-${meta.key}`;
  const participationConditions = [...view.participation_conditions, ...view.confirmation_conditions].slice(0, 3);
  const stopLossConditions = (view.stop_loss_conditions ?? []).slice(0, 3);
  const exitConditions = view.invalidation_conditions.slice(0, 3);
  const takeProfitConditions = (view.take_profit_conditions ?? []).slice(0, 3);
  const dimensionLabels = Array.isArray(view.dimension_keys)
    ? view.dimension_keys.map((key) => DIMENSIONS.find((dimension) => dimension.key === key)?.label ?? fieldLabel(key))
    : [];
  const benchmarkCode = view.benchmark.instrument_id ? `（${view.benchmark.instrument_id}）` : "";
  const coreThesis = horizonThesisLabel(view.thesis);
  const mainRisks = [...view.tradeability_risks, ...view.blind_spots];
  return (
    <section className="border-b border-border/70 last:border-b-0" data-testid={`horizon-card-${meta.key}`}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 py-3 text-left hover:bg-muted/30"
        aria-expanded={expanded}
        aria-controls={`${headingId}-body`}
        onClick={onToggle}
      >
        <span className="min-w-0">
          <span id={headingId} className="text-ui font-medium">{meta.label}</span>
          <span className="ml-2 text-caption text-muted-foreground">{meta.range}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={cn("text-caption font-medium", stanceTone(view.stance))}>{horizonStanceLabel(view.stance)}</span>
          <span aria-hidden className="text-caption text-muted-foreground">{expanded ? "⌃" : "⌄"}</span>
        </span>
      </button>
      <div className="px-0 py-2.5" data-testid={`horizon-summary-${meta.key}`}>
        <div className="grid gap-x-4 gap-y-1 text-caption md:grid-cols-2">
          <div><span className="text-muted-foreground">当前操作：</span>{actionLabel(view.action)}</div>
          <div className="md:col-span-1"><span className="text-muted-foreground">核心命题：</span>{coreThesis}</div>
        </div>
      </div>
      {expanded && (
        <div id={`${headingId}-body`} className="space-y-4 border-t py-3">
          <div data-testid={`horizon-action-${meta.key}`}>
            <div className="text-caption font-medium">当前操作</div>
            <p className="mt-1 text-caption">{actionLabel(view.action)}</p>
          </div>
          <ConditionList
            title="参与/买入条件"
            conditions={participationConditions}
            testId={`horizon-participation-${meta.key}`}
            kindLabelMode="decision"
          />
          {stopLossConditions.length > 0 && (
            <ConditionList
              title="止损条件"
              conditions={stopLossConditions}
              testId={`horizon-stop-loss-${meta.key}`}
              kindLabelMode="decision"
            />
          )}
          <ConditionList
            title="逻辑失效/退出条件"
            conditions={exitConditions}
            testId={`horizon-exit-${meta.key}`}
            kindLabelMode="decision"
          />
          <div data-testid={`horizon-take-profit-${meta.key}`}>
            {takeProfitConditions.length > 0 ? (
              <ConditionList
                title="止盈条件"
                conditions={takeProfitConditions}
                kindLabelMode="decision"
              />
            ) : (
              <p className="text-caption text-muted-foreground">暂无可执行止盈条件</p>
            )}
          </div>
          <div data-testid={`horizon-time-boundary-${meta.key}`}>
            <div className="text-caption font-medium">时间边界</div>
            <p className="mt-1 text-caption">{view.time_stop || "未提供"}</p>
          </div>
          <div data-testid={`horizon-risks-${meta.key}`}>
            <div className="text-caption font-medium">主要风险</div>
            <div className="mt-1"><PointList points={mainRisks} /></div>
          </div>
          <section data-testid={`horizon-basis-${meta.key}`}>
            <div className="text-caption font-medium">判断依据</div>
            <div className="mt-1 space-y-2 text-caption">
              <div data-testid={`horizon-dimensions-${meta.key}`}>
                本周期依据：{dimensionLabels.length > 0 ? dimensionLabels.join("、") : "未提供"}
              </div>
              {view.watch_conditions.length > 0 && (
                <ConditionList title="观察条件" conditions={view.watch_conditions} kindLabelMode="decision" />
              )}
              <div>
                <span className="text-muted-foreground">相对基准：</span>
                {evidenceTextLabel(view.benchmark.name) || "未提供"}{benchmarkCode} · {relativeViewLabel(view.benchmark.relative_view)}
                {view.benchmark.basis && <div className="mt-0.5 text-micro text-muted-foreground">比较依据：{evidenceTextLabel(view.benchmark.basis)}</div>}
                {view.benchmark.source_ids?.length ? <div className="mt-0.5 text-micro text-muted-foreground">依据：{evidenceCountLabel(view.benchmark.source_ids)}</div> : null}
              </div>
              <div><span className="text-muted-foreground">市场计价：</span>{pricedInLabel(view.priced_in)}</div>
              {view.priced_in_basis && <div><span className="text-muted-foreground">计价依据：</span><span className="mr-1 text-micro text-muted-foreground">{claimTypeLabel(view.priced_in_basis.claim_type)}</span>{evidenceTextLabel(view.priced_in_basis.claim)}</div>}
              <div><span className="text-muted-foreground">关键驱动：</span>{view.drivers.length > 0 ? view.drivers.map((point) => evidenceTextLabel(point.claim)).join("；") : "未提供"}</div>
              <div><span className="text-muted-foreground">证据强度：</span>{evidenceStrengthLabel(view.evidence_strength)} · <span className={statusTone(view.data_status)}>数据状态：{statusLabel(view.data_status)}</span></div>
              <div className="text-micro text-warning">缺失数据：{missingFieldsLabel(view.missing_fields)}</div>
            </div>
            <div className="mt-3">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-caption font-medium">情景</span>
                {SCENARIOS.map((scenario) => (
                  <button
                    type="button"
                    key={scenario.key}
                    className={cn("rounded border px-2 py-0.5 text-micro", scenarioKey === scenario.key ? "border-info bg-info/10 text-info" : "text-muted-foreground hover:text-foreground")}
                    aria-pressed={scenarioKey === scenario.key}
                    onClick={() => onScenarioChange(scenario.key)}
                  >
                    {scenario.label}
                  </button>
                ))}
              </div>
              <ScenarioPanel scenario={scenarios?.[scenarioKey] ?? EMPTY_SCENARIO} />
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function LegacyView({ report }: { report: Exclude<StockReportDocument, StockReportV4Document> }) {
  const legacy = report as Exclude<StockReportDocument, StockReportV4Document> & {
    research_stance?: StockStance | null;
    summary?: string;
    time_horizon?: string | null;
  };
  return (
    <section className="space-y-3 px-1" data-testid="legacy-research-view">
      <div className="rounded-md border bg-muted/10 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-ui font-medium">历史投研结论</h3>
        </div>
        <div className="mt-2 grid gap-2 text-caption md:grid-cols-3">
          <div><div className="text-muted-foreground">研究倾向</div><div className={cn("mt-0.5 font-medium", stanceTone(legacy.research_stance))}>{stanceLabel(legacy.research_stance)}</div></div>
          <div><div className="text-muted-foreground">适用周期</div><div className="mt-0.5 font-medium">{evidenceTextLabel(legacy.time_horizon) || "未提供"}</div></div>
          <div><div className="text-muted-foreground">报告状态</div><div className="mt-0.5 font-medium">{statusLabel(legacy.data_quality)}</div></div>
        </div>
      </div>
      <div>
        <h3 className="text-ui font-medium">主审摘要</h3>
        <p className="mt-1 text-body text-muted-foreground">{evidenceTextLabel(legacy.summary) || "报告未提供摘要"}</p>
      </div>
    </section>
  );
}

export function ResearchDecisionView({ report }: { report: ResearchDocument }) {
  const [expandedHorizon, setExpandedHorizon] = useState<HorizonKey | null>("medium_term");
  const [scenarioKeys, setScenarioKeys] = useState<Record<HorizonKey, ScenarioKey>>({
    short_term: "base",
    medium_term: "base",
    long_term: "base",
  });

  if (isDiagnosis(report)) return <DiagnosisDecisionView report={report} />;
  if (isV6(report)) return <V6ResearchView report={report} />;
  if (!isV4(report)) return <LegacyView report={report} />;

  return (
    <div className="space-y-5 px-1" data-testid="research-decision-view">
      <h1 className="text-title font-semibold">投研结论</h1>
      <section className="space-y-0" aria-label="三周期决策卡" data-testid="research-horizon-conclusions">
        <div className="flex items-center justify-between gap-2 border-b border-border/70 pb-2">
          <div>
            <h2 className="text-ui font-semibold">三周期独立结论</h2>
          </div>
        </div>
        {HORIZONS.map((meta) => (
          <HorizonCard
            key={meta.key}
            meta={meta}
            view={report.horizon_views[meta.key]}
            expanded={expandedHorizon === meta.key}
            onToggle={() => setExpandedHorizon((current) => current === meta.key ? null : meta.key)}
            scenarioKey={scenarioKeys[meta.key]}
            onScenarioChange={(scenarioKey) => setScenarioKeys((current) => ({ ...current, [meta.key]: scenarioKey }))}
            scenarios={report.scenario_sets[meta.key]}
          />
        ))}
      </section>
      <details className="border-t py-3" data-testid="research-full-analysis">
        <summary className="cursor-pointer text-caption font-medium">查看完整分析报告</summary>
        <div className="mt-4 space-y-5">
          {report.selection_origin && <SelectionOriginCard origin={report.selection_origin} />}
          {!report.dimension_views && (
            <div className="grid gap-2 md:grid-cols-2">
              <SummarySection title="市场状态" section={report.market_regime_summary} />
              <SummarySection title="行业与政策" section={report.industry_policy_summary} />
            </div>
          )}
          <DimensionOverview report={report} />
          <QuantObservationSection validation={report.quant_validation} />
          <ConditionTraceSection report={report} />
          <section className="border-t pt-4">
            <div className="mb-2 text-caption font-medium">四类周期状态</div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {CYCLES.map(({ key, label }) => <CycleState key={key} title={label} state={report.cycle_states[key]} />)}
            </div>
          </section>
          <section className="border-t pt-4" data-testid="research-cross-horizon-conflict">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-caption font-medium">周期冲突与裁决边界</h2>
              <span className={cn("text-micro", statusTone(report.cross_horizon_conflict.status))}>
                {statusLabel(report.cross_horizon_conflict.status)}
              </span>
            </div>
            <p className="mt-1 text-caption">{evidenceTextLabel(report.cross_horizon_conflict.explanation) || "未提供冲突说明"}</p>
            {report.cross_horizon_conflict.source_ids.length > 0 && (
              <p className="mt-1 text-micro text-muted-foreground">依据：{evidenceCountLabel(report.cross_horizon_conflict.source_ids)}</p>
            )}
          </section>
          <section className="border-t pt-4" data-testid="research-debate-summary">
            <h2 className="text-caption font-medium">核心多空分歧与裁决</h2>
            <div className="mt-2">
              <DebateResolutionPanel report={report} compact />
            </div>
          </section>
          <section className="border-t pt-4" data-testid="research-evidence-coverage">
            <h2 className="text-caption font-medium">证据覆盖</h2>
            <div className="mt-1 text-caption">研究截至：{report.research_cutoff_at || "未提供"}</div>
            <div className="mt-1 text-caption">行情截至：{report.market_as_of || "未提供"}</div>
          </section>
          <section className="border-t pt-4" data-testid="research-evidence-detail">
            <ResearchEvidenceDetail report={report} />
          </section>
          <section className="border-t pt-4" data-testid="outcome-calibration-details">
            <h2 className="text-caption font-medium">结果追踪与校准</h2>
            <div className="mt-3">
              <OutcomeCalibrationPanel reportId={report.report_id} />
            </div>
          </section>
        </div>
      </details>
    </div>
  );
}
