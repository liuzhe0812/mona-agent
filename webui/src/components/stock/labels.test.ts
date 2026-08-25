import { describe, expect, it } from "vitest";

import { dataQualityLabel, evidenceTextLabel, factorLabel, stanceLabel, thesisLabel } from "./labels";

describe("evidenceTextLabel", () => {
  it("cleans the run_958 historical analyst wording into business Chinese", () => {
    const value = evidenceTextLabel(
      "短线研究结论不可用：quote 分区与衍生技术指标均缺失（EastMoney push2 API 连接中断导致 short_term.research_ready=failed、trade_ready=unavailable、market_regime、tradeability、source_ids 全部不可用）",
    );

    expect(value).toContain("行情报价");
    expect(value).toContain("数据源暂不可用");
    expect(value).toContain("短线研究条件=未通过");
    expect(value).toContain("交易计划条件=暂不可用");
    expect(value).toContain("市场状态");
    expect(value).toContain("交易可行性");
    expect(value).toContain("证据来源");
    expect(value).not.toMatch(/quote|EastMoney|push2|\bAPI\b|research_ready|trade_ready|market_regime|tradeability|source_ids/);
  });

  it("decodes HTML entities without changing the meaning", () => {
    expect(evidenceTextLabel("指标可用&#x20;但暂不能形成短线结论&#x20;&amp;&#x20;交易计划")).toBe(
      "指标可用 但暂不能形成短线结论 & 交易计划",
    );
  });

  it("keeps standard financial and technical terms", () => {
    const terms = "PE/PB/ROE/ROIC/MACD/RSI/ATR";
    expect(evidenceTextLabel(`${terms} 用于专业指标说明`)).toBe(`${terms} 用于专业指标说明`);
  });
});

describe("business-facing stock labels", () => {
  it("maps deterministic factor keys and hides unknown internal names", () => {
    expect(factorLabel("momentum20")).toBe("20日动量");
    expect(factorLabel("fundamentals.operating_cashflow")).toBe("经营现金流");
    expect(factorLabel("revenue_yoy")).toBe("营收增长");
    expect(factorLabel("custom_internal_factor")).toBe("其他因子");
    expect(["momentum20", "operating_cashflow", "custom_internal_factor"].map(factorLabel).join(" ")).not.toMatch(/momentum20|operating_cashflow|custom_internal_factor/);
  });

  it("recovers factor names from legacy diagnosis reports", () => {
    expect(factorLabel("factor_1")).toBe("ROE");
    expect(factorLabel("factor_6")).toBe("利润增长");
    expect(factorLabel("factor_15")).toBe("市净率PB");
    expect(factorLabel("factor_7")).toBe("盈利稳定性");
    expect(factorLabel("factor_9")).toBe("现金流利润比");
    expect(factorLabel("factor_16")).toBe("现金流收益率");
    expect(factorLabel("factor_21")).toBe("关联交易次数");
  });

  it("does not expose generic missing-data wording", () => {
    expect(stanceLabel("insufficient_data")).toBe("研究待更新");
    expect(dataQualityLabel("degraded")).toBe("部分条件待确认");
    expect(thesisLabel("短线insufficient_data：市场证据不足")).toBe(
      "短线部分条件待确认：市场关键条件待确认",
    );
    expect(`${stanceLabel("insufficient_data")} ${dataQualityLabel("degraded")}`).not.toMatch(
      /数据不足|证据不足/,
    );
  });
});
