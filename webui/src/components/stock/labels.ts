/** 股票模块展示文案映射（stance / data_quality → 中文标签）。 */

import type { StockDiagnosisHorizonDecision, StockEvidenceStrength, StockStance, StockTimeHorizon } from "@/lib/stock-api";

export function diagnosisActionLabel(value: string): string {
  const labels: Record<string, string> = {
    positive: "看涨",
    neutral: "中性",
    negative: "看跌",
    unavailable: "暂无方向",
    conditional_participation: "满足条件再参与",
    participate: "按计划参与",
    wait: "等待确认",
    hold: "继续持有",
    reduce: "减仓",
    exit: "退出",
    avoid: "回避",
  };
  return labels[value] ?? "待确认";
}

export function diagnosisEntryConditionStatus(
  decision: StockDiagnosisHorizonDecision,
  currentPrice?: number | null,
): "triggered" | "not_triggered" | "unavailable" {
  const threshold = decision.materialized_plan.reference_entry_high ?? decision.materialized_plan.reference_entry;
  const legacySinglePriceCondition = decision.materialized_plan.entry_condition_realtime_eligible == null
    && decision.materialized_plan.entry_condition_count == null
    && decision.materialized_plan.entry_condition?.startsWith("价格达到参考买入区间上沿");
  if ((decision.materialized_plan.entry_condition_realtime_eligible === true || legacySinglePriceCondition) && typeof currentPrice === "number" && Number.isFinite(currentPrice) && typeof threshold === "number" && Number.isFinite(threshold)) {
    return currentPrice >= threshold ? "triggered" : "not_triggered";
  }
  const explicit = decision.materialized_plan.entry_condition_status;
  if (explicit === "triggered" || explicit === "not_triggered") return explicit;
  return "unavailable";
}

export function diagnosisCurrentActionLabel(decision: StockDiagnosisHorizonDecision, currentPrice?: number | null): string {
  if (decision.not_holding_action === "avoid") return "暂不买入";
  if (decision.not_holding_action === "wait") return "暂不买入";
  if (decision.not_holding_action === "conditional_participation") {
    const status = diagnosisEntryConditionStatus(decision, currentPrice);
    if (status === "triggered" || decision.current_action === "participate" && status === "unavailable") return "可按计划分批买入";
    return "暂不买入";
  }
  return diagnosisActionLabel(decision.not_holding_action);
}

export function diagnosisNotHoldingActionLabel(decision: StockDiagnosisHorizonDecision, currentPrice?: number | null): string {
  if (decision.not_holding_action !== "conditional_participation") {
    return "暂不买入";
  }
  const condition = decision.materialized_plan.entry_condition?.trim();
  const status = diagnosisEntryConditionStatus(decision, currentPrice);
  if (status === "not_triggered") {
    return condition ? `暂不买入；等待${condition}` : "暂不买入；等待价格条件满足";
  }
  if (status === "triggered") {
    return "可按计划分批买入";
  }
  if (decision.current_action === "participate") {
    return "可按计划分批买入";
  }
  if (decision.current_action === "wait") {
    return condition ? `暂不买入；等待${condition}` : "暂不买入；参与条件待确认";
  }
  return "暂不买入；参与条件待确认";
}

export const STANCE_LABELS: Record<StockStance, string> = {
  positive: "看多",
  neutral: "中性",
  negative: "看空",
  // The enum remains insufficient_data; the user-facing meaning is that the
  // old/partial research has to be refreshed, not that the stock is a view.
  insufficient_data: "研究待更新",
};

export const DATA_QUALITY_LABELS: Record<string, string> = {
  complete: "数据完整",
  available: "数据可用",
  degraded: "部分条件待确认",
  missing: "部分条件待确认",
  insufficient_data: "部分条件待确认",
};

export const TIME_HORIZON_LABELS: Record<StockTimeHorizon, string> = {
  short_term: "短线",
  swing: "波段",
  medium_term: "中期",
};

export const EVIDENCE_STRENGTH_LABELS: Record<StockEvidenceStrength, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

