import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { StockIntradayPoint, StockIntradaySeries } from "@/lib/stock-api";
import {
  buildIntradayPaths,
  buildIntradayVolumeBars,
  IntradayChart,
  intradayMinuteRatio,
  intradayTooltip,
  splitIntradayPoints,
  summarizeIntraday,
  symmetricPriceDomain,
} from "./IntradayChart";

const source = {
  id: "src_test",
  provider: "tencent",
  url: "https://example.test",
  publishedAt: null,
  fetchedAt: "2026-08-18T10:00:00+08:00",
  contentHash: "sha256:test",
  fields: [],
};

function point(time: string, price: number, volume = 100): StockIntradayPoint {
  return {
    time: `2026-08-18T${time}:00+08:00`,
    open: price,
    high: price + 0.1,
    low: price - 0.1,
    close: price,
    price,
    average: price - 0.02,
    volume,
    amount: volume * 1000,
  };
}

const points = [
  point("09:30", 10.1),
  point("11:30", 10.2),
  point("13:00", 10.15),
  point("15:00", 10.3, 200),
];

function series(overrides: Partial<StockIntradaySeries> = {}): StockIntradaySeries {
  return {
    instrumentId: "XSHE:000001",
    instrumentType: "equity",
    tradingDate: "2026-08-18",
    previousClose: 10,
    status: "trading",
    asOf: points.at(-1)?.time ?? null,
    source,
    points,
    stale: false,
    quality: "degraded",
    error: null,
    ...overrides,
  };
}

describe("IntradayChart pure layout functions", () => {
  it("maps fixed morning and afternoon sessions without lunch time", () => {
    expect(intradayMinuteRatio("2026-08-18T09:30:00+08:00")).toBe(0);
    expect(intradayMinuteRatio("2026-08-18T11:30:00+08:00")).toBe(0.5);
    expect(intradayMinuteRatio("2026-08-18T12:00:00+08:00")).toBeNull();
    expect(intradayMinuteRatio("2026-08-18T13:00:00+08:00")).toBe(0.5);
    expect(intradayMinuteRatio("2026-08-18T15:00:00+08:00")).toBe(1);
  });

  it("keeps the price domain symmetric around previous close", () => {
    const domain = symmetricPriceDomain(10, [point("09:30", 10.5), point("10:00", 9.8)]);
    expect(domain.previousClose).toBe(10);
    expect(domain.min).toBe(9.4);
    expect(domain.max).toBe(10.6);
  });

  it("splits price and average paths at the lunch boundary", () => {
    const domain = symmetricPriceDomain(10, points);
    const segments = splitIntradayPoints(points);
    expect(segments.map((segment) => segment.map((item) => item.time.slice(11, 16)))).toEqual([
      ["09:30", "11:30"],
      ["13:00", "15:00"],
    ]);
    expect(buildIntradayPaths(points, "price", 40, 600, domain)).toHaveLength(2);
    expect(buildIntradayPaths(points, "average", 40, 600, domain)).toHaveLength(2);
  });

  it("keeps volume and tooltip values in backend units", () => {
    const bars = buildIntradayVolumeBars(points, 40, 600);
    expect(bars).toHaveLength(4);
    expect(summarizeIntraday(series()).volume).toBe(500);
    expect(summarizeIntraday(series()).amount).toBe(500000);
    expect(intradayTooltip(points[0], 10)).toMatchObject({
      price: 10.1,
      average: 10.08,
      volume: 100,
      amount: 100000,
    });
  });
});

describe("IntradayChart", () => {
  it("renders separate session paths and identifies Tencent as backup", () => {
    const { container } = render(<IntradayChart series={series()} />);
    expect(screen.getByRole("img", { name: "分时图" })).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="intraday-price-path"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="intraday-average-path"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="intraday-volume-bar"]')).toHaveLength(4);
    expect(screen.getByText("11:30/13:00")).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="intraday-session-midline"]')).toHaveLength(1);
    expect(screen.getAllByText("腾讯行情 · 备用行情").length).toBeGreaterThan(0);
    expect(screen.queryByText("备用行情", { exact: true })).toBeNull();
    expect(screen.getByText("500手")).toBeTruthy();
  });

  it("keeps a stale snapshot visible while showing the reconnect state", () => {
    render(
      <IntradayChart
        series={series({ stale: true, error: "upstream timeout" })}
        disconnected
        error="分时连接已断开"
      />,
    );
    expect(screen.getByRole("img", { name: "分时图" })).toBeTruthy();
    expect(screen.getByText("分时连接已断开")).toBeTruthy();
  });

  it("does not warn when a stale/disconnected closed snapshot reaches 15:00", () => {
    render(
      <IntradayChart
        series={series({ status: "closed", stale: true, error: "upstream timeout" })}
        disconnected
        error="分时连接已断开，正在重连"
      />,
    );
    expect(screen.getByRole("img", { name: "分时图" })).toBeTruthy();
    expect(screen.queryByText("已收盘，显示最近快照")).toBeNull();
    expect(screen.queryByText("收盘快照暂未补齐，图表显示最近可用数据")).toBeNull();
    expect(screen.queryByText(/连接中断|正在重连/)).toBeNull();
  });

  it("warns when a closed snapshot ends before 15:00", () => {
    render(
      <IntradayChart
        series={series({
          status: "closed",
          stale: true,
          points: [...points.slice(0, 3), point("14:03", 10.25)],
        })}
        disconnected
        error="分时连接已断开，正在重连"
      />,
    );
    expect(screen.getByText("已收盘，显示最近快照")).toBeTruthy();
    expect(screen.getByText("收盘快照暂未补齐，图表显示最近可用数据")).toBeTruthy();
    expect(screen.queryByText(/连接中断|正在重连/)).toBeNull();
  });
});
