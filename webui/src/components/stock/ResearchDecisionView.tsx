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
  StockDiagnosisClaim,
  StockDiagnosisFactor,
  StockDiagnosisSourceRecord,
  StockSelectionOrigin,
  StockScenario,
  StockStance,
  StockSummarySection,
  StockViewPoint,
} from "@/lib/stock-api";
import { isStockReportV6Document } from "@/lib/stock-api";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { diagnosisCurrentActionLabel, evidenceCountLabel, evidenceStrengthLabel, evidenceTextLabel, factorLabel, fieldLabel, missingFieldsLabel, providerLabel, stanceLabel, thesisLabel } from "./labels";
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

function diagnosisClaimItem(value: unknown): StockDiagnosisClaim | null {
  if (typeof value === "string") return value.trim() ? { text: value.trim() } : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : typeof record.claim === "string" ? record.claim : "";
  if (!text.trim()) return null;
  return {
    text: text.trim(),
    claim_type: typeof record.claim_type === "string" ? record.claim_type : undefined,
    source_ids: Array.isArray(record.source_ids) ? record.source_ids.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [],
  };
}

function diagnosisClaimItems(...values: unknown[]): StockDiagnosisClaim[] {
  const result: StockDiagnosisClaim[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const claim = diagnosisClaimItem(item);
      const text = claim?.text?.trim();
      if (!claim || !text || seen.has(text)) continue;
      seen.add(text);
      result.push(claim);
    }
  }
  return result;
}

function diagnosisClaimType(claim: StockDiagnosisClaim): string {
  if (claim.claim_type === "fact") return "事实依据";
  if (claim.claim_type === "inference") return "分析判断";
  if (claim.claim_type === "hypothesis") return "待验证假设";
  return "";
}

function diagnosisSourceLabel(source: StockDiagnosisSourceRecord): string {
  const knownProvider = providerLabel(source.provider);
  if (knownProvider !== "来源提供方待确认") return knownProvider;
  try {
    return new URL(source.url).hostname.replace(/^www\./, "");
  } catch {
    return "公开来源";
  }
}

function DiagnosisClaimList({ claims, sourceMap, tone = "default" }: { claims: StockDiagnosisClaim[]; sourceMap: Map<string, StockDiagnosisSourceRecord>; tone?: "default" | "warning" }) {
  return (
    <ul className="mt-2 space-y-2">
      {claims.slice(0, 5).map((claim) => {
        const text = claim.text ?? claim.claim ?? "";
        const claimType = diagnosisClaimType(claim);
        const sources = (claim.source_ids ?? []).map((sourceId) => sourceMap.get(sourceId)).filter((source): source is StockDiagnosisSourceRecord => Boolean(source));
        const unknownSourceCount = Math.max(0, (claim.source_ids?.length ?? 0) - sources.length);
        return <li key={text} className="text-caption"><div className={cn("leading-relaxed", tone === "warning" && "text-warning")}>{text}</div>{(claimType || sources.length > 0 || unknownSourceCount > 0) && <div className="mt-0.5 text-micro text-muted-foreground">{claimType}{claimType && (sources.length > 0 || unknownSourceCount > 0) ? " · " : ""}{sources.slice(0, 2).map((source, index) => <span key={source.id}>{index > 0 ? "、" : "来源："}<a className="text-info hover:underline" href={source.url} target="_blank" rel="noreferrer">{diagnosisSourceLabel(source)}</a>{source.published_at ? `（${source.published_at.slice(0, 10)}）` : source.period_end ? `（截至${source.period_end.slice(0, 10)}）` : ""}</span>)}{unknownSourceCount > 0 ? `${sources.length > 0 ? "，另" : ""}${unknownSourceCount}条可追溯来源` : ""}</div>}</li>;
      })}
    </ul>
  );
}

const DIAGNOSIS_FACTOR_NAMES = [
  "roe", "roic", "gross_margin", "net_margin", "revenue_yoy", "profit_yoy",
  "growth_stability", "operating_cashflow", "cashflow_to_profit", "debt_ratio",
  "interest_coverage", "current_ratio", "capex_to_cashflow", "pe", "pb",
  "cashflow_yield", "audit_qualification", "restatement_count", "dilution_ratio",
  "pledge_ratio", "related_party_transactions",
] as const;

