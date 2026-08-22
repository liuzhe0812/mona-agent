import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  StockDashboardItem,
  StockIntradaySeries,
  StockReportDetail,
} from "@/lib/stock-api";

const fetchStockIntraday = vi.fn();
const openStockIntradayStream = vi.fn();

vi.mock("@/lib/stock-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stock-api")>();
  return {
    ...actual,
    fetchStockIntraday: (...args: unknown[]) => fetchStockIntraday(...args),
    openStockIntradayStream: (...args: unknown[]) => openStockIntradayStream(...args),
  };
});

import { InstrumentStage } from "./InstrumentStage";

const ITEM: StockDashboardItem = {
  instrumentId: "XSHE:002709",
  name: "天赐材料",
  instrumentType: "equity",
  focus: true,
  latest: null,
};

const INTRADAY: StockIntradaySeries = {
  instrumentId: ITEM.instrumentId,
  instrumentType: "equity",
  tradingDate: "2026-08-18",
  previousClose: 40,
  status: "closed",
  asOf: "2026-08-18T15:00:00+08:00",
  source: {
    provider: "eastmoney",
    fetchedAt: "2026-08-18T15:00:00+08:00",
    id: "qa",
    url: "https://example.test/intraday",
    publishedAt: null,
    contentHash: "qa",
    fields: [],
  },
  points: [],
  stale: false,
  quality: "complete",
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchStockIntraday.mockResolvedValue(INTRADAY);
  openStockIntradayStream.mockResolvedValue({ close: vi.fn() });
});

function renderStage(decisionSummaryOpen: boolean, reportDetail: StockReportDetail | null = null) {
  const props = {
    token: "",
    item: ITEM,
    quote: undefined,
    kline: null,
    klineState: "idle" as const,
    period: "daily" as const,
    onPeriodChange: () => undefined,
    onRetryKline: () => undefined,
    run: null,
    stepActivities: {},
    starting: false,
    cancellingRun: false,
    onStartRun: () => undefined,
    onCancelRun: () => undefined,
    reports: [],
    reportDetail,
    researchContext: null,
    onOpenReport: () => undefined,
    onDeleteReport: () => undefined,
  };
  const utils = render(
    <InstrumentStage {...props} decisionSummaryOpen={decisionSummaryOpen} />,
  );
  return {
    ...utils,
    rerenderOpen: (next: boolean) =>
      utils.rerender(<InstrumentStage {...props} decisionSummaryOpen={next} />),
  };
}

describe("InstrumentStage attention radar collapse", () => {
  it("removes the entire right column when closed", async () => {
    const { rerenderOpen } = renderStage(true);
    await waitFor(() => expect(openStockIntradayStream).toHaveBeenCalled());

    const panel = screen.getByRole("complementary", { name: "关注雷达" });
    const rootGrid = panel.parentElement;
    expect(rootGrid).toHaveClass("lg:grid-cols-[minmax(0,1fr)_336px]");
    expect(screen.getByRole("heading", { name: "关注雷达" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动深度投研" })).toBeInTheDocument();
    expect(screen.getByText("尚无投研结论")).toBeInTheDocument();

    rerenderOpen(false);

    expect(screen.queryByRole("complementary", { name: "关注雷达" })).not.toBeInTheDocument();
    expect(rootGrid).not.toHaveClass("lg:grid-cols-[minmax(0,1fr)_336px]");
    expect(rootGrid).toHaveClass("grid-cols-1");
    expect(screen.queryByRole("heading", { name: "关注雷达" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "启动深度投研" })).not.toBeInTheDocument();
    expect(screen.queryByText("尚无投研结论")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开关注雷达" })).not.toBeInTheDocument();

    rerenderOpen(true);

    expect(rootGrid).toHaveClass("lg:grid-cols-[minmax(0,1fr)_336px]");
    expect(screen.getByRole("heading", { name: "关注雷达" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动深度投研" })).toBeInTheDocument();
    expect(screen.getByText("尚无投研结论")).toBeInTheDocument();
  });

  it("only shows a more action when the card has a real destination", async () => {
    renderStage(true);
    await waitFor(() => expect(openStockIntradayStream).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: /技术状态.*更多/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看基本面详情" }));
    expect(screen.getByRole("tab", { name: "基本面" })).toHaveAttribute("aria-selected", "true");
  });

  it("uses user-facing wording in the empty research state", async () => {
    renderStage(true);
    await waitFor(() => expect(openStockIntradayStream).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("tab", { name: "投研" }));
    expect(screen.getByText(/可通过右侧操作启动深度投研/)).toBeInTheDocument();
    expect(screen.queryByText(/六位研究助手|证据包|六 Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Agent/)).not.toBeInTheDocument();
  });

  it("does not expose bare moving-average or volume abbreviations", async () => {
    renderStage(true);
    await waitFor(() => expect(openStockIntradayStream).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "日线" }));
    expect(screen.getByRole("button", { name: "周线" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "月线" })).toBeInTheDocument();
    expect(screen.getByText(/5日均线/)).toBeInTheDocument();
    expect(screen.getByText(/20日均线/)).toBeInTheDocument();
    expect(screen.queryByText(/^MA5\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^MA20\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bVOL\b/)).not.toBeInTheDocument();
  });

  it("uses clear wording for legacy report conditions", async () => {
    renderStage(true, {
      report: {
        schema_version: 3,
        kind: "deep_research",
        summary: "历史报告摘要",
        decision_conditions: null,
      },
      markdown: "",
    });
    await waitFor(() => expect(openStockIntradayStream).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("tab", { name: "投研" }));
    expect(screen.getAllByText("该历史报告未提供判断条件")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "确认与观察条件" })).toBeInTheDocument();
    expect(screen.queryByText("确认 / 观察条件")).not.toBeInTheDocument();
    expect(screen.queryByText(/结构化条件/)).not.toBeInTheDocument();
  });
});
