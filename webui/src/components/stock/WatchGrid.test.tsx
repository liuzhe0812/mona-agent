import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StockDashboardItem, StockSearchResult } from "@/lib/stock-api";
import { WatchGrid } from "./WatchGrid";

const ETF_RESULT: StockSearchResult = {
  instrumentId: "XSHG:510300",
  symbol: "510300",
  exchange: "XSHG",
  name: "沪深300ETF",
  instrumentType: "etf",
};

function renderGrid(onSearch: (keyword: string) => Promise<StockSearchResult[]>) {
  return render(
    <WatchGrid
      items={[]}
      quotes={{}}
      signals={{}}
      selectedId={null}
      onSelect={vi.fn()}
      onOpenNews={vi.fn()}
      onToggleFocus={vi.fn()}
      onRemove={vi.fn()}
      onAdd={vi.fn()}
      onReorder={vi.fn()}
      onSearch={onSearch}
      collapsed={false}
      onToggleCollapsed={vi.fn()}
    />,
  );
}

describe("WatchGrid search terminology", () => {
  it("explains the index-fund type in search results", async () => {
    renderGrid(vi.fn().mockResolvedValue([ETF_RESULT]));

    fireEvent.click(screen.getByRole("button", { name: "添加标的" }));
    fireEvent.change(screen.getByPlaceholderText("搜索代码或名称"), {
      target: { value: "510300" },
    });

    expect(await screen.findByText(/交易型开放式指数基金（ETF）/)).toBeInTheDocument();
    expect(screen.queryByText(" · ETF")).not.toBeInTheDocument();
  });

  it("explains the index-fund type when no search result is found", async () => {
    renderGrid(vi.fn().mockResolvedValue([]));

    fireEvent.click(screen.getByRole("button", { name: "添加标的" }));
    fireEvent.change(screen.getByPlaceholderText("搜索代码或名称"), {
      target: { value: "不存在" },
    });

    await waitFor(() => {
      expect(screen.getByText("未找到匹配的 A 股股票或交易型开放式指数基金")).toBeInTheDocument();
    });
  });
});

describe("WatchGrid columns", () => {
  it("does not render the opinion column", () => {
    const item: StockDashboardItem = {
      instrumentId: "XSHG:600519",
      name: "贵州茅台",
      instrumentType: "equity",
      focus: false,
      latest: null,
    };

    const { container } = render(
      <WatchGrid
        items={[item]}
        quotes={{}}
        signals={{}}
        selectedId={item.instrumentId}
        onSelect={vi.fn()}
        onOpenNews={vi.fn()}
        onToggleFocus={vi.fn()}
        onRemove={vi.fn()}
        onAdd={vi.fn()}
        onReorder={vi.fn()}
        onSearch={vi.fn().mockResolvedValue([])}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />,
    );

    const row = container.querySelector(`[data-instrument-id="${item.instrumentId}"]`);
    expect(screen.queryByText("观点")).not.toBeInTheDocument();
    expect(row).toHaveTextContent("—");
  });

  it("opens the selected stock's news tab from the latest-event date", () => {
    const onOpenNews = vi.fn();
    const item: StockDashboardItem = {
      instrumentId: "XSHG:600519",
      name: "贵州茅台",
      instrumentType: "equity",
      focus: false,
      latest: {
        reportId: "report_1",
        runId: "run_1",
        kind: "daily_review",
        asOf: "2026-08-20T15:00:00+08:00",
        schemaVersion: 4,
        stance: null,
        dataQuality: null,
        researchCutoffAt: "2026-08-20T15:00:00+08:00",
        marketAsOf: "2026-08-20T15:00:00+08:00",
        evidenceCoverage: {},
      },
    };

    render(
      <WatchGrid
        items={[item]}
        quotes={{}}
        signals={{}}
        selectedId={item.instrumentId}
        onSelect={vi.fn()}
        onOpenNews={onOpenNews}
        onToggleFocus={vi.fn()}
        onRemove={vi.fn()}
        onAdd={vi.fn()}
        onReorder={vi.fn()}
        onSearch={vi.fn().mockResolvedValue([])}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "查看贵州茅台资讯公告" })).toHaveTextContent("08-20");
    fireEvent.click(screen.getByRole("button", { name: "查看贵州茅台资讯公告" }));
    expect(onOpenNews).toHaveBeenCalledWith(item.instrumentId);
  });
});