/** Only schema field keys belong here; ordinary report prose is never rewritten. */
export const FIELD_LABELS: Record<string, string> = {
  market_regime: "市场状态",
  market_environment: "市场环境",
  quote: "行情报价",
  industry_context: "行业信息",
  industry: "行业信息",
  policy_context: "政策信息",
  policy: "政策信息",
  cycle_context: "周期判断",
  cycle: "周期判断",
  company_quality: "公司质量",
  valuation: "估值",
  capital_positioning: "资金与筹码",
  event_calendar: "事件日历",
  event_risk: "事件与风险",
  tradeability: "交易可行性",
  industry_policy_documents: "行业政策文件",
  macro_regulatory_policy_documents: "宏观/监管政策文件",
  title: "标题",
  issuer: "发布机构",
  document_id: "文号",
  published_at: "发布时间",
  effective_from: "生效日期",
  effective_to: "失效日期",
  url: "原文链接",
  summary: "摘要",
  source_ids: "证据来源",
  report_period: "报告期",
  period_end: "期间截止日",
  financial_period: "财务期",
  multi_period_financials: "多期财务数据",
  multi_period_earnings: "多期盈利数据",
  cashflow_quality_trend: "现金流质量趋势",
  cashflow_trend: "现金流趋势",
  capital_expenditure: "资本开支",
  governance: "公司治理",
  dilution_history: "稀释历史",
  audit_or_restatement_status: "审计/重述状态",
  peer_valuation: "同行估值",
  industry_classification: "行业分类",
  industry_members: "行业成员",
  classification_scheme: "分类标准",
  industry_code: "行业代码",
  industry_member_coverage: "行业成员覆盖",
  industry_benchmark: "行业基准",
  industry_change_pct: "行业涨跌幅",
  market_change_pct: "市场涨跌幅",
  relative_change_pct: "相对涨跌幅",
  market_snapshot: "全市场快照",
  market_snapshot_complete: "全市场快照完整性",
  breadth: "市场宽度",
  turnover_amount: "成交额",
  limit_up_count: "涨停家数",
  limit_down_count: "跌停家数",
  change_pct: "涨跌幅",
  macro_indicator_series: "宏观指标序列",
  liquidity_indicator_series: "流动性指标序列",
  macro_liquidity: "宏观流动性周期",
  industry_supply_demand: "行业供需周期",
  company_earnings: "公司盈利周期",
  market_style: "市场风格周期",
  inventory: "库存",
  capacity_utilization: "产能利用率",
  product_price: "产品价格",
  industry_demand: "行业需求",
  earnings_revision: "盈利预期修正",
  event_date: "事件日期",
  event_type: "事件类型",
  event_type_coverage: "事件类型覆盖",
  announcements: "公告",
  financing_balance: "融资余额",
  short_balance: "融券余额",
  financing_flow: "融资流向",
  institutional_flow: "机构资金流",
  etf_flow: "ETF资金流",
  shareholder_concentration: "股东集中度",
  pledge: "质押",
  reduction: "减持",
  unlock: "解禁",
  order_book_depth: "委托簿深度",
  realized_slippage: "实际滑点",
  tick_trade_data: "逐笔成交",
  price_limit_rule: "涨跌停规则",
  t_plus_one: "T+1交易规则",
  price: "价格",
  volume: "成交量",
  amount: "成交额",
  turnover_rate: "换手率",
  policy_stage: "政策阶段",
  transmission_chain: "传导链条",
  realization_window: "兑现窗口",
  observed_at: "观测时间",
  research_cutoff_at: "研究截止时间",
  market_as_of: "行情时间",
  research_ready: "研究条件",
  trade_ready: "交易计划条件",
  insufficient_data: "部分条件待确认",
  research_only: "研究模式",
  reference_plan: "参考计划",
  execution_blocked: "执行条件受限",
  failed: "未通过",
  unavailable: "暂不可用",
  ready: "已形成",
  blocked: "受限",
  limited: "有限",
};

/** Stable user-facing names for deterministic factor fields. Unknown machine
 * keys are intentionally collapsed instead of leaking internal identifiers. */
