import { describe, expect, it } from "vitest";

import type { StockVibeOpportunityCandidate } from "@/lib/stock-vibe-opportunity-api";
import { candidateRisks, candidateSupport } from "./stock-vibe-opportunity-display";

function candidate(overrides: Partial<StockVibeOpportunityCandidate> = {}): StockVibeOpportunityCandidate {
  return { symbol: "600000.SH", support: [], risks: [], ...overrides };
}

describe("opportunity candidate display text", () => {
  it("keeps recent strength as raw factor evidence instead of an independent display", () => {
    expect(candidateSupport(candidate({
      rank: 1,
      support: [
        "在本次237只可排序股票中，模型将其排在第1位。",
        "本次模型使用16项经去重的信号，其中这只股票有16项实际观测值。",
        "近20个交易日复权价格变化-24.1%；这是行情事实，不是未来涨幅预测。",
        "GTJA Alpha #175：对本次研究分数贡献-0.00062",
      ],
    }))).toEqual([]);
  });

  it("keeps ordinary Chinese research text without adding recent zero-change strength", () => {
    expect(candidateSupport(candidate({
      rank: 2,
      support: [
        "近20个交易日复权价格变化0%；这是行情事实，不是未来涨幅预测。",
        "公司近期披露了新的订单进展。",
      ],
    }))).toEqual([
      "公司近期披露了新的订单进展。",
    ]);
  });

  it("explains the actual strongest observed signals instead of repeating rank", () => {
    const item = candidate({ rank: 1, support: ["在本次237只可排序股票中，模型将其排在第1位。"], contributions: [
      { factor_id: "gtja191_150", value: 108511328896, standardized_value: 2.08, contribution: .00076, imputed: false },
      { factor_id: "gtja191_143", value: 5577372.76, standardized_value: 10.43, contribution: .00808, imputed: false },
      { factor_id: "gtja191_175", value: 7.2, standardized_value: 1.74, contribution: -.00062, imputed: false },
    ] });
    expect(candidateSupport(item)).toEqual([
      "上涨日累计表现（不扣下跌日）：高于同批股票平均，为本次入选提供支持。",
      "价格与成交量规模：高于同批股票平均，为本次入选提供支持。",
    ]);
    expect(candidateRisks(item)).toEqual([
      "近6日价格振幅（含跳空）：高于同批股票平均，对本次筛选形成减分。",
    ]);
    expect(item.contributions?.[0].factor_id).toBe("gtja191_150");
  });

  it("uses model contribution direction rather than assuming a higher indicator is better", () => {
    expect(candidateSupport(candidate({ contributions: [
      { factor_id: "qlib158_std20", value: .03, standardized_value: -1.2, contribution: .002 },
      { factor_id: "academic_illiq", value: -.8, standardized_value: -.6, contribution: .001 },
    ] }))).toEqual([
      "20日收盘价起伏程度：低于同批股票平均，为本次入选提供支持。",
      "单位成交规模对应的价格变化：低于同批股票平均，为本次入选提供支持。",
    ]);
  });

  it("does not turn imputed values or uninterpreted codes into observed reasons", () => {
    expect(candidateSupport(candidate({ rank: 1, contributions: [
      { factor_id: "gtja191_143", value: 5, standardized_value: 2, contribution: .2, imputed: true },
      { factor_id: "unknown", name: "GTJA Alpha #999", value: 3, contribution: .3 },
      { factor_id: "qlib158_std20", value: .01, standardized_value: -1, contribution: 0 },
    ] }))).toEqual([]);
  });

  it("keeps unknown comparison levels unknown and does not invent a relative strength fact", () => {
    expect(candidateSupport(candidate({ contributions: [
      { factor_id: "gtja191_150", value: 30, contribution: .001 },
    ] }))).toEqual(["价格与成交量规模：为本次入选提供支持。"]);
  });

  it("does not invent rank, price movement, or positive conclusions when evidence is missing", () => {
    expect(candidateSupport(candidate({ support: [] }))).toEqual([]);
    expect(candidateRisks(candidate({ risks: [] }))).toEqual([]);
  });

  it("shows drawdown first and does not turn annualized volatility into a price loss", () => {
    expect(candidateRisks(candidate({
      risks: [
        "近20日年化波动率45.7%，仅描述历史波动",
        "近20日区间内最大回撤 -24.3%",
        "公告披露时间需要进一步核实。",
      ],
    }))).toEqual([
      "近20个交易日曾从高点回落24.3%",
      "需关注近期价格波动",
      "公告披露时间需要进一步核实。",
    ]);
  });
});