const DIAGNOSIS_FACTOR_META: Record<string, { group: string; unit: string }> = {
  roe: { group: "profitability", unit: "percent" }, roic: { group: "profitability", unit: "percent" },
  gross_margin: { group: "profitability", unit: "percent" }, net_margin: { group: "profitability", unit: "percent" },
  revenue_yoy: { group: "growth_quality", unit: "percent" }, profit_yoy: { group: "growth_quality", unit: "percent" },
  growth_stability: { group: "growth_quality", unit: "ratio" }, operating_cashflow: { group: "cashflow_quality", unit: "currency" },
  cashflow_to_profit: { group: "cashflow_quality", unit: "ratio" }, debt_ratio: { group: "financial_safety", unit: "percent" },
  interest_coverage: { group: "financial_safety", unit: "ratio" }, current_ratio: { group: "financial_safety", unit: "ratio" },
  capex_to_cashflow: { group: "financial_safety", unit: "ratio" }, pe: { group: "valuation", unit: "multiple" },
  pb: { group: "valuation", unit: "multiple" }, cashflow_yield: { group: "valuation", unit: "percent" },
  audit_qualification: { group: "governance", unit: "flag" }, restatement_count: { group: "governance", unit: "count" },
  dilution_ratio: { group: "governance", unit: "percent" }, pledge_ratio: { group: "governance", unit: "percent" },
  related_party_transactions: { group: "governance", unit: "count" },
};

function diagnosisFactorName(value: string): string {
  const legacy = /^factor_(\d+)$/i.exec(value.trim());
  return legacy ? DIAGNOSIS_FACTOR_NAMES[Number(legacy[1]) - 1] ?? value : value.trim().toLowerCase();
}

function diagnosisFactorGroup(factor: StockDiagnosisFactor): string | null {
  return factor.group ?? DIAGNOSIS_FACTOR_META[diagnosisFactorName(factor.name)]?.group ?? null;
}

function diagnosisFactorValue(factor: StockDiagnosisFactor): string {
  const value = factor.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const unit = factor.unit ?? DIAGNOSIS_FACTOR_META[diagnosisFactorName(factor.name)]?.unit;
  if (unit === "percent") return `${value.toFixed(2)}%`;
  if (unit === "multiple") return `${value.toFixed(2)}倍`;
  if (unit === "count") return `${value.toFixed(0)}次`;
  if (unit === "currency") {
    if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿元`;
    if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(2)}万元`;
    return `${value.toFixed(2)}元`;
  }
  return value.toFixed(2);
}

function diagnosisFactorAssessment(factor: StockDiagnosisFactor): string {
  if (factor.direction === "positive") return "较强";
  if (factor.direction === "negative") return "较弱";
  if (factor.direction === "neutral") return "中性";
  return "仅展示当前值";
}

function diagnosisFactorTone(factor: StockDiagnosisFactor): string {
  if (factor.direction === "positive") return "text-stock-up";
  if (factor.direction === "negative") return "text-stock-down";
  return "text-muted-foreground";
}

function diagnosisComparisonLabel(value: string | null | undefined): string {
  if (value === "own_history") return "自身历史";
  if (value === "cross_section" || value === "explicit") return "同类样本";
  if (value === "market") return "全市场";
  return "";
}

type DiagnosisDimension = {
  key: string;
  label: string;
  score: number;
  comparableCount: number;
  totalCount: number;
  note?: string;
};

