import type { StockVibeResearchTask, StockVibeScenarioMode } from "./stock-vibe-api";

export const STOCK_RESEARCH_TASKS: Record<StockVibeResearchTask, { label: string; question: string }> = {
  comprehensive: { label: "综合分析", question: "综合研究这只股票的公司经营、估值、近期价量与主要风险。先核实最新可用资料，区分事实、假设和缺项，保留引用与数据时点，给出值得继续核实的问题。" },
  fundamental: { label: "财报与估值", question: "研究这家公司的最新财报、盈利质量、现金流、负债与估值。使用原生财务工具和估值方法，写明财报期间、来源及假设；资料不足时明确缺项，不编造财务数值或合理价。" },
  technical: { label: "走势分析", question: "基于真实历史行情分析近期趋势、成交变化和可核对的技术特征。解释图上发生了什么，标明数据区间与来源，区分历史事实和待验证判断，不把技术指标当未来上涨概率。" },
  risk: { label: "风险检查", question: "检查这只股票的经营、财务、事件、流动性和波动风险，给出来源、时点与信息缺口。没有真实持仓时只分析标的风险，不编造我的资产、仓位或个人风险承受能力。" },
};

export const STOCK_RESEARCH_MODES: Record<StockVibeScenarioMode, string> = {
  ultrashort: "超短线", swing: "波段", medium: "中短线",
};

export function stockResearchPrompt(symbol: string, mode: StockVibeScenarioMode, task: StockVibeResearchTask): string {
  return `标的：${symbol}\n研究周期：${STOCK_RESEARCH_MODES[mode]}\n${STOCK_RESEARCH_TASKS[task].question}\n这是一项研究任务，不执行买卖。关键数值必须有来源和时点，不能用模型记忆补齐行情或财报。`;
}

export function stockReportExcerpt(summary: string): string {
  return summary.split(/\n\s*\n/).map((line) => line.replace(/^#{1,6}\s+/gm, "").replace(/[*`]/g, "").trim())
    .find((line) => line.length > 20 && !line.startsWith("|")
      && !/^(?:[-•]\s*)?(?:数据来源|数据区间|研究周期|研究范围|报告时间|声明|免责声明)\s*[:：]/.test(line))?.slice(0, 360)
    ?? summary.replace(/[#*`]/g, "").trim().slice(0, 360);
}

export function stockTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "时间未报告";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}
