import type { StockVibeOpportunityCandidate } from "@/lib/stock-vibe-opportunity-api";

const RANK_LINE = /^在本次\s*(\d+)\s*只可排序股票中，模型将其排在第\s*(\d+)\s*位。?$/;
const CHANGE_LINE = /^近20个交易日复权价格变化\s*([+\-−]?\s*\d+(?:\.\d+)?)%\s*[；;]这是行情事实，不是未来涨幅预测。?$/;
const COVERAGE_LINE = /^本次模型使用\s*\d+\s*项经去重的信号，其中这只股票有\s*\d+\s*项实际观测值。?$/;
const DRAWDOWN_LINE = /^近20日区间内最大回撤\s*[:：]?\s*([+\-−]?\s*\d+(?:\.\d+)?)%\.?$/;
const ANNUAL_VOLATILITY_LINE = /^近20日年化波动率\s*[-+−]?\s*\d+(?:\.\d+)?%，?仅描述历史波动。?$/;

function isInternalFactorLine(line: string): boolean {
  return /\b(?:GTJA|Alpha)\s*#?\s*\d+\b/i.test(line)
    || /对本次研究分数贡献|因子贡献/.test(line);
}

function absolutePercent(value: string): string {
  return String(Math.abs(Number(value.replace(/[−\s]/g, (part) => part === "−" ? "-" : ""))));
}

type Signal = NonNullable<StockVibeOpportunityCandidate["contributions"]>[number];

// Labels follow the native formulas, including their limits, rather than inferred company fundamentals.
const SIGNAL_LABELS: Record<string, string> = {
  gtja191_143: "上涨日累计表现（不扣下跌日）",
  gtja191_150: "价格与成交量规模",
  gtja191_010: "价格与波动的组合特征",
  gtja191_175: "近6日价格振幅（含跳空）",
  gtja191_159: "多周期价格位置组合",
  gtja191_149: "下跌日价格联动",
  gtja191_158: "当日价格振幅",
  gtja191_164: "上涨幅度与振幅的组合特征",
  alpha101_024: "长期位置与短期价格变化的组合特征",
  alpha101_040: "价格起伏与成交量的关系",
  academic_illiq: "单位成交规模对应的价格变化",
};

function signalLabel(signal: Signal): string | undefined {
  if (SIGNAL_LABELS[signal.factor_id]) return SIGNAL_LABELS[signal.factor_id];
  const qlib = signal.factor_id.match(/^qlib158_(std|cord|min|max)(\d+)$/);
  if (qlib) {
    const [, kind, days] = qlib;
    return ({ std: `${days}日收盘价起伏程度`, cord: `${days}日价格与成交量变化的关联`,
      min: `${days}日低点与现价的比值`, max: `${days}日高点与现价的比值` } as Record<string, string>)[kind];
  }
  const name = signal.name?.trim();
  return name && /[\u4e00-\u9fff]/.test(name) && !isInternalFactorLine(name)
    && !/Alpha|Kakushadze|因子|信号编号/i.test(name) ? name : undefined;
}

function signalReasons(candidate: StockVibeOpportunityCandidate, positive: boolean): string[] {
  return (candidate.contributions ?? [])
    .filter((item) => item.imputed !== true && typeof item.contribution === "number" && Number.isFinite(item.contribution)
      && (positive ? item.contribution > 0 : item.contribution < 0)
      && [item.value, item.standardized_value].some((value) => typeof value === "number" && Number.isFinite(value)))
    .sort((a, b) => Math.abs(b.contribution!) - Math.abs(a.contribution!))
    .flatMap((item) => {
      const label = signalLabel(item);
      if (!label) return [];
      const value = item.standardized_value;
      const comparison = typeof value === "number" && Number.isFinite(value)
        ? value > 0 ? "高于同批股票平均，" : value < 0 ? "低于同批股票平均，" : "处于同批股票平均水平，"
        : "";
      return [`${label}：${comparison}${positive ? "为本次入选提供支持" : "对本次筛选形成减分"}。`];
    }).slice(0, 2);
}

export function candidateSupport(candidate: StockVibeOpportunityCandidate): string[] {
  const ordinary: string[] = [];
  for (const line of candidate.support ?? []) {
    if (COVERAGE_LINE.test(line) || isInternalFactorLine(line) || RANK_LINE.test(line)
      || /^本次筛选排第\d+位/.test(line) || CHANGE_LINE.test(line)) continue;
    ordinary.push(line);
  }
  return [...new Set([...ordinary, ...signalReasons(candidate, true)])];
}

export function candidateRisks(candidate: StockVibeOpportunityCandidate): string[] {
  const drawdowns: string[] = [];
  const otherRisks: string[] = [];

  for (const line of candidate.risks ?? []) {
    if (isInternalFactorLine(line)) continue;

    const drawdownMatch = line.match(DRAWDOWN_LINE);
    if (drawdownMatch) {
      drawdowns.push(`近20个交易日曾从高点回落${absolutePercent(drawdownMatch[1])}%`);
      continue;
    }

    if (ANNUAL_VOLATILITY_LINE.test(line)) {
      otherRisks.push("需关注近期价格波动");
      continue;
    }

    otherRisks.push(line);
  }

  return [...new Set([...drawdowns, ...signalReasons(candidate, false), ...otherRisks])];
}