function diagnosisWeightedScore(factors: StockDiagnosisFactor[]): { score: number | null; count: number } {
  const comparable = factors.filter((factor) => typeof factor.percentile === "number" && Number.isFinite(factor.percentile));
  if (comparable.length === 0) return { score: null, count: 0 };
  const weights = comparable.map((factor) => typeof factor.weight === "number" && factor.weight > 0 ? factor.weight : 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const score = comparable.reduce((sum, factor, index) => sum + (factor.percentile ?? 0) * weights[index], 0) / totalWeight;
  return { score, count: comparable.length };
}

function diagnosisDimensions(report: StockDiagnosisV1): DiagnosisDimension[] {
  const fundamentalFactors = report.fundamental_factors.short_term.factors ?? [];
  const definitions = [
    ["profitability", "盈利能力"],
    ["growth_quality", "成长质量"],
    ["cashflow_quality", "现金流质量"],
    ["financial_safety", "财务安全"],
    ["valuation", "估值吸引力"],
  ] as const;
  const dimensions: DiagnosisDimension[] = definitions.flatMap(([key, label]) => {
    const factors = fundamentalFactors.filter((factor) => diagnosisFactorGroup(factor) === key);
    const { score, count } = diagnosisWeightedScore(factors);
    return score === null ? [] : [{ key, label, score, comparableCount: count, totalCount: factors.length }];
  });
  const quant = report.quant_factors.short_term;
  if (typeof quant.factor_score === "number" && Number.isFinite(quant.factor_score)) {
    dimensions.push({
      key: "market_strength",
      label: "市场表现",
      score: quant.factor_score,
      comparableCount: (quant.factors ?? []).filter((factor) => typeof factor.value === "number").length,
      totalCount: (quant.factors ?? []).length,
      note: typeof quant.sample_count === "number" ? `基于${quant.sample_count}个市场样本` : undefined,
    });
  }
  return dimensions;
}

function diagnosisDimensionLabel(score: number): string {
  if (score >= 0.7) return "较强";
  if (score >= 0.55) return "中性偏强";
  if (score > 0.45) return "中性";
  if (score > 0.3) return "中性偏弱";
  return "较弱";
}

function DiagnosisDimensionOverview({ report }: { report: StockDiagnosisV1 }) {
  const dimensions = diagnosisDimensions(report);
  return (
    <section data-testid="diagnosis-dimension-overview">
      <div className="flex flex-wrap items-end justify-between gap-2"><h2 className="text-ui font-semibold">维度评分概览</h2>{dimensions.length > 0 && <p className="text-micro text-muted-foreground">分数表示当前相对有利位置，不代表上涨概率</p>}</div>
      {dimensions.length > 0 ? <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{dimensions.map((dimension) => {
        const score = Math.max(0, Math.min(100, dimension.score * 100));
        return <div key={dimension.key} className="rounded-lg border border-border/60 bg-muted/15 p-3" data-testid={`diagnosis-dimension-${dimension.key}`}>
          <div className="flex items-baseline justify-between gap-2"><span className="text-caption font-medium">{dimension.label}</span><span className="text-title-sm font-semibold tabular-nums">{Math.round(score)}分</span></div>
          <div className="relative mt-2 h-2 rounded-full bg-gradient-to-r from-stock-down via-muted-foreground/25 to-stock-up" role="img" aria-label={`${dimension.label}${Math.round(score)}分`}><span className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-foreground" style={{ left: `${score}%` }} aria-hidden /></div>
          <div className="mt-2 flex items-center justify-between gap-2 text-micro"><span>{diagnosisDimensionLabel(dimension.score)}</span><span className="text-muted-foreground">{dimension.comparableCount}/{dimension.totalCount}项可比较{dimension.note ? ` · ${dimension.note}` : ""}</span></div>
        </div>;
      })}</div> : <p className="mt-2 rounded-lg bg-muted/20 px-3 py-2 text-caption text-muted-foreground">本次没有足够的同类比较数据，不展示推算分数；可继续查看指标原值和分析证据。</p>}
    </section>
  );
}

function DiagnosisIndicatorTable({ title, factors, fallbackAsOf, sourceMap }: { title: string; factors: StockDiagnosisFactor[]; fallbackAsOf?: string | null; sourceMap: Map<string, StockDiagnosisSourceRecord> }) {
  const available = factors.filter((factor) => typeof factor.value === "number" && Number.isFinite(factor.value));
  if (available.length === 0) return null;
  return (
    <section className="rounded-lg border border-border/60" data-testid={`diagnosis-${title === "基本面指标" ? "fundamental" : "quant"}-factors`}>
      <h3 className="border-b border-border/60 px-3 py-2.5 text-caption font-semibold">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] text-left text-caption">
          <thead className="text-micro text-muted-foreground"><tr><th className="px-3 py-2 font-medium">指标</th><th className="px-3 py-2 font-medium">当前值</th><th className="px-3 py-2 font-medium">相对表现</th><th className="px-3 py-2 font-medium">判断</th><th className="px-3 py-2 font-medium">数据说明</th></tr></thead>
          <tbody className="divide-y divide-border/50">{available.map((factor, index) => {
            const percentile = typeof factor.percentile === "number" ? `${Math.round(factor.percentile * 100)}/100` : "未形成可比分数";
            const scope = diagnosisComparisonLabel(factor.comparison_scope);
            const sourceCount = factor.source_ids?.length ?? 0;
            const source = (factor.source_ids ?? []).map((sourceId) => sourceMap.get(sourceId)).find(Boolean);
            const asOf = factor.as_of ?? fallbackAsOf;
            return <tr key={`${factor.name}-${index}`}><td className="px-3 py-2.5 font-medium">{factorLabel(factor.name)}</td><td className="px-3 py-2.5 tabular-nums">{diagnosisFactorValue(factor)}</td><td className="px-3 py-2.5"><span>{percentile}</span>{scope && <span className="ml-1 text-micro text-muted-foreground">· {scope}</span>}</td><td className={cn("px-3 py-2.5 font-medium", diagnosisFactorTone(factor))}>{diagnosisFactorAssessment(factor)}</td><td className="px-3 py-2.5 text-micro text-muted-foreground">{asOf ? `截至${asOf.slice(0, 10)}` : "当前数据"}{source ? <span> · <a className="text-info hover:underline" href={source.url} target="_blank" rel="noreferrer">{diagnosisSourceLabel(source)}</a></span> : sourceCount > 0 ? ` · ${sourceCount}条来源` : ""}</td></tr>;
          })}</tbody>
        </table>
      </div>
    </section>
  );
}

