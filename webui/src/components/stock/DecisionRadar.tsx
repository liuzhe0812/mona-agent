import { Loader2, LockKeyhole, Play, Square, UserRound } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  type StockDecisionEvaluation,
  type StockHorizonStances,
  type StockNewsItem,
  type StockReportDocument,
  type StockReportV4Document,
  type StockReportV5Document,
  type StockReportV5HorizonDecision,
  type StockReportV6Document,
  type StockReportV6Direction,
  type StockReportV6HorizonDecision,
  type StockReportV6MaterializedPlan,
  type StockDiagnosisV1,
  type StockDiagnosisHorizonDecision,
  type StockDiagnosisOutcome,
  isStockReportV5Document,
  isStockReportV6Document,
  type StockStance,
} from "@/lib/stock-api";
import { cn } from "@/lib/utils";
import { diagnosisCurrentActionLabel, diagnosisEntryConditionStatus } from "./labels";

export type DecisionRadarTab = "market" | "fundamentals" | "news" | "report";

export interface DecisionRadarProps {
  instrumentId: string;
  starting: boolean;
  runActive: boolean;
  runFailed: boolean;
  runSettled: number;
  runningStepLabel?: string;
  report: StockReportDocument | null;
  /** Latest successful standard AI diagnosis takes precedence over deep history. */
  diagnosisReport?: StockDiagnosisV1 | null;
  diagnosisOutcome?: StockDiagnosisOutcome | null;
  /** Actual workbench mode; omitted for legacy callers/tests. */
  diagnosisMode?: boolean;
  proLocked?: boolean;
  reportStance: StockStance | null | undefined;
  reportDataQuality: string | null | undefined;
  comparison: string;
  horizonComparison?: HorizonComparison;
  technical: {
    trend: string;
    support: number | null;
    resistance: number | null;
    ma5?: number | null;
    ma10?: number | null;
    ma20?: number | null;
  };
  quote: { price: number | null; changePct: number | null; updatedAt: string | null };
  latestNews: StockNewsItem | null;
  fundamentalsPeriod: string | null;
  sourceCount: number;
  onStartRun: () => void;
  onCancelRun: () => void;
  cancellingRun: boolean;
  decisionEvaluation?: StockDecisionEvaluation | null;
  onNavigate: (tab: DecisionRadarTab) => void;
}

type HorizonKey = "short_term" | "medium_term" | "long_term";
type HorizonStanceKey = "shortTerm" | "mediumTerm" | "longTerm";

const HORIZONS: Array<{ key: HorizonKey; label: string }> = [
  { key: "short_term", label: "短线" },
  { key: "medium_term", label: "中线" },
  { key: "long_term", label: "长线" },
];

export interface HorizonComparison {
  current: StockHorizonStances | null;
  previous: StockHorizonStances | null;
  hasCurrentReport: boolean;
  hasPreviousReport: boolean;
}

interface RadarBasisRow {
  label: string;
  status: string;
  summary: string;
  tone: "positive" | "negative" | "neutral" | "warning";
}

interface RadarPanelModel {
  action: string;
  price: string;
  confidence: string;
  reliability: string;
  periodSummary: string;
  basisRows: RadarBasisRow[];
  notHeld: string;
  held: string;
  reconsider: string;
  positionNotHeld: string;
  positionHeld: string;
  positionNote: string;
  validFor: string;
  refreshWhen: string;
  executionRisk: string;
}

interface TradingDecisionDisplayModel extends RadarPanelModel {
  direction: string;
  evidence: string;
  referenceBuy: string;
  pullback: string;
  stopLoss: string;
  firstTakeProfit: string;
  secondTakeProfit: string;
  firstPosition: string;
  maxPosition: string;
  riskLimit: string;
  invalidation: string;
  maxRisk: string;
  meta: string;
}

const HORIZON_STANCE_ITEMS: Array<{ key: HorizonStanceKey; id: HorizonKey; label: string }> = [
  { key: "shortTerm", id: "short_term", label: "短线" },
  { key: "mediumTerm", id: "medium_term", label: "中线" },
  { key: "longTerm", id: "long_term", label: "长线" },
];

function isV4Report(report: StockReportDocument | null): report is StockReportV4Document {
  return Boolean(report && report.schema_version === 4 && "horizon_views" in report);
}

function isV5Report(report: StockReportDocument | null): report is StockReportV5Document {
  return isStockReportV5Document(report);
}

function isV6Report(report: StockReportDocument | null): report is StockReportV6Document {
  return isStockReportV6Document(report);
}

// Keep the existing user-facing cleaning for persisted condition text. The
// radar never evaluates or invents numeric thresholds on the client.
const RADAR_FIELD_LABELS: Record<string, string> = {
  industry_context: "行业数据",
  peer_valuation: "同行估值数据",
  operating_cashflow: "经营现金流",
  "indicators.swing.support": "20日支撑位",
  "indicators.swing.resistance": "20日压力位",
  "indicators.ma5": "5日均线",
  "indicators.ma10": "10日均线",
  "indicators.ma20": "20日均线",
};

const RADAR_FIELD_PATTERN = /\b(industry_context|peer_valuation|operating_cashflow|indicators\.swing\.support|indicators\.swing\.resistance|indicators\.ma5|indicators\.ma10|indicators\.ma20)\b/g;
const RADAR_QUARTER_LABELS = ["", "一", "二", "三", "四"];
const EVIDENCE_GAP_TEXT = ["证据", "不足"].join("");
const DATA_GAP_TEXT = ["数据", "不足"].join("");

function radarTextLabel(value: string): string {
  return value
    .replace(RADAR_FIELD_PATTERN, (token) => RADAR_FIELD_LABELS[token] ?? token)
    .replace(/\b(20\d{2})\s*Q([1-4])\b/gi, (_match, year: string, quarter: string) => `${year}年${RADAR_QUARTER_LABELS[Number(quarter)]}季度`)
    .replace(/\b(20\d{2})\s*H([12])\b/gi, (_match, year: string, half: string) => `${year}年${half === "1" ? "上半年" : "下半年"}`)
    .replace(/\bQ([1-4])\b/gi, (_match, quarter: string) => `${RADAR_QUARTER_LABELS[Number(quarter)]}季度`)
    .replace(/\bH([12])\b/gi, (_match, half: string) => half === "1" ? "上半年" : "下半年")
    .replace(/\bswing-high-low-v1\b/gi, "波段高低点规则")
    .replace(/\b(\d+)\s*日\s*swing\s*(阻力|支撑)(?:位)?\s*\/\s*(阻力|支撑)(?:位)?/gi, (_match, days: string, first: string, second: string) => `${days}日${first === "阻力" ? "压力位" : "支撑位"}/${second === "阻力" ? "压力位" : "支撑位"}`)
    .replace(/\b(\d+)\s*日\s*swing\s*(阻力|支撑)(?:位)?/gi, (_match, days: string, side: string) => `${days}日${side === "阻力" ? "压力位" : "支撑位"}`)
    .replace(/\bswing\s*(阻力|支撑)(?:位)?/gi, (_match, side: string) => side === "阻力" ? "压力位" : "支撑位")
    .replace(/\bswing\b/gi, "波段")
    .replace(/\bMA\s*(\d+)\b/gi, (_match, days: string) => `${days}日均线`)
    .replace(/\bOCF\b/gi, "经营现金流");
}