const FACTOR_LABELS: Record<string, string> = {
  momentum20: "20日动量",
  momentum60: "60日动量",
  volatility20: "20日波动",
  volume: "成交量",
  turnover: "换手率",
  turnover_rate: "换手率",
  revenue_yoy: "营收增长",
  revenue_growth: "营收增长",
  revenue_growth_rate: "营收增长",
  profit_yoy: "利润增长",
  profit_growth: "利润增长",
  net_profit_growth: "利润增长",
  roe: "ROE",
  roic: "ROIC",
  pe: "市盈率PE",
  pb: "市净率PB",
  operating_cashflow: "经营现金流",
  operating_cash_flow: "经营现金流",
  cashflow: "经营现金流",
  debt_ratio: "负债率",
  debt_to_assets: "负债率",
  leverage: "负债率",
  eps: "每股收益EPS",
  earnings_per_share: "每股收益EPS",
  governance: "治理",
  corporate_governance: "治理",
  gross_margin: "毛利率",
  net_margin: "净利率",
  net_profit: "净利润",
  growth_stability: "盈利稳定性",
  cashflow_to_profit: "现金流利润比",
  interest_coverage: "利息保障倍数",
  current_ratio: "流动比率",
  capex_to_cashflow: "资本开支现金流比",
  cashflow_yield: "现金流收益率",
  audit_qualification: "审计意见风险",
  restatement_count: "财报重述次数",
  dilution_ratio: "股本稀释比例",
  pledge_ratio: "股权质押比例",
  related_party_transactions: "关联交易次数",
  price: "价格",
  listing_days: "上市天数",
};

function normalizeFactorKey(value: string): string {
  return value.trim().toLowerCase()
    .replace(/^(?:indicators|fundamentals|quant|factor)[._]/, "")
    .replace(/(\d)(?:_?days?|_?d)$/i, "$1")
    .replace(/-/g, "_");
}

const LEGACY_DIAGNOSIS_FACTOR_ORDER = [
  "roe", "roic", "gross_margin", "net_margin", "revenue_yoy", "profit_yoy",
  "growth_stability", "operating_cashflow", "cashflow_to_profit", "debt_ratio",
  "interest_coverage", "current_ratio", "capex_to_cashflow", "pe", "pb",
  "cashflow_yield", "audit_qualification", "restatement_count", "dilution_ratio",
  "pledge_ratio", "related_party_transactions",
];

export function factorLabel(value: string | null | undefined): string {
  const legacy = value ? /^factor_(\d+)$/i.exec(value.trim()) : null;
  const normalizedValue = legacy
    ? LEGACY_DIAGNOSIS_FACTOR_ORDER[Number(legacy[1]) - 1]
    : value;
  const key = normalizedValue ? normalizeFactorKey(normalizedValue) : "";
  if (FACTOR_LABELS[key]) return FACTOR_LABELS[key];
  if (value && /^[\u4e00-\u9fff][\u4e00-\u9fff\s/（）()·-]*$/.test(value.trim())) return value.trim();
  return "其他因子";
}

/** V4 evidence values are rendered through explicit allowlists. Unknown
 * machine values must never become the user's primary copy. */
export const RESEARCH_STATUS_LABELS: Record<string, string> = {
  available: "数据可用",
  complete: "数据完整",
  degraded: "部分条件待确认",
  missing: "部分条件待确认",
  insufficient_data: "部分条件待确认，暂无法判断",
  mixed: "不同周期结论不一致",
  aligned: "不同周期结论一致",
  published: "已发布",
  planned: "已安排",
  completed: "已完成",
  confirmed: "已确认",
  pending: "待确认",
  cancelled: "已取消",
  failed: "未通过",
  ready: "已形成",
  unavailable: "暂不可用",
  blocked: "受限",
  limited: "有限",
};

const CONDITION_OPERATOR_LABELS: Record<string, string> = {
  gt: "大于",
  gte: "大于或等于",
  lt: "小于",
  lte: "小于或等于",
  crosses_above: "向上突破",
  crosses_below: "向下跌破",
  ">": "大于",
  ">=": "大于或等于",
  "<": "小于",
  "<=": "小于或等于",
};

