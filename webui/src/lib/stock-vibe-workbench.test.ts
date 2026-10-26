import { describe, expect, it } from "vitest";
import { stockReportExcerpt } from "./stock-vibe-workbench";

describe("workbench report excerpt", () => {
  it("shows actual findings before source boilerplate and tables without inventing a summary", () => {
    const finding = "- 趋势：最近七个交易日持续回落，最新成交量高于此前数日，需要结合报告证据继续核对。";
    const report = `## 量价简报\n\n**数据来源**：腾讯行情，前复权，成交量单位为手。\n数据区间：最近七个交易日。\n\n| 日期 | 收盘 |\n| -- | -- |\n| 10-16 | 39.29 |\n\n### 量价观察\n\n${finding}`;
    expect(stockReportExcerpt(report)).toBe(finding);
  });
});