function thesisTextLabel(value: string): string {
  const labels: Record<string, string> = {
    positive: "看涨",
    negative: "看跌",
    neutral: "中性",
    insufficient_data: "研究待更新",
  };
  return radarTextLabel(value)
    .replace(new RegExp(EVIDENCE_GAP_TEXT, "g"), "关键条件待确认")
    .replace(new RegExp(DATA_GAP_TEXT, "g"), "部分条件待确认")
    .replace(
      /(^|[^A-Za-z0-9_])(positive|negative|neutral|insufficient_data)(?![A-Za-z0-9_])/gi,
      (_match, prefix: string, token: string) => `${prefix}${labels[token.toLowerCase()] ?? token}`,
    )
    .replace(/(看涨|看跌|中性|研究待更新)\s+的/g, "$1的");
}

function actionLabel(action: string, insufficientData: boolean): string {
  if (insufficientData) return "暂不参与";
  switch (action) {
    case "conditional_participation": return "满足条件再参与";
    case "wait_for_confirmation": return "等待确认";
    case "wait": return "等待";
    case "hold": return "继续持有";
    case "reduce_exposure": return "减仓或回避";
    case "reduce": return "减仓";
    case "exit": return "退出";
    case "avoid": return "回避";
    case "observe": return "继续观察";
    default: return "继续观察";
  }
}

function horizonStanceText(value: StockHorizonStances[HorizonStanceKey]): string {
  if (value.status === "insufficient_data" || value.stance === "insufficient_data") return "待更新";
  if (value.stance === "positive") return "看涨";
  if (value.stance === "negative") return "看跌";
  return "中性";
}

function changedHorizonStances(comparison: HorizonComparison) {
  if (!comparison.current || !comparison.previous) return [];
  return HORIZON_STANCE_ITEMS.filter(({ key }) => {
    const current = comparison.current?.[key];
    const previous = comparison.previous?.[key];
    return current && previous && (current.stance !== previous.stance || current.status !== previous.status);
  });
}

/** Kept for the central stage's historical comparison summary. */
export function summarizeHorizonComparison(
  current: StockHorizonStances,
  previous: StockHorizonStances,
): string {
  const changed = changedHorizonStances({
    current,
    previous,
    hasCurrentReport: true,
    hasPreviousReport: true,
  });
  return changed.length === 0
    ? "观点不变"
    : changed.map(({ key, label }) => `${label}${horizonStanceText(previous[key])} → ${horizonStanceText(current[key])}`).join("；");
}

function evidenceStrengthLabel(value: StockReportV5HorizonDecision["evidenceStrength"]): string {
  return value === "strong" ? "较强" : value === "weak" ? "较弱" : "中等";
}

function formatPlanPrice(value: number): string {
  return `${value.toFixed(2)} 元`;
}

function formatPlanRange(low: number, high: number): string {
  return `${low.toFixed(2)}–${high.toFixed(2)} 元`;
}

function formatFraction(value: number): string {
  const commonFractions: Array<[number, string]> = [
    [1 / 3, "1/3"],
    [1 / 2, "1/2"],
    [2 / 3, "2/3"],
  ];
  const match = commonFractions.find(([fraction]) => Math.abs(value - fraction) <= 0.02);
  return match ? match[1] : `${value.toFixed(0)}%`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function directionText(direction: StockReportV6Direction | "positive" | "neutral" | "negative"): string {
  return direction === "positive" ? "看涨" : direction === "negative" ? "看跌" : direction === "avoid" ? "回避" : "中性";
}

function periodSummaryFromDirections(
  decisions: Array<{ label: string; direction: StockReportV6Direction | "positive" | "neutral" | "negative" }>,
): string {
  return decisions.map(({ label, direction }) => `${label}${directionText(direction)}`).join(" · ");
}

function buildV5BasisRows(decision: StockReportV5HorizonDecision): RadarBasisRow[] {
  return [
    { label: "基本面判断", status: "未形成结论", summary: "历史报告未提供结构化基本面结论，请查看详情", tone: "warning" },
    { label: "量化验证", status: "未形成结论", summary: "历史报告未提供结构化量化结论，请查看详情", tone: "warning" },
    { label: "情绪与预期", status: "未形成结论", summary: "历史报告未提供结构化情绪结论，请查看详情", tone: "warning" },
    { label: "风险纪律", status: "参考", summary: decision.direction === "negative" ? "按历史交易计划优先降低风险" : "按历史交易计划控制仓位", tone: decision.direction === "negative" ? "negative" : "neutral" },
  ];
}

function buildV6BasisRows(
  report: StockReportV6Document,
  decision: StockReportV6HorizonDecision,
  horizonKey: HorizonKey,
  horizonLabel: string,
): RadarBasisRow[] {
  const direction = decision.direction;
  const valuation = v6SectionRecord(report.valuation);
  const assessment = v6SectionRecord(valuation.assessment);
  const valuationView = typeof assessment.view === "string" ? assessment.view.trim().toLowerCase() : "";
  const valuationLabel = valuationView === "high" || valuationView === "overvalued" || valuationView === "高估" || valuationView === "偏高"
    ? "估值偏高"
    : valuationView === "low" || valuationView === "undervalued" || valuationView === "低估" || valuationView === "偏低"
      ? "估值偏低"
      : valuationView === "neutral" || valuationView === "fair" || valuationView === "中性" || valuationView === "合理"
        ? "估值中性"
        : null;
  const fundamentalStatus = valuationLabel ?? "未形成结论";
  const fundamental = valuationLabel
    ? valuationLabel === "估值偏高"
      ? "当前估值相对同行偏高；公司经营与行业结论请查看详情"
      : valuationLabel === "估值偏低"
        ? "当前估值相对同行偏低；公司经营与行业结论请查看详情"
        : "当前估值相对同行中性；公司经营与行业结论请查看详情"
    : "本次报告未形成可用于操作的基本面结论";
  const quantSnapshot = v6QuantValidationSnapshot(report.quantValidation, horizonKey);
  const quantSignalLabel = quantSnapshot.signal === "positive" ? "偏多" : quantSnapshot.signal === "negative" ? "偏空" : quantSnapshot.signal === "neutral" ? "中性" : null;
  const quant = quantSignalLabel
    ? `${horizonLabel}量化信号${quantSignalLabel}${quantSnapshot.validationStatus !== "calibrated" ? "；历史表现仍在验证，本次仅作参考" : ""}`
    : "本次未形成可用于操作的量化结论";
  const quantStatus = quantSignalLabel ?? "未形成结论";
  const marketDirection = report.marketSentiment?.direction;
  const emotion = marketDirection === "偏多"
    ? "市场情绪偏多，但不单独作为买入依据"
    : marketDirection === "偏空"
      ? "市场情绪偏空，对新增仓位不利"
      : marketDirection === "震荡"
      ? "市场情绪震荡，等待方向明确"
      : "市场情绪没有形成一致方向，不改变当前操作";
  const emotionStatus = marketDirection === "偏多" || marketDirection === "偏空" || marketDirection === "震荡" ? marketDirection : "无明确方向";
  const risk = direction === "negative" || direction === "avoid"
    ? "不新增仓位，已有持仓优先降低风险"
    : direction === "positive"
      ? "按计划分批参与，单股仓位受限"
      : "等待条件明确，不主动扩大仓位";
  return [
    { label: "基本面判断", status: fundamentalStatus, summary: fundamental, tone: valuationLabel === "估值偏高" ? "negative" : valuationLabel === "估值偏低" ? "positive" : "warning" },
    { label: "量化验证", status: quantStatus, summary: quant, tone: quantSignalLabel === "偏多" ? "positive" : quantSignalLabel === "偏空" ? "negative" : "warning" },
    { label: "情绪与预期", status: emotionStatus, summary: emotion, tone: marketDirection === "偏多" ? "positive" : marketDirection === "偏空" ? "negative" : "warning" },
    { label: "风险纪律", status: direction === "negative" || direction === "avoid" ? "严格" : direction === "positive" ? "控制" : "谨慎", summary: risk, tone: direction === "negative" || direction === "avoid" ? "negative" : direction === "positive" ? "positive" : "warning" },
  ];
}

function v5TradingDisplayModel(
  decision: StockReportV5HorizonDecision,
  currentPrice: number | null,
  horizonLabel: string,
): TradingDecisionDisplayModel {
  const plan = decision.tradingPlan;
  const position = decision.positionPlan;
  const buyRange = formatPlanRange(plan.referenceBuyLow, plan.referenceBuyHigh);
  const pullbackRange = formatPlanRange(plan.pullbackBuyLow, plan.pullbackBuyHigh);
  const notHeld = decision.notHoldingAction === "participate"
    ? `价格达到 ${formatPlanPrice(plan.referenceBuyHigh)}后，等待回踩 ${pullbackRange}参与`
    : decision.notHoldingAction === "wait"
      ? `等待价格达到 ${formatPlanPrice(plan.referenceBuyHigh)}并确认后再参与`
      : "当前不参与，等待重新评估";
  const held = decision.holdingAction === "hold"
    ? `继续持有，跌破 ${formatPlanPrice(plan.stopLoss)}退出`
    : decision.holdingAction === "reduce"
      ? `减仓，跌破 ${formatPlanPrice(plan.stopLoss)}继续退出`
      : `退出，止损参考 ${formatPlanPrice(plan.stopLoss)}`;
  return {
    direction: `${horizonLabel}${decision.direction === "positive" ? "看涨" : decision.direction === "negative" ? "看跌" : "中性"}`,
    action: decision.action === "conditional_participation" ? "等待买入" : actionLabel(decision.action, false),
    price: currentPrice == null ? "—" : formatPlanPrice(currentPrice),
    evidence: evidenceStrengthLabel(decision.evidenceStrength),
    confidence: evidenceStrengthLabel(decision.evidenceStrength),
    reliability: "历史验证范围有限，当前按规则提供参考",
    periodSummary: `${horizonLabel}${directionText(decision.direction)}`,
    basisRows: buildV5BasisRows(decision),
    notHeld,
    held,
    reconsider: `交易条件或研究结论变化后重新评估`,
    positionNotHeld: decision.notHoldingAction === "participate" ? formatPercent(position.initialPositionPct) : "0%",
    positionHeld: decision.holdingAction === "hold" ? formatPercent(position.maxPositionPct) : "逐步降至 0%",
    positionNote: "仅供参考，请结合个人风险承受能力",
    refreshWhen: "价格、财务或行业结论发生变化时",
    executionRisk: "当日买入、跌停时可能无法及时卖出",
    referenceBuy: buyRange,
    pullback: pullbackRange,
    stopLoss: formatPlanPrice(plan.stopLoss),
    firstTakeProfit: `${formatPlanPrice(plan.firstTakeProfit)} · 减仓 ${formatFraction(plan.firstReduceFraction)}`,
    secondTakeProfit: `${formatPlanPrice(plan.secondTakeProfit)} · 再减仓 ${formatFraction(plan.secondReduceFraction)}`,
    firstPosition: formatPercent(position.initialPositionPct),
    maxPosition: formatPercent(position.maxPositionPct),
    riskLimit: `单笔计划风险不超过总资金 ${formatPercent(position.riskBudgetPct)}`,
    validFor: `至 ${decision.validUntil.slice(0, 10)}`,
    invalidation: `跌破 ${formatPlanPrice(plan.stopLoss)}`,
    maxRisk: thesisTextLabel(decision.keyRisks[0]),
    meta: `量化模型计算 · 数据截至 ${decision.marketAsOf.slice(0, 16).replace("T", " ")}`,
  };
}

interface V6DisplayRow {
  label: string;
  value: string;
}

interface V6TradingDisplayModel extends RadarPanelModel {
  direction: string;
  action: string;
  price: string;
  status: string;
  modeSummary: string;
  notHeld: string;
  held: string;
  planRows: V6DisplayRow[];
  positionRows: V6DisplayRow[];
  positionNote: string;
  boundaryRows: V6DisplayRow[];
  maxRisk: string;
}

function v6DirectionLabel(direction: StockReportV6HorizonDecision["direction"], horizonLabel: string): string {
  const label = direction === "positive" ? "看涨" : direction === "negative" ? "看跌" : direction === "avoid" ? "回避" : "中性";
  return `${horizonLabel}${label}`;
}

function v6Price(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)} 元` : "未形成";
}

function v6Range(low: number | null | undefined, high: number | null | undefined): string {
  return typeof low === "number" && Number.isFinite(low) && typeof high === "number" && Number.isFinite(high)
    ? `${low.toFixed(2)}–${high.toFixed(2)} 元`
    : "未形成";
}

function v6Percent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}%` : "未形成";
}