const METRIC_LABELS: Record<string, string> = {
  "quote.close": "收盘价",
  "quote.price": "最新价",
  "quote.change_pct": "涨跌幅",
  "quote.volume": "成交量",
  "quote.amount": "成交额",
  "indicators.swing.support": "支撑位",
  "indicators.swing.resistance": "压力位",
  "indicators.ma5": "5日均线",
  "indicators.ma20": "20日均线",
  "indicators.ma60": "60日均线",
  "indicators.momentum20": "20日动量",
  "indicators.momentum60": "60日动量",
  "indicators.volatility20": "20日波动率",
  "fundamentals.operating_cashflow": "经营现金流",
  "fundamentals.roe": "净资产收益率",
  "fundamentals.roic": "投入资本回报率",
  "valuation.peer_valuation": "同行估值位置",
  "market.breadth": "市场宽度参考",
  "market.turnover_amount": "市场成交额",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  announcement: "公告事件",
  periodic_report: "定期报告",
  earnings: "业绩披露",
  earnings_report: "业绩报告",
  earnings_forecast: "业绩预告",
  performance_forecast: "业绩预告",
  earnings_express: "业绩快报",
  dividend: "利润分配",
  cash_dividend: "现金分红",
  buyback: "股份回购",
  share_unlock: "限售股解禁",
  share_reduction: "股东减持",
  share_increase: "股东增持",
  share_change: "股东持股变化",
  share_pledge: "股份质押",
  pledge: "股份质押",
  financing: "融资事项",
  capital_change: "资本变动",
  guarantee: "对外担保",
  restructuring: "资产重组",
  merger: "并购事项",
  regulatory: "监管事项",
  risk_warning: "风险提示",
  litigation: "诉讼事项",
  inquiry: "监管问询",
  suspension: "停复牌事项",
  major_contract: "重大合同",
  contract: "合同事项",
  project: "重大项目",
  major_matter: "重大事项",
  major_event: "重大事件",
  shareholder_change: "股东变化",
};

const PROVIDER_LABELS: Record<string, string> = {
  eastmoney: "东方财富",
  tencent: "腾讯行情",
  government: "政府公开信息",
  gov: "政府公开信息",
  exchange: "交易所公开信息",
  cninfo: "巨潮资讯",
};

const CYCLE_LABELS: Record<string, string> = {
  policy: "宏观与流动性周期",
  industry: "行业供需与产品价格周期",
  earnings: "公司盈利与现金流周期",
  valuation: "市场风格与筹码周期",
};

const EVIDENCE_TYPED_VALUE_LABELS: Record<string, string> = {
  status: "状态",
  data_status: "数据状态",
  event_status: "事件状态",
  event_type: "事件类型",
  provider: "数据提供方",
  operator: "运算方式",
  observed_metric_ref: "观测指标",
  threshold_metric_ref: "阈值指标",
};
const EVIDENCE_METRIC_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])(${Object.keys(METRIC_LABELS)
    .sort((left, right) => right.length - left.length)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?=$|[^A-Za-z0-9_])`,
  "g",
);
const EVIDENCE_FIELD_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])(${Object.keys(FIELD_LABELS)
    .sort((left, right) => right.length - left.length)
    .join("|")})(?=$|[^A-Za-z0-9_])`,
  "g",
);
const EVIDENCE_TYPED_VALUE_PATTERN =
  /\b(status|data_status|event_status|event_type|provider|operator|observed_metric_ref|threshold_metric_ref)\s*[:=]\s*([A-Za-z0-9_.-]+)/g;
const EVIDENCE_HORIZON_LABELS: Record<string, string> = {
  short_term: "短线",
  medium_term: "中线",
  long_term: "长线",
};
const EVIDENCE_HORIZON_PATTERN = /(^|[^A-Za-z0-9_])(short_term|medium_term|long_term)(?=$|[^A-Za-z0-9_])/g;
const EVIDENCE_HORIZON_GATE_PATTERN = /(^|[^A-Za-z0-9_])(short_term|medium_term|long_term)[._:-](research_ready|trade_ready)(?=$|[^A-Za-z0-9_])/gi;

