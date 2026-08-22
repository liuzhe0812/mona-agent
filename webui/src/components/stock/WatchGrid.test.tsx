import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StockSearchResult } from "@/lib/stock-api";
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