function DiagnosisDecisionView({ report }: { report: StockDiagnosisV1 }) {
  const fundamental = report.fundamental_research;
  const currentDecision = report.decision_radar.current_decision ?? report.horizon_decisions.short_term;
  const sourceMap = new Map((report.sources ?? []).map((source) => [source.id, source]));
  const fallbackSupports = diagnosisClaimItems(fundamental.competitive_advantages, fundamental.competitive_advantage, fundamental.industry_context, fundamental.industry_supply_demand);
  const fallbackConstraints = diagnosisClaimItems(fundamental.competitive_counterevidence, fundamental.competitive_advantage_counterevidence, fundamental.risks);
  const supports = diagnosisClaimItems(currentDecision.key_reasons);
  const constraints = diagnosisClaimItems(currentDecision.key_risks);
  const visibleSupports = supports.length > 0 ? supports : fallbackSupports;
  const visibleConstraints = constraints.length > 0 ? constraints : fallbackConstraints;
  const explicitThesis = currentDecision.thesis?.trim();
  const supportText = visibleSupports[0]?.text ?? visibleSupports[0]?.claim;
  const constraintText = visibleConstraints[0]?.text ?? visibleConstraints[0]?.claim;
  const thesis = explicitThesis
    || supportText && constraintText && `${supportText}，但${constraintText}。综合判断：${diagnosisCurrentActionLabel(currentDecision)}。`
    || supportText && `${supportText}。综合判断：${diagnosisCurrentActionLabel(currentDecision)}。`
    || constraintText && `${constraintText}。综合判断：${diagnosisCurrentActionLabel(currentDecision)}。`
    || `综合现有经营、估值和市场证据，当前判断为：${diagnosisCurrentActionLabel(currentDecision)}。`;
  const researchSections = [
    { title: "公司与商业模式", claims: diagnosisClaimItems(fundamental.company_understanding, fundamental.business_model_summary, fundamental.business_model) },
    { title: "竞争优势", claims: diagnosisClaimItems(fundamental.competitive_advantages, fundamental.competitive_advantage) },
    { title: "竞争压力", claims: diagnosisClaimItems(fundamental.competitive_counterevidence, fundamental.competitive_advantage_counterevidence) },
    { title: "行业与周期", claims: diagnosisClaimItems(fundamental.industry_context, fundamental.industry_supply_demand, fundamental.cycle_context, fundamental.cycle_position) },
    { title: "政策影响", claims: diagnosisClaimItems(fundamental.policy_context, fundamental.policy_transmission) },
    { title: "公司治理", claims: diagnosisClaimItems(fundamental.governance, fundamental.management_governance) },
  ].filter((section) => section.claims.length > 0);
  const changeConditions = diagnosisClaimItems(fundamental.conclusion_change_conditions, fundamental.change_conditions);
  const assumptions = diagnosisClaimItems(fundamental.key_assumptions);
  const fundamentalFactors = report.fundamental_factors.short_term.factors ?? [];
  const quantFactors = report.quant_factors.short_term.factors ?? [];
  const availableFactorCount = [...fundamentalFactors, ...quantFactors].filter((factor) => typeof factor.value === "number").length;
  const comparableFactorCount = [...fundamentalFactors, ...quantFactors].filter((factor) => typeof factor.percentile === "number").length;
  const qualityLabel = report.data_quality.status === "complete" || report.data_quality.status === "available" ? "数据可用" : report.data_quality.status === "degraded" ? "部分可用" : "数据不足";
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6" data-testid="ai-diagnosis-result">
      <header>
        <h1 className="text-title font-semibold">AI诊股结论</h1>
        <p className="mt-1 text-caption text-muted-foreground">研究截至：{fmtDateTime(report.research_cutoff_at) || "未提供"} · 行情截至：{fmtDateTime(report.market_as_of) || "未提供"}</p>
      </header>

      <section className="rounded-xl bg-muted/25 px-5 py-5" data-testid="diagnosis-core-judgment">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-ui font-semibold">核心判断</h2><span className="rounded-full bg-background/80 px-2.5 py-1 text-caption font-medium">{diagnosisCurrentActionLabel(currentDecision)}</span></div>
        <p className="mt-3 max-w-4xl text-title-sm font-medium leading-relaxed">{thesis}</p>
        {(visibleSupports.length > 0 || visibleConstraints.length > 0) && <div className="mt-4 grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-2">
          {visibleSupports.length > 0 && <div data-testid="diagnosis-supporting-evidence"><h3 className="text-caption font-semibold text-stock-up">支持因素</h3><DiagnosisClaimList claims={visibleSupports} sourceMap={sourceMap} /></div>}
          {visibleConstraints.length > 0 && <div data-testid="diagnosis-constraining-evidence"><h3 className="text-caption font-semibold text-warning">制约因素</h3><DiagnosisClaimList claims={visibleConstraints} sourceMap={sourceMap} tone="warning" /></div>}
        </div>}
      </section>

      <DiagnosisDimensionOverview report={report} />

      {researchSections.length > 0 && <section data-testid="diagnosis-fundamental-research"><h2 className="text-ui font-semibold">公司与行业分析</h2><div className="mt-3 grid gap-3 sm:grid-cols-2">{researchSections.map((section) => <div key={section.title} className="rounded-lg border border-border/60 bg-muted/10 p-3"><h3 className="text-caption font-semibold">{section.title}</h3><DiagnosisClaimList claims={section.claims} sourceMap={sourceMap} /></div>)}</div></section>}

      {(fundamentalFactors.some((factor) => typeof factor.value === "number") || quantFactors.some((factor) => typeof factor.value === "number")) && <section data-testid="diagnosis-indicator-details"><h2 className="text-ui font-semibold">指标明细</h2><p className="mt-1 text-micro text-muted-foreground">相对表现仅在存在可比较样本时展示；未形成比较的数据只保留当前值。</p><div className="mt-3 space-y-3"><DiagnosisIndicatorTable title="基本面指标" factors={fundamentalFactors} fallbackAsOf={report.fundamental_factors.snapshot_as_of ?? report.research_cutoff_at} sourceMap={sourceMap} /><DiagnosisIndicatorTable title="市场表现指标" factors={quantFactors} fallbackAsOf={report.quant_factors.snapshot_as_of ?? report.market_as_of} sourceMap={sourceMap} /></div></section>}

      {(changeConditions.length > 0 || assumptions.length > 0) && <section data-testid="diagnosis-change-conditions"><h2 className="text-ui font-semibold">结论变化条件</h2><div className="mt-3 grid gap-3 sm:grid-cols-2">{changeConditions.length > 0 && <div className="rounded-lg border border-border/60 p-3"><h3 className="text-caption font-semibold">什么情况会改变判断</h3><DiagnosisClaimList claims={changeConditions} sourceMap={sourceMap} tone="warning" /></div>}{assumptions.length > 0 && <div className="rounded-lg border border-border/60 p-3"><h3 className="text-caption font-semibold">当前判断依赖的假设</h3><DiagnosisClaimList claims={assumptions} sourceMap={sourceMap} /></div>}</div></section>}

      <section className="border-t border-border/60 pt-4" data-testid="diagnosis-data-coverage"><h2 className="text-caption font-semibold">数据覆盖</h2><div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-caption text-muted-foreground"><span>{qualityLabel}</span><span>{availableFactorCount}项指标有当前值</span><span>{comparableFactorCount}项指标具备可比位置</span><span>{report.source_ids.length}条可追溯来源</span></div>{report.data_quality.missing_fields?.length ? <p className="mt-2 text-micro text-warning">关键缺口：{missingFieldsLabel(report.data_quality.missing_fields)}</p> : null}</section>
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
                <span className="shrink-0 px-1 text-micro leading-4 text-muted-foreground">
                  {condition.kind === "manual" ? "人工观察（不会自动触发）" : "系统可计算"}
                </span>
              )}
              {kindLabelMode === "decision" && condition.kind === "manual" && (
                <span className="shrink-0 px-1 text-micro leading-4 text-muted-foreground">需人工观察</span>
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
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full justify-between gap-3 rounded-none px-0 py-3 text-left hover:bg-muted/30"
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
      </Button>
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
                  <Button
                    type="button"
                    key={scenario.key}
                    variant="outline"
                    size="xs"
                    className={cn("h-auto px-2 py-0.5 text-micro", scenarioKey === scenario.key ? "border-info bg-info/10 text-info" : "text-muted-foreground hover:text-foreground")}
                    aria-pressed={scenarioKey === scenario.key}
                    onClick={() => onScenarioChange(scenario.key)}
                  >
                    {scenario.label}
                  </Button>
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