function v6SectionRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function v6QuantValidationSnapshot(value: unknown, horizonKey: HorizonKey): { signal: string | null; validationStatus: string | null } {
  const root = v6SectionRecord(value);
  const horizons = v6SectionRecord(root.horizons);
  const camelKey = horizonKey === "short_term" ? "shortTerm" : horizonKey === "medium_term" ? "mediumTerm" : "longTerm";
  const horizon = v6SectionRecord(horizons[camelKey] ?? horizons[horizonKey]);
  const signal = horizon.signal ?? root.quantSignal ?? root.quant_signal;
  const validationStatus = horizon.validationStatus ?? horizon.validation_status ?? horizon.status ?? root.validationStatus ?? root.validation_status;
  return {
    signal: typeof signal === "string" ? signal.toLowerCase() : null,
    validationStatus: typeof validationStatus === "string" ? validationStatus.toLowerCase() : null,
  };
}

function v6StatusValue(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function v6QuantPromotionStatus(value: unknown): string {
  const section = v6SectionRecord(value);
  return v6StatusValue(section.promotionStatus ?? section.status ?? value);
}

function v6QuantIsCalibrated(value: unknown): boolean {
  return v6QuantPromotionStatus(value) === "calibrated";
}

function v6IsExecutionBlocked(plan: StockReportV6MaterializedPlan | null): boolean {
  return plan?.currentAction === "execution_blocked" || plan?.planStatus === "blocked" || v6StatusValue(v6SectionRecord(plan?.execution).executionStatus) === "blocked";
}

function v6PlanStatusLabel(decision: StockReportV6HorizonDecision, plan: StockReportV6MaterializedPlan | null): string {
  if (!plan) return "研究结论已形成，交易门槛未通过";
  if (v6IsExecutionBlocked(plan)) return "当前无法执行";
  if (plan.planStatus === "limited" || plan.execution?.executionStatus === "limited") return "执行条件受限";
  if (plan.planStatus === "proxy") return "参考计划";
  return decision.tradeStatus === "ready" ? "计划可参考" : "等待研究条件确认";
}

function v6RootHoldingState(report: StockReportV6Document): "holding" | "not_holding" {
  const raw = report as unknown as Record<string, unknown>;
  return raw.holdingState === "holding" || raw.holding_state === "holding" ? "holding" : "not_holding";
}

function v6TradingDisplayModel(
  report: StockReportV6Document,
  decision: StockReportV6HorizonDecision,
  currentPrice: number | null,
  horizonKey: HorizonKey,
  horizonLabel: string,
): V6TradingDisplayModel {
  const plan = decision.materializedPlan;
  const holding = plan?.holdingState === "holding" || (!plan && v6RootHoldingState(report) === "holding");
  const executionBlocked = v6IsExecutionBlocked(plan);
  const direction = decision.direction;
  const hasNumber = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
  const hasRange = (low: number | null | undefined, high: number | null | undefined): boolean => hasNumber(low) && hasNumber(high);
  const usablePlan = plan && !executionBlocked ? plan : null;
  const notHeld = executionBlocked
    ? "当前无法执行，先不新增仓位"
    : usablePlan && direction === "positive" && hasRange(usablePlan.buyLow, usablePlan.buyHigh)
      ? `参考买入 ${v6Range(usablePlan.buyLow, usablePlan.buyHigh)}，按计划分批参与`
      : usablePlan && direction === "neutral" && hasNumber(usablePlan.confirmationPrice)
        ? `等待收盘站上 ${v6Price(usablePlan.confirmationPrice)} 后再参与`
        : direction === "negative" || direction === "avoid"
          ? "当前不建议新开仓，等待重新评估"
          : "当前不建议新开仓，买入条件尚未形成";
  const held = executionBlocked
    ? "当前无法执行，请先重新评估交易条件"
    : usablePlan && direction === "positive" && hasNumber(usablePlan.stopLoss)
      ? `继续持有，跌破 ${v6Price(usablePlan.stopLoss)} 减仓或退出`
      : usablePlan && direction === "neutral" && hasNumber(usablePlan.invalidationPrice)
        ? `继续观察，跌破 ${v6Price(usablePlan.invalidationPrice)} 减仓`
        : usablePlan && (direction === "negative" || direction === "avoid") && hasNumber(usablePlan.exitPrice ?? usablePlan.stopLoss)
          ? `先减仓，跌破 ${v6Price(usablePlan.exitPrice ?? usablePlan.stopLoss)} 退出`
          : direction === "negative" || direction === "avoid"
            ? "先降低仓位，退出价格待重新投研确定"
            : "继续持有或控制仓位，退出条件待重新评估";
  const reconsider = usablePlan && direction === "positive" && hasNumber(usablePlan.confirmationPrice)
    ? `收盘站上 ${v6Price(usablePlan.confirmationPrice)} 后重新评估`
    : usablePlan && (direction === "negative" || direction === "avoid") && hasNumber(usablePlan.reentryConfirmationPrice)
      ? `收盘站上 ${v6Price(usablePlan.reentryConfirmationPrice)} 后重新评估`
      : usablePlan && direction === "neutral" && hasNumber(usablePlan.confirmationPrice)
        ? `收盘站上 ${v6Price(usablePlan.confirmationPrice)} 后重新评估`
        : "价格、行业或财务结论发生变化后重新评估";
  const positionNotHeld = usablePlan && direction === "positive" && hasNumber(usablePlan.initialPositionPct)
    ? v6Percent(usablePlan.initialPositionPct)
    : "0%";
  const targetPosition = usablePlan && hasNumber(usablePlan.targetMaxPositionPct ?? usablePlan.maxPositionPct)
    ? v6Percent(usablePlan.targetMaxPositionPct ?? usablePlan.maxPositionPct)
    : null;
  const positionHeld = usablePlan
    ? direction === "negative" || direction === "avoid"
      ? targetPosition ? `逐步降至 ${targetPosition}` : "逐步降低仓位"
      : targetPosition ?? (direction === "neutral" ? "维持现有，不新增" : "等待计划确定")
    : direction === "negative" || direction === "avoid"
      ? "逐步降低仓位"
      : direction === "neutral"
        ? "维持现有，不新增"
        : "等待计划确定";
  const action = executionBlocked
    ? "当前无法执行"
    : direction === "negative" || direction === "avoid"
      ? "暂不买入 / 减仓"
      : direction === "neutral"
        ? "暂不买入"
        : usablePlan && usablePlan.currentAction === "participate"
          ? "可以分批买入"
          : "等待买入";
  const planRows: V6DisplayRow[] = executionBlocked
    ? [
        { label: "参考买入", value: "当前无法执行" },
        { label: "回踩参与", value: "当前无法执行" },
        { label: "止损参考", value: "待重新投研确定" },
        { label: "第一止盈", value: "尚未形成" },
        { label: "第二止盈", value: "尚未形成" },
      ]
    : !usablePlan
      ? [
          { label: "参考买入", value: direction === "negative" || direction === "avoid" ? "当前不建议买入" : "尚未形成" },
          { label: "回踩参与", value: direction === "negative" || direction === "avoid" ? "当前不建议买入" : "尚未形成" },
          { label: "止损参考", value: direction === "negative" || direction === "avoid" ? "待重新投研确定" : "尚未形成" },
          { label: "第一止盈", value: "尚未形成" },
          { label: "第二止盈", value: "尚未形成" },
        ]
      : direction === "positive"
        ? [
            ...(!holding ? [
              { label: "参考买入", value: v6Range(usablePlan.buyLow, usablePlan.buyHigh) },
              { label: "回踩参与", value: v6Range(usablePlan.pullbackLow, usablePlan.pullbackHigh) },
            ] : []),
            { label: "止损参考", value: v6Price(usablePlan.stopLoss) },
            { label: "第一止盈", value: v6Price(usablePlan.firstTakeProfit) },
            { label: "第二止盈", value: v6Price(usablePlan.secondTakeProfit) },
          ]
        : direction === "neutral"
          ? [
              { label: "确认价", value: v6Price(usablePlan.confirmationPrice) },
              { label: "失效价", value: v6Price(usablePlan.invalidationPrice) },
              { label: "持仓减仓边界", value: v6Price(usablePlan.exitPrice ?? usablePlan.invalidationPrice) },
            ]
          : [
              ...(holding ? [{ label: "退出边界", value: v6Price(usablePlan.exitPrice ?? usablePlan.stopLoss) }] : []),
              { label: "重新考虑价格", value: v6Price(usablePlan.reentryConfirmationPrice) },
            ];
  const positionRows: V6DisplayRow[] = executionBlocked
    ? [
        { label: "首仓", value: "0%" },
        { label: "最大仓位", value: "当前无法新增" },
      ]
    : !usablePlan
      ? [
          { label: "首仓", value: direction === "positive" ? "待确定" : "0%" },
          { label: "最大仓位", value: positionHeld },
        ]
      : direction !== "positive"
        ? [
            { label: "首仓", value: "0%" },
            { label: "最大仓位", value: positionHeld },
          ]
        : [
            { label: "首仓", value: !holding ? v6Percent(usablePlan.initialPositionPct) : "按现有持仓" },
            { label: "最大仓位", value: v6Percent(usablePlan.targetMaxPositionPct ?? usablePlan.maxPositionPct) },
          ];
  const invalidationPrice = usablePlan?.stopLoss ?? usablePlan?.invalidationPrice ?? usablePlan?.exitPrice;
  const boundaryRows: V6DisplayRow[] = !usablePlan
    ? [
        { label: "有效期", value: "待重新投研确定" },
        { label: "计划失效", value: executionBlocked ? "当前无法执行" : "交易条件尚未形成" },
        { label: "最大风险", value: thesisTextLabel(decision.keyRisks[0] ?? "关键条件变化") },
      ]
    : [
        { label: "有效期", value: decision.validUntil ? `至 ${decision.validUntil.slice(0, 10)}` : "研究状态更新时" },
        { label: "计划失效", value: hasNumber(invalidationPrice) ? `跌破 ${v6Price(invalidationPrice)}` : (decision.reviewTrigger || "价格、行业或财务结论发生变化时") },
        { label: "最大风险", value: thesisTextLabel(decision.keyRisks[0] ?? "关键条件变化") },
      ];
  const reliability = v6QuantIsCalibrated(report.quantPromotion)
    ? "量化结果已完成历史验证"
    : "历史验证范围有限，当前按规则提供参考";
  return {
    direction: v6DirectionLabel(direction, horizonLabel),
    action,
    price: currentPrice == null ? "行情待更新" : v6Price(currentPrice),
    confidence: v6QuantIsCalibrated(report.quantPromotion) ? "中等" : "有限",
    reliability,
    periodSummary: periodSummaryFromDirections([
      { label: "短线", direction: report.horizonDecisions.shortTerm.direction },
      { label: "中线", direction: report.horizonDecisions.mediumTerm.direction },
      { label: "长线", direction: report.horizonDecisions.longTerm.direction },
    ]),
    basisRows: buildV6BasisRows(report, decision, horizonKey, horizonLabel),
    notHeld,
    held,
    reconsider,
    positionNotHeld,
    positionHeld,
    positionNote: "仅供参考，请结合个人风险承受能力",
    validFor: decision.validUntil ? `至 ${decision.validUntil.slice(0, 10)}` : "研究条件变化时",
    refreshWhen: "价格、行业或财务结论发生变化时",
    executionRisk: "当日买入、跌停时可能无法及时卖出",
    status: executionBlocked ? "当前执行条件受限" : v6PlanStatusLabel(decision, plan),
    modeSummary: `${decision.researchStatus === "ready" ? "研究结论已形成" : "研究结论待补充"}；${reliability}`,
    planRows,
    positionRows,
    boundaryRows,
    maxRisk: thesisTextLabel(decision.keyRisks[0] ?? "关键条件变化"),
  };
}

function PendingTradingPlanPanel({
  message,
  status,
  testId,
  headline,
}: {
  message: string;
  status: string;
  testId: string;
  headline?: string;
}) {
  const pending = "投研完成后生成";
  return (
    <section className="space-y-5 pt-4" data-testid={testId}>
      <div className="rounded-xl bg-muted/30 px-4 py-4">
        <div className="text-body font-medium text-muted-foreground">结论状态</div>
        <div className="mt-1 text-display-sm font-semibold text-muted-foreground">{status}</div>
        <p className="mt-2 text-body">当前操作：暂不参与</p>
        <p className="mt-1 text-caption text-muted-foreground">可信度：尚未形成投研结论，暂不能评估</p>
        {headline && <p className="mt-2 text-caption font-medium">{headline}</p>}
        <p className="mt-3 text-caption text-muted-foreground">{message}</p>
      </div>

      <section>
        <h3 className="text-title-sm font-semibold">交易计划</h3>
        <dl className="mt-3 grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] gap-x-3 gap-y-2 text-body">
          <dt className="text-muted-foreground">参考买入</dt><dd>{pending}</dd>
          <dt className="text-muted-foreground">回踩参与</dt><dd>{pending}</dd>
          <dt className="text-muted-foreground">止损参考</dt><dd>{pending}</dd>
          <dt className="text-muted-foreground">第一止盈</dt><dd>{pending}</dd>
          <dt className="text-muted-foreground">第二止盈</dt><dd>{pending}</dd>
        </dl>
      </section>

      <section>
        <h3 className="text-title-sm font-semibold">参考仓位</h3>
        <div className="mt-3 grid grid-cols-2 gap-4 text-center">
          <div><div className="text-body text-muted-foreground">首仓</div><div className="mt-1 text-title font-semibold text-muted-foreground">{pending}</div></div>
          <div><div className="text-body text-muted-foreground">最大仓位</div><div className="mt-1 text-title font-semibold text-muted-foreground">{pending}</div></div>
        </div>
        <p className="mt-2 text-body text-muted-foreground">单笔计划风险：{pending}</p>
      </section>

      <section>
        <h3 className="text-title-sm font-semibold">计划边界</h3>
        <dl className="mt-3 grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] gap-x-3 gap-y-2 text-body">
          <dt className="text-muted-foreground">有效期</dt><dd>{pending}</dd>
          <dt className="text-muted-foreground">计划失效</dt><dd>{pending}</dd>
          <dt className="text-muted-foreground">最大风险</dt><dd>{pending}</dd>
        </dl>
      </section>
    </section>
  );
}

function RadarBasisList({ rows }: { rows: RadarBasisRow[] }) {
  const toneClass = (tone: RadarBasisRow["tone"]): string => tone === "positive" ? "text-stock-up" : tone === "negative" ? "text-stock-down" : tone === "warning" ? "text-warning" : "text-foreground";
  return (
    <section className="pt-4" data-testid="decision-radar-four-step">
      <h3 className="text-title-sm font-semibold">四层分析</h3>
      <div className="mt-2 divide-y divide-border/60">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[minmax(0,5.5rem)_minmax(0,3.5rem)_minmax(0,1fr)] gap-2 py-2 text-body">
            <span>{row.label}</span>
            <span className={cn("font-medium", toneClass(row.tone))}>{row.status}</span>
            <span className="break-words text-foreground">{row.summary}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TradingDecisionPanel({ model }: { model: TradingDecisionDisplayModel }) {
  const directionTone = model.direction.includes("看跌") ? "text-stock-down" : model.direction.includes("中性") ? "text-foreground" : "text-stock-up";
  return (
    <section className="space-y-5 pt-4" data-testid="decision-radar-cycle-output">
      <div className="rounded-xl bg-muted/30 px-4 py-4">
        <div className={cn("text-body font-medium", directionTone)}>{model.direction}</div>
        <div className={cn("mt-1 text-display-sm font-semibold", directionTone)}>{model.action}</div>
        <p className="mt-2 text-body">现价 {model.price} · 依据强度：{model.evidence}</p>
        <div className="mt-4 space-y-3 text-body">
          <div className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-stock-up text-white" aria-hidden><UserRound className="h-4 w-4" /></span><div className="min-w-0"><div className="font-medium text-stock-up">未持有</div><p className="mt-0.5 break-words">{model.notHeld}</p></div></div>
          <div className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted-foreground text-white" aria-hidden><UserRound className="h-4 w-4" /></span><div className="min-w-0"><div className="font-medium text-muted-foreground">已持有</div><p className="mt-0.5 break-words">{model.held}</p></div></div>
        </div>
      </div>
      <RadarBasisList rows={model.basisRows} />
      <section data-testid="decision-radar-v5-trading-plan"><h3 className="text-title-sm font-semibold">交易计划</h3><dl className="mt-3 grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] gap-x-3 gap-y-2 text-body"><dt className="text-muted-foreground">参考买入</dt><dd className="break-words">{model.referenceBuy}</dd><dt className="text-muted-foreground">回踩参与</dt><dd className="break-words">{model.pullback}</dd><dt className="text-muted-foreground">止损参考</dt><dd className="break-words">{model.stopLoss}</dd><dt className="text-muted-foreground">第一止盈</dt><dd className="break-words">{model.firstTakeProfit}</dd><dt className="text-muted-foreground">第二止盈</dt><dd className="break-words">{model.secondTakeProfit}</dd></dl></section>
      <section data-testid="decision-radar-v5-position-plan"><h3 className="text-title-sm font-semibold">参考仓位</h3><div className="mt-3 grid grid-cols-2 gap-4 text-center"><div><div className="text-body text-muted-foreground">首仓</div><div className="mt-1 text-title font-semibold">{model.firstPosition}</div></div><div><div className="text-body text-muted-foreground">最大仓位</div><div className="mt-1 text-title font-semibold">{model.maxPosition}</div></div></div><p className="mt-2 text-body text-muted-foreground">{model.riskLimit}</p></section>
      <section data-testid="decision-radar-v5-boundary"><h3 className="text-title-sm font-semibold">计划边界</h3><dl className="mt-3 grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] gap-x-3 gap-y-2 text-body"><dt className="text-muted-foreground">有效期</dt><dd className="break-words">{model.validFor}</dd><dt className="text-muted-foreground">计划失效</dt><dd className="break-words">{model.invalidation}</dd><dt className="text-muted-foreground">最大风险</dt><dd className="break-words">{model.maxRisk}</dd></dl></section>
      <footer className="border-t border-border/60 pt-3 text-micro text-muted-foreground" data-testid="decision-radar-v5-meta">{model.meta}</footer>
    </section>
  );
}

function V6TradingDecisionPanel({ model }: { model: V6TradingDisplayModel }) {
  const directionTone = model.direction.includes("看跌") || model.direction.includes("回避") ? "text-stock-down" : model.direction.includes("中性") ? "text-foreground" : "text-stock-up";
  return (
    <section className="space-y-5 pt-4" data-testid="decision-radar-v6-panel">
      <div className="rounded-xl bg-muted/30 px-4 py-4">
        <div className={cn("text-body font-medium", directionTone)}>{model.direction}</div>
        <div className={cn("mt-1 text-display-sm font-semibold", directionTone)}>{model.action}</div>
        <p className="mt-2 text-body">现价 {model.price}</p>
        <p className="mt-1 text-caption text-muted-foreground">可信度：{model.modeSummary}</p>
        <div className="mt-4 space-y-3 text-body">
          <div className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-stock-up text-white" aria-hidden><UserRound className="h-4 w-4" /></span><div className="min-w-0"><div className="font-medium text-stock-up">未持有</div><p className="mt-0.5 break-words">{model.notHeld}</p></div></div>
          <div className="flex items-start gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted-foreground text-white" aria-hidden><UserRound className="h-4 w-4" /></span><div className="min-w-0"><div className="font-medium text-muted-foreground">已持有</div><p className="mt-0.5 break-words">{model.held}</p></div></div>
        </div>
      </div>
      <RadarBasisList rows={model.basisRows} />
      <section data-testid="decision-radar-v6-trading-plan"><h3 className="text-title-sm font-semibold">交易计划</h3><dl className="mt-3 grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] gap-x-3 gap-y-2 text-body">{model.planRows.map((row) => <div key={row.label} className="contents"><dt className="text-muted-foreground">{row.label}</dt><dd className="break-words">{row.value}</dd></div>)}</dl></section>
      <section data-testid="decision-radar-v6-position-plan"><h3 className="text-title-sm font-semibold">参考仓位</h3><dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-center text-body">{model.positionRows.map((row) => <div key={row.label}><dt className="text-muted-foreground">{row.label}</dt><dd className="mt-1 text-title font-semibold">{row.value}</dd></div>)}</dl><p className="mt-2 text-body text-muted-foreground">{model.positionNote}</p></section>
      <section data-testid="decision-radar-v6-boundary"><h3 className="text-title-sm font-semibold">计划边界</h3><dl className="mt-3 grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] gap-x-3 gap-y-2 text-body">{model.boundaryRows.map((row) => <div key={row.label} className="contents"><dt className="text-muted-foreground">{row.label}</dt><dd className="break-words">{row.value}</dd></div>)}</dl></section>
    </section>
  );
}

function HorizonTabs({ activeHorizon, onChange }: { activeHorizon: HorizonKey; onChange: (horizon: HorizonKey) => void }) {
  return <div className="flex border-b border-border/60" role="tablist" aria-label="研究周期">{HORIZONS.map(({ key, label }) => <Button key={key} type="button" role="tab" aria-selected={activeHorizon === key} variant="ghost" size="sm" className={cn("h-auto flex-1 rounded-none border-b-2 px-2 py-2 text-caption", activeHorizon === key ? "border-info font-medium text-foreground" : "border-transparent text-muted-foreground")} onClick={() => onChange(key)}>{label}</Button>)}</div>;
}

function diagnosisValue(value: number | null | undefined, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : "本次未形成";
}

function diagnosisPriceRange(
  low: number | null | undefined,
  high: number | null | undefined,
  fallback: number | null | undefined,
): string {
  if (typeof low === "number" && Number.isFinite(low) && typeof high === "number" && Number.isFinite(high)) {
    return low === high ? `${low.toFixed(2)} 元` : `${low.toFixed(2)}–${high.toFixed(2)} 元`;
  }
  return diagnosisValue(fallback, " 元");
}

function DiagnosisDecisionStrength({
  score,
  positiveThreshold,
  negativeThreshold,
}: {
  score: number | null;
  positiveThreshold: number;
  negativeThreshold: number;
}) {
  if (score === null) return null;
  const position = Math.max(0, Math.min(100, (score + 1) / 2 * 100));
  const positivePosition = (positiveThreshold + 1) / 2 * 100;
  const negativePosition = (negativeThreshold + 1) / 2 * 100;
  const roundedScore = Math.sign(score) * Math.round(Math.abs(score) * 1000) / 10;
  const signed = `${roundedScore >= 0 ? "+" : ""}${roundedScore.toFixed(1)}`;
  const margin = score > positiveThreshold
    ? score - positiveThreshold
    : score < negativeThreshold
      ? negativeThreshold - score
      : null;
  const summary = score > positiveThreshold
    ? margin !== null && margin <= 0.05 ? "刚超过偏多门槛，方向优势有限" : "超过偏多门槛"
    : score < negativeThreshold
      ? margin !== null && margin <= 0.05 ? "刚跌破偏空门槛，方向劣势有限" : "跌破偏空门槛"
      : "处于中性区间，尚未形成明确方向";
  return (
    <section data-testid="diagnosis-decision-strength">
      <div className="flex items-baseline justify-between gap-3 text-body"><span className="font-medium">综合方向强度</span><span className="font-semibold tabular-nums">{signed}</span></div>
      <div className="relative mt-2 h-2 rounded-full bg-gradient-to-r from-stock-down via-muted-foreground/30 to-stock-up" role="img" aria-label={`综合方向强度：${signed}`}>
        <span className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-background/90" style={{ left: `${negativePosition}%` }} aria-hidden />
        <span className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-background/90" style={{ left: `${positivePosition}%` }} aria-hidden />
        <span className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-foreground shadow-sm" style={{ left: `${position}%` }} aria-hidden />
      </div>
      <div className="mt-1 flex justify-between text-micro text-muted-foreground"><span>偏空 -100</span><span>中性</span><span>偏多 +100</span></div>
      <p className="mt-1 text-micro font-medium">{summary}</p>
    </section>
  );
}

function DiagnosisRadarPanel({ decision, report, currentPrice }: { decision: StockDiagnosisHorizonDecision; report: StockDiagnosisV1; currentPrice: number | null }) {
  const plan = decision.materialized_plan;
  const position = decision.position_plan;
  const hasParticipationPlan = decision.action === "conditional_participation"
    || decision.not_holding_action === "conditional_participation";
  const fundamentalScore = report.fundamental_factors?.short_term?.factor_score;
  const quantHorizon = report.quant_factors?.short_term;
  const directDecisionScore = typeof decision.decision_score === "number" ? decision.decision_score : null;
  const fallbackFundamentalScore = typeof fundamentalScore === "number" ? fundamentalScore * 2 - 1 : null;
  const fallbackTechnicalScore = typeof decision.factor_contributions?.trend === "number" ? decision.factor_contributions.trend : null;
  const fallbackQuantScore = quantHorizon?.validation_status === "calibrated" && typeof quantHorizon.factor_score === "number" ? quantHorizon.factor_score * 2 - 1 : null;
  const fallbackRawCandidates: Array<[string, number, number] | null> = [
    fallbackFundamentalScore === null ? null : ["fundamental", fallbackFundamentalScore, 0.55],
    fallbackTechnicalScore === null ? null : ["technical", fallbackTechnicalScore, 0.45],
    fallbackQuantScore === null ? null : ["quant", fallbackQuantScore, 0.25],
  ];
  const fallbackRawComponents = fallbackRawCandidates.filter(
    (item): item is [string, number, number] => item !== null,
  );
  const fallbackWeightTotal = fallbackRawComponents.reduce((sum, item) => sum + item[2], 0);
  const fallbackDecisionScore = fallbackRawComponents.length >= 2
    ? fallbackRawComponents.reduce((sum, item) => sum + item[1] * item[2], 0) / fallbackWeightTotal
    : null;
  const decisionScore = directDecisionScore ?? fallbackDecisionScore;
  const entryThreshold = plan.reference_entry_high ?? plan.reference_entry;
  const entryGapPct = typeof currentPrice === "number" && currentPrice > 0 && typeof entryThreshold === "number"
    ? (entryThreshold / currentPrice - 1) * 100
    : null;
  const riskReference = plan.risk_reference_price ?? plan.reference_entry_high ?? plan.reference_entry;
  const riskPerShare = plan.risk_per_share ?? (
    typeof riskReference === "number" && typeof plan.stop_loss === "number" && riskReference > plan.stop_loss
      ? riskReference - plan.stop_loss
      : null
  );
  const riskPct = plan.risk_pct ?? (
    typeof riskPerShare === "number" && typeof riskReference === "number" && riskReference > 0
      ? riskPerShare / riskReference * 100
      : null
  );
  const firstRiskRewardAfterFees = plan.risk_reward_first_after_fees;
  const secondRiskRewardAfterFees = plan.risk_reward_second_after_fees;
  const hasFeeRiskReward = typeof firstRiskRewardAfterFees === "number"
    || typeof secondRiskRewardAfterFees === "number";
  const hasPositionAdvice = typeof position.reference_position_pct === "number"
    || typeof position.max_position_pct === "number"
    || typeof position.risk_budget_pct === "number";
  const feeGateStatus = plan.fee_gate_status;
  const feeGateLabel = feeGateStatus === "passed"
    ? "已通过"
    : feeGateStatus === "failed"
      ? "未通过"
      : feeGateStatus === "unavailable"
        ? "暂未形成"
        : null;
  const slippageStressStatus = plan.slippage_stress_status;
  const currentEntryStatus = diagnosisEntryConditionStatus(decision, currentPrice);
  const entryNotTriggered = currentEntryStatus === "not_triggered";
  const actionBlockers = [
    plan.fee_gate_status === "failed"
      ? "扣除交易费率后的收益风险比未达标"
      : plan.fee_gate_status === "unavailable" && decision.direction === "positive"
        ? "扣除交易费率后的收益风险比暂未形成"
        : null,
    plan.risk_reward_gate_status === "failed"
      ? "收益风险比未达到参与条件"
      : null,
    entryNotTriggered ? "价格参与条件尚未触发" : null,
    plan.value_status !== "available"
      ? "入场、止损或止盈计划尚未完整形成"
      : null,
    plan.risk_reward_gate_status !== "failed"
      && plan.fee_gate_status !== "failed"
      && position.value_status !== "available"
      ? "风险预算或仓位依据尚未完整形成"
      : null,
    decision.direction === "neutral" ? "综合方向强度尚未超过参与门槛" : null,
  ].filter((value): value is string => Boolean(value)).slice(0, 3);
  const showActionBlockers = actionBlockers.length > 0 && (
    decision.current_action === "wait"
    || decision.not_holding_action === "wait"
    || decision.not_holding_action === "conditional_participation" && entryNotTriggered
  );
  return (
    <section className="space-y-5 pt-4" data-testid="decision-radar-ai-diagnosis">
      <div className="rounded-xl bg-muted/30 px-4 py-4">
        <div className="text-body font-medium">当前综合建议</div>
        <div className="mt-1 text-display-sm font-semibold">{diagnosisCurrentActionLabel(decision, currentPrice)}</div>
        {typeof currentPrice === "number" && (
          <div className="mt-3 border-t border-border/60 pt-3 text-caption" data-testid="diagnosis-current-stock-status">
            <p>当前个股：现价 <span className="font-semibold tabular-nums">{currentPrice.toFixed(2)} 元</span>{typeof entryThreshold === "number" ? ` · 参与确认线 ${entryThreshold.toFixed(2)} 元` : ""}</p>
            {entryGapPct !== null && entryGapPct > 0 && <p className="mt-1 text-muted-foreground">距参与确认还需上涨 {entryGapPct.toFixed(2)}%</p>}
            {entryGapPct !== null && entryGapPct <= 0 && <p className="mt-1 text-stock-up">当前价格已达到参与确认线</p>}
          </div>
        )}
        {showActionBlockers && <div className="mt-3 border-t border-border/60 pt-3 text-caption" data-testid="diagnosis-action-blockers"><p className="font-medium text-warning">暂不买入的原因</p><ul className="mt-1 space-y-1 text-muted-foreground">{actionBlockers.map((reason) => <li key={reason}>· {reason}</li>)}</ul></div>}
      </div>
      {decisionScore !== null && <section data-testid="decision-radar-score-bars"><DiagnosisDecisionStrength score={decisionScore} positiveThreshold={decision.positive_threshold ?? 0.2} negativeThreshold={decision.negative_threshold ?? -0.2} /></section>}
      <section data-testid="decision-radar-ai-trading-plan">
        <h3 className="text-title-sm font-semibold">交易计划</h3>
        <dl className="mt-3 grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] gap-x-3 gap-y-2 text-body">
          <dt className="text-muted-foreground">参考买入</dt><dd>{hasParticipationPlan ? diagnosisPriceRange(plan.reference_entry_low, plan.reference_entry_high, plan.reference_entry) : "当前不建议买入"}</dd>
          <dt className="text-muted-foreground">回踩参与</dt><dd>{hasParticipationPlan ? diagnosisPriceRange(plan.pullback_entry_low, plan.pullback_entry_high, plan.pullback_entry) : "暂不参与"}</dd>
          <dt className="text-muted-foreground">止损参考</dt><dd>{typeof plan.stop_loss === "number" ? diagnosisValue(plan.stop_loss, " 元") : "未设置固定止损价"}</dd>
          <dt className="text-muted-foreground">第一止盈</dt><dd>{typeof plan.first_take_profit === "number" ? diagnosisValue(plan.first_take_profit, " 元") : "未设置固定止盈价"}</dd>
          <dt className="text-muted-foreground">第二止盈</dt><dd>{typeof plan.second_take_profit === "number" ? diagnosisValue(plan.second_take_profit, " 元") : "未设置固定止盈价"}</dd>
        </dl>
        <dl className="mt-3 grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] gap-x-3 gap-y-2 border-t border-border/60 pt-3 text-body" data-testid="decision-radar-ai-boundary">
          <dt className="text-muted-foreground">计划有效期</dt><dd>{decision.valid_until ? `至 ${decision.valid_until.slice(0, 10)}` : "价格、趋势或基本面发生明显变化前"}</dd>
          <dt className="text-muted-foreground">计划失效</dt><dd>{plan.invalidation?.join("；") || decision.review_trigger || "价格、趋势或基本面发生明显变化"}</dd>
          <dt className="text-muted-foreground">重新诊股</dt><dd>{decision.review_trigger || "计划失效、目标到达或关键数据更新后"}</dd>
        </dl>
      </section>
      {typeof riskPerShare === "number" && typeof riskPct === "number" && (
        <section data-testid="decision-radar-risk-reward">
          <h3 className="text-title-sm font-semibold">收益风险</h3>
          <div className={cn("mt-3 grid gap-3 text-center text-caption", hasFeeRiskReward ? "grid-cols-3" : "grid-cols-1")}>
            <div><div className="text-muted-foreground">计划风险</div><div className="mt-1 font-semibold tabular-nums">{riskPct.toFixed(2)}%</div><div className="text-micro text-muted-foreground">每股 {riskPerShare.toFixed(2)} 元</div></div>
            {hasFeeRiskReward && <div><div className="text-muted-foreground">第一目标盈亏比</div><div className="mt-1 font-semibold tabular-nums">{typeof firstRiskRewardAfterFees === "number" ? `${firstRiskRewardAfterFees.toFixed(2)}R` : "—"}</div></div>}
            {hasFeeRiskReward && <div><div className="text-muted-foreground">第二目标盈亏比</div><div className="mt-1 font-semibold tabular-nums">{typeof secondRiskRewardAfterFees === "number" ? `${secondRiskRewardAfterFees.toFixed(2)}R` : "—"}</div></div>}
          </div>
          {hasFeeRiskReward && feeGateLabel && <p className={cn("mt-3 border-t border-border/60 pt-2 text-caption", feeGateStatus === "passed" ? "text-stock-up" : feeGateStatus === "failed" ? "text-stock-down" : "text-warning")} data-testid="diagnosis-fee-risk-reward">费率后盈亏比：第一目标 {typeof firstRiskRewardAfterFees === "number" ? `${firstRiskRewardAfterFees.toFixed(2)}R` : "—"} · 第二目标 {typeof secondRiskRewardAfterFees === "number" ? `${secondRiskRewardAfterFees.toFixed(2)}R` : "—"} · {feeGateLabel}</p>}
          {slippageStressStatus === "failed" && <p className="mt-2 text-micro text-warning" data-testid="diagnosis-liquidity-warning">成交成本压力较高，实际下单前需关注流动性。</p>}
        </section>
      )}
      {hasPositionAdvice && <section data-testid="decision-radar-ai-position">
        <h3 className="text-title-sm font-semibold">建议仓位</h3>
        <div className="mt-3 grid grid-cols-2 gap-4 text-center">
          <div><div className="text-caption text-muted-foreground">建议首仓</div><div className="mt-1 text-title font-semibold">{diagnosisValue(position.reference_position_pct, "%")}</div></div>
          <div><div className="text-caption text-muted-foreground">建议上限</div><div className="mt-1 text-title font-semibold">{diagnosisValue(position.max_position_pct, "%")}</div></div>
        </div>
        <p className="mt-2 text-body text-muted-foreground">单笔风险预算：{diagnosisValue(position.risk_budget_pct, "%")}</p>
      </section>}
    </section>
  );
}

export function DecisionRadar({
  starting,
  runActive,
  runFailed,
  quote,
  report,
  onStartRun,
  onCancelRun,
  cancellingRun,
  diagnosisReport = null,
  diagnosisMode = false,
  proLocked = false,
}: DecisionRadarProps) {
  const v4 = isV4Report(report);
  const v5Report = isV5Report(report) ? report : null;
  const v5 = v5Report !== null;
  const v6Report = isV6Report(report) ? report : null;
  const v6 = v6Report !== null;
  const [activeHorizon, setActiveHorizon] = useState<HorizonKey>("short_term");
  const launchLabel = diagnosisMode
    ? diagnosisReport || runFailed ? "重新诊股" : "开始AI诊股"
    : report || runFailed ? "重新投研" : "启动深度投研";
  const evaluationKey = activeHorizon === "short_term" ? "shortTerm" : activeHorizon === "medium_term" ? "mediumTerm" : "longTerm";
  const horizonLabel = activeHorizon === "short_term" ? "短线" : activeHorizon === "medium_term" ? "中线" : "长线";
  const v5Decision = v5Report?.horizonDecisions[evaluationKey] ?? null;
  const v5Display = v5Decision
    ? v5TradingDisplayModel(v5Decision, quote.price, horizonLabel)
    : null;
  const v6Decision = v6Report?.horizonDecisions[evaluationKey] ?? null;
  const v6Display = v6Decision && v6Report
    ? v6TradingDisplayModel(
      v6Report,
      v6Decision,
      v6Report.currentPrice ?? quote.price,
      activeHorizon,
      horizonLabel,
    )
    : null;
  const freshnessMessage = v5Decision?.isExpired ? "当前周期已超过有效期，建议重新投研" : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background" data-testid="decision-radar">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
        <h2 className="min-w-0 truncate text-ui font-semibold">决策雷达</h2>
        {proLocked ? (
          <Button type="button" size="xs" className="text-caption" onClick={onStartRun}>
            <LockKeyhole className="mr-1 h-3.5 w-3.5" aria-hidden />升级 Pro 解锁
          </Button>
        ) : starting ? (
          <Button type="button" variant="outline" size="xs" className="text-caption" disabled aria-label={diagnosisMode ? "正在准备AI诊股" : "正在准备投研"}><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />准备中</Button>
        ) : runActive ? (
          <Button type="button" variant="outline" size="xs" className="text-caption" onClick={onCancelRun} disabled={cancellingRun}>
            <Square className="mr-1 h-3.5 w-3.5" aria-hidden />{cancellingRun ? "取消中" : diagnosisMode ? "取消AI诊股" : "取消投研"}
          </Button>
        ) : (
          <Button type="button" size="xs" className="text-caption" onClick={onStartRun}><Play className="mr-1 h-3.5 w-3.5" aria-hidden />{launchLabel}</Button>
        )}
      </header>

      <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {proLocked ? (
          <PendingTradingPlanPanel testId="decision-radar-pro-locked" status="Pro" headline="AI诊股为 Pro 功能" message="升级 Mona Pro 后可生成诊股结论、交易计划与历史记录" />
        ) : diagnosisReport ? (
          <DiagnosisRadarPanel decision={diagnosisReport.decision_radar.current_decision ?? diagnosisReport.horizon_decisions.short_term} report={diagnosisReport} currentPrice={quote.price ?? diagnosisReport.current_price ?? null} />
        ) : diagnosisMode ? (
          <PendingTradingPlanPanel testId="decision-radar-empty-state" status={runFailed ? "生成失败" : "尚未生成"} headline={runFailed ? undefined : "尚无AI诊股结论"} message={runFailed ? "本次AI诊股未形成结论，请重新诊股" : "请开始AI诊股生成当前建议"} />
        ) : !v4 && !v5 && !v6 ? (
          <><HorizonTabs activeHorizon={activeHorizon} onChange={setActiveHorizon} /><PendingTradingPlanPanel testId="decision-radar-empty-state" status={runFailed ? "生成失败" : "尚未生成"} headline={runFailed ? undefined : "尚无投研结论"} message={runFailed ? "本次投研未生成可用交易计划，请重新投研" : "请启动深度投研生成交易计划"} /></>
        ) : v4 ? (
          <><HorizonTabs activeHorizon={activeHorizon} onChange={setActiveHorizon} /><PendingTradingPlanPanel testId="decision-radar-v4-migration" status="需重新投研" message="该历史报告不含交易计划，请重新投研生成" /></>
        ) : v6 ? (
          <><HorizonTabs activeHorizon={activeHorizon} onChange={setActiveHorizon} />{v6Display && <V6TradingDecisionPanel model={v6Display} />}</>
        ) : (
          <><HorizonTabs activeHorizon={activeHorizon} onChange={setActiveHorizon} />{v5Display && <TradingDecisionPanel model={v5Display} />}{freshnessMessage && <div className="mt-2 border-t border-warning/40 pt-2 text-micro text-warning" data-testid="decision-radar-freshness">{freshnessMessage}</div>}</>
        )}
      </div>
    </div>
  );
}