const INTERNAL_TEXT_LABELS: Record<string, string> = {
  research_ready: "研究条件",
  trade_ready: "交易计划条件",
  insufficient_data: "部分条件待确认",
  research_only: "研究模式",
  reference_plan: "参考计划",
  execution_blocked: "执行条件受限",
  source_id: "证据来源",
  source_ids: "证据来源",
  eastmoney: "东方财富",
  push2: "行情接口",
  api: "数据接口",
};
const INTERNAL_TEXT_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])(${Object.keys(INTERNAL_TEXT_LABELS).join("|")})(?=$|[^A-Za-z0-9_])`,
  "gi",
);
const INTERNAL_MARKET_DATA_PROVIDER_PATTERN = /(^|[^A-Za-z0-9_])(?:eastmoney\s+)?push2(?:\s+api)?(?:\s*连接中断)?(?=$|[^A-Za-z0-9_])/gi;

const HTML_ENTITY_LABELS: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

const EVIDENCE_GAP_TEXT = ["证据", "不足"].join("");
const DATA_GAP_TEXT = ["数据", "不足"].join("");

function decodeEvidenceHtmlEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (match, hex, decimal, named) => {
    if (hex || decimal) {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return HTML_ENTITY_LABELS[String(named).toLowerCase()] ?? match;
  });
}

export function researchStatusLabel(value: string | null | undefined): string {
  return value ? RESEARCH_STATUS_LABELS[value] ?? "状态待确认" : "未提供";
}

export function conditionOperatorLabel(value: string | null | undefined): string {
  return value ? CONDITION_OPERATOR_LABELS[value] ?? "运算方式待确认" : "未提供";
}

export function metricLabel(value: string | null | undefined): string {
  const key = value?.trim();
  if (!key) return "未提供";
  const label = METRIC_LABELS[key];
  if (label) return label;
  return /[\u4e00-\u9fff]/.test(key) && !/[A-Za-z_]/.test(key)
    ? key
    : "观测指标待确认";
}

export function eventTypeLabel(value: string | null | undefined): string {
  const key = value?.trim();
  if (!key) return "事件类型待确认";
  return EVENT_TYPE_LABELS[key] ?? (/^[\u4e00-\u9fff]+$/.test(key) ? key : "公告事件");
}

export function providerLabel(value: string | null | undefined): string {
  const key = value?.trim().toLowerCase();
  return key ? PROVIDER_LABELS[key] ?? "来源提供方待确认" : "未提供";
}

export function cycleLabel(value: string | null | undefined): string {
  return value ? CYCLE_LABELS[value] ?? "周期类型待确认" : "周期类型待确认";
}

export function claimTypeLabel(value: string | null | undefined): string {
  if (value === "fact") return "事实";
  if (value === "inference") return "推断";
  if (value === "hypothesis") return "假设";
  return "证据类型待确认";
}

export function researchEvidenceStrengthLabel(value: string | null | undefined): string {
  if (value === "low") return "有限";
  if (value === "medium") return "中等";
  if (value === "high") return "较强";
  return "待确认";
}

export function safeUserValue(value: string | null | undefined, fallback: string): string {
  const text = value?.trim();
  if (!text) return fallback;
  return /^[A-Za-z0-9_.:-]+$/.test(text) ? fallback : text;
}

export function periodLabel(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return "未提供";
  const normalized = text
    .replace(/(\d{4})H1\b/gi, "$1年上半年")
    .replace(/(\d{4})H2\b/gi, "$1年下半年")
    .replace(/(\d{4})Q([1-4])\b/gi, "$1年第$2季度");
  return normalized === text && /^[A-Za-z0-9_.:-]+$/.test(text)
    ? "观察窗口待确认"
    : normalized;
}

export function evidenceTextLabel(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  const text = decodeEvidenceHtmlEntities(value)
    .replace(new RegExp(EVIDENCE_GAP_TEXT, "g"), "关键条件待确认")
    .replace(new RegExp(DATA_GAP_TEXT, "g"), "部分条件待确认");
  if (!text) return "";
  const exactStatus = RESEARCH_STATUS_LABELS[text.trim()];
  if (exactStatus) return text.replace(text.trim(), exactStatus);
  const exactEventType = eventTypeLabel(text.trim());
  if (EVENT_TYPE_LABELS[text.trim()]) return text.replace(text.trim(), exactEventType);
  return text
    .replace(EVIDENCE_TYPED_VALUE_PATTERN, (_match, key: string, rawValue: string) => {
      const valueLabel =
        key === "operator"
          ? conditionOperatorLabel(rawValue)
          : key.includes("metric")
            ? metricLabel(rawValue)
            : key === "event_type"
              ? eventTypeLabel(rawValue)
              : key === "provider"
                ? providerLabel(rawValue)
                : researchStatusLabel(rawValue);
      return `${EVIDENCE_TYPED_VALUE_LABELS[key]}：${valueLabel}`;
    })
    .replace(EVIDENCE_HORIZON_GATE_PATTERN, (_match, boundary: string, horizon: string, gate: string) => {
      const horizonLabel = EVIDENCE_HORIZON_LABELS[horizon.toLowerCase()] ?? "观察周期";
      const gateLabel = gate.toLowerCase() === "research_ready" ? "研究条件" : "交易计划条件";
      return `${boundary}${horizonLabel}${gateLabel}`;
    })
    .replace(INTERNAL_MARKET_DATA_PROVIDER_PATTERN, (_match, boundary: string) => `${boundary}数据源暂不可用`)
    .replace(INTERNAL_TEXT_PATTERN, (_match, boundary: string, token: string) => `${boundary}${INTERNAL_TEXT_LABELS[token.toLowerCase()] ?? token}`)
    .replace(EVIDENCE_HORIZON_PATTERN, (_match, boundary: string, token: string) => `${boundary}${EVIDENCE_HORIZON_LABELS[token]}`)
    .replace(EVIDENCE_METRIC_PATTERN, (_match, boundary: string, token: string) => `${boundary}${METRIC_LABELS[token]}`)
    .replace(EVIDENCE_FIELD_PATTERN, (_match, boundary: string, token: string) => `${boundary}${FIELD_LABELS[token]}`);
}

const THESIS_STATUS_LABELS: Record<string, string> = {
  available: "可用",
  complete: "数据完整",
  degraded: "部分缺失",
  missing: "缺失",
  insufficient_data: "部分条件待确认",
};
const THESIS_STATUS_TOKEN_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])(${Object.keys(THESIS_STATUS_LABELS).join("|")})([:：])`,
  "g",
);
const FIELD_TOKEN_PATTERN = new RegExp(
  `\\b(${Object.keys(FIELD_LABELS).sort((left, right) => right.length - left.length).join("|")})\\b`,
  "g",
);

export function stanceLabel(stance: string | null | undefined): string {
  if (!stance) return "—";
  return STANCE_LABELS[stance as StockStance] ?? stance;
}

export function dataQualityLabel(quality: string | null | undefined): string {
  if (!quality) return "—";
  return DATA_QUALITY_LABELS[quality] ?? quality;
}

export function timeHorizonLabel(value: string | null | undefined): string {
  if (value === "long_term") return "长线";
  return value && value in TIME_HORIZON_LABELS
    ? TIME_HORIZON_LABELS[value as StockTimeHorizon]
    : "未提供";
}

export function evidenceStrengthLabel(value: string | null | undefined): string {
  return value && value in EVIDENCE_STRENGTH_LABELS
    ? EVIDENCE_STRENGTH_LABELS[value as StockEvidenceStrength]
    : "未提供";
}

export function fieldLabel(value: string | null | undefined): string {
  const key = value?.trim();
  if (!key) return "未命名字段";
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  return /[\u4e00-\u9fff]/.test(key) && !/[A-Za-z_]/.test(key)
    ? key
    : "其他研究信息";
}

export function missingFieldsLabel(values: string[] | undefined): string {
  return values?.length ? values.map(fieldLabel).join("、") : "无";
}

export function evidenceCountLabel(sourceIds: string[] | undefined): string {
  return `${sourceIds?.length ?? 0} 条证据`;
}

export function thesisLabel(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return "未提供";
  return text
    .replace(new RegExp(EVIDENCE_GAP_TEXT, "g"), "关键条件待确认")
    .replace(new RegExp(DATA_GAP_TEXT, "g"), "部分条件待确认")
    .replace(
    THESIS_STATUS_TOKEN_PATTERN,
    (_match, boundary: string, token: string, punctuation: string) =>
      `${boundary}${THESIS_STATUS_LABELS[token]}${punctuation === ":" ? "：" : punctuation}`,
    );
}

export function schemaTextLabel(value: string | null | undefined): string {
  const text = value ?? "";
  return text.replace(FIELD_TOKEN_PATTERN, (token) => FIELD_LABELS[token] ?? token);
}
