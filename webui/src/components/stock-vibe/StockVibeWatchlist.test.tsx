import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ market: vi.fn(), search: vi.fn() }));
vi.mock("@/lib/stock-vibe-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stock-vibe-api")>(),
  getStockVibeWorkbenchMarket: api.market, searchStockVibeSymbols: api.search,
}));

import { StockVibeWatchlist, type StockVibeWatchlistProps } from "./StockVibeWatchlist";
import type { StockVibeWorkbenchMarketData } from "@/lib/stock-vibe-api";
import { readStockVibeMarketSnapshot } from "@/lib/stock-vibe-market-cache";

const SYMBOL = "002460.SZ", OTHER = "600000.SH";
function market(symbol = SYMBOL, price = 39.29): StockVibeWorkbenchMarketData {
  return { status: "ok", symbol, interval: "intraday", bars: [],
    quote: { price, previous_close: 40, change: price - 40, change_pct: (price - 40) / 40 * 100, name: symbol === SYMBOL ? "赣锋锂业" : "浦发银行" },
    trading_date: "2026-10-16", market_open: false, market_state: "closed", source: "tencent",
    observed_at: new Date().toISOString(), volume_unit: "lots", adjustment: "none" };
}
function props(overrides: Partial<StockVibeWatchlistProps> = {}): StockVibeWatchlistProps {
  return { symbols: [SYMBOL], paperTrading: <div>模拟账户内容</div>, selectedSymbol: SYMBOL, currentMarket: market(), knownQuotes: {},
 onSelect: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), onReorder: vi.fn(), ...overrides };
}
function transfer() {
  const values = new Map<string, string>();
  return { effectAllowed: "", dropEffect: "", types: [] as string[],
    setData(type: string, value: string) { values.set(type, value); if (!this.types.includes(type)) this.types.push(type); },
    getData(type: string) { return values.get(type) ?? ""; } };
}
function dispatchDropTargetEvent(target: HTMLElement, type: "dragover" | "drop", dataTransfer: ReturnType<typeof transfer>, clientY: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientY: { value: clientY } });
  fireEvent(target, event);
}
function rowFor(list: HTMLElement, code: string) { return within(list).getByText(code).closest("li")!; }
function setRowBounds(row: HTMLElement, top = 100, height = 40) {
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top, height, bottom: top + height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) });
}
beforeEach(() => {
  localStorage.clear();
  api.market.mockReset().mockRejectedValue(new Error("offline"));
  api.search.mockReset().mockRejectedValue(new Error("offline"));
});

describe("StockVibeWatchlist", () => {
  it("saves successful background quotes for the next workbench mount", async () => {
    const value = market(OTHER, 20);
    value.bars = [{ trade_date: "2026-10-16T15:00:00+08:00", close: 20, volume: 100 }];
    api.market.mockResolvedValue({ source: null, native: value });
    render(<StockVibeWatchlist {...props({ symbols: [SYMBOL, OTHER] })} />);
    await waitFor(() => expect(readStockVibeMarketSnapshot(OTHER, "intraday")?.native).toEqual(value));
    expect(screen.getByText("20.00")).toBeVisible();
  });
  it("keeps an active filter when the list becomes short and offers clearing instead of a false empty-watchlist action", () => {
    const symbols = [SYMBOL, OTHER, "000001.SZ", "000002.SZ", "600519.SH", "600030.SH", "601318.SH"];
    const input = props({ symbols, selectedSymbol: null, currentMarket: null });
    const { rerender } = render(<StockVibeWatchlist {...input} />);
    fireEvent.change(screen.getByRole("textbox", { name: "筛选自选" }), { target: { value: "999999" } });
    expect(screen.getByText("没有匹配的股票。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加第一只股票" })).not.toBeInTheDocument();
    rerender(<StockVibeWatchlist {...input} symbols={[SYMBOL]} />);
    expect(screen.getByRole("textbox", { name: "筛选自选" })).toHaveValue("999999");
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(within(screen.getByRole("list", { name: "自选股票" })).getByText("002460")).toBeInTheDocument();
  });
  it("shows names, six-digit codes and changes against previous close without permanent remove controls", () => {
    const input = props();
    const { rerender } = render(<StockVibeWatchlist {...input} />);
    const list = within(screen.getByRole("list", { name: "自选股票" }));
    expect(list.getByText("赣锋锂业")).toBeInTheDocument();
    expect(list.getByText("002460")).toBeInTheDocument();
    expect(list.queryByText(SYMBOL)).not.toBeInTheDocument();
    expect(list.getByText("39.29").parentElement).toHaveClass("stock-vibe-down");
    expect(list.getByText("-1.78%")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "股票名称或代码" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /移除自选/ })).not.toBeInTheDocument();
    expect(screen.queryByText("行情与研究无需连接账户。")).not.toBeInTheDocument();
    const noPrevious = market(); noPrevious.quote.previous_close = null;
    rerender(<StockVibeWatchlist {...input} currentMarket={noPrevious} />);
    expect(list.getByText("39.29").parentElement).not.toHaveClass("stock-vibe-down", "stock-vibe-up");
    expect(list.getByText("—")).toBeInTheDocument();
  });

  it("adds six-digit codes without waiting for search and keeps duplicates next to the field", async () => {
    const input = props(); render(<StockVibeWatchlist {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "添加自选" }));
    const field = screen.getByRole("combobox", { name: "股票名称或代码" });
    fireEvent.change(field, { target: { value: "002460" } });
    fireEvent.submit(field.closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent("这只股票已在自选中。");
    expect(input.onAdd).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "600000" } });
    fireEvent.submit(field.closest("form")!);
    expect(input.onAdd).toHaveBeenCalledWith(OTHER);
    expect(api.search).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "添加自选" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "添加自选" }));
    expect(screen.getByRole("combobox", { name: "股票名称或代码" })).toHaveValue("");
  });

  it("searches Chinese names, shows six-digit results and adds the explicitly selected stock", async () => {
    const input = props();
    api.search.mockResolvedValue({ native: { candidates: [{ symbol: SYMBOL, name: "赣锋锂业" }] }, source: null });
    render(<StockVibeWatchlist {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "添加自选" }));
    const field = screen.getByRole("combobox", { name: "股票名称或代码" });
    fireEvent.change(field, { target: { value: "赣锋" } });
    const result = await screen.findByRole("option", { name: "赣锋锂业 002460 · 已添加" });
    expect(api.search).toHaveBeenCalledWith("赣锋");
    expect(result).toBeDisabled();
    expect(input.onAdd).not.toHaveBeenCalled();
  });

  it("adds a name search result after selection and supports Arrow keys plus Enter", async () => {
    const input = props({ symbols: [], selectedSymbol: null, currentMarket: null });
    api.search.mockResolvedValue({ native: { candidates: [
      { symbol: SYMBOL, name: "赣锋锂业" }, { symbol: OTHER, name: "浦发银行" },
    ] }, source: null });
    render(<StockVibeWatchlist {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "添加自选" }));
    const field = screen.getByRole("combobox", { name: "股票名称或代码" });
    fireEvent.change(field, { target: { value: "银行" } });
    await screen.findByRole("option", { name: "浦发银行 600000" });
    const user = userEvent.setup();
    field.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "赣锋锂业 002460" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(input.onAdd).toHaveBeenCalledWith(OTHER);
  });

  it("does not search or submit while Chinese input composition is active", async () => {
    const input = props({ symbols: [], selectedSymbol: null, currentMarket: null });
    api.search.mockResolvedValue({ native: { candidates: [{ symbol: SYMBOL, name: "赣锋锂业" }] }, source: null });
    render(<StockVibeWatchlist {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "添加自选" }));
    const field = screen.getByRole("combobox", { name: "股票名称或代码" });
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: "赣锋" } });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229, isComposing: true });
    fireEvent.submit(field.closest("form")!);
    expect(api.search).not.toHaveBeenCalled();
    expect(input.onAdd).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field, { data: "赣锋" });
    expect(await screen.findByRole("option", { name: "赣锋锂业 002460" })).toBeInTheDocument();
  });

  it("ignores an older name query response and shows a local message when search fails", async () => {
    const input = props({ symbols: [], selectedSymbol: null, currentMarket: null });
    const pending = new Map<string, (value: { native: { candidates: Array<{ symbol: string; name: string }> } }) => void>();
    api.search.mockImplementation((query: string) => new Promise((resolve) => pending.set(query, resolve)));
    render(<StockVibeWatchlist {...input} />);
    fireEvent.click(screen.getByRole("button", { name: "添加自选" }));
    const field = screen.getByRole("combobox", { name: "股票名称或代码" });
    fireEvent.change(field, { target: { value: "赣锋" } });
    await waitFor(() => expect(api.search).toHaveBeenCalledWith("赣锋"));
    fireEvent.change(field, { target: { value: "浦发" } });
    await waitFor(() => expect(api.search).toHaveBeenCalledWith("浦发"));
    await act(async () => pending.get("浦发")!({ native: { candidates: [{ symbol: OTHER, name: "浦发银行" }] } }));
    expect(await screen.findByRole("option", { name: "浦发银行 600000" })).toBeInTheDocument();
    await act(async () => pending.get("赣锋")!({ native: { candidates: [{ symbol: SYMBOL, name: "赣锋锂业" }] } }));
    expect(screen.queryByRole("option", { name: "赣锋锂业 002460" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "浦发银行 600000" })).toBeInTheDocument();

    api.search.mockRejectedValueOnce(new Error("offline"));
    fireEvent.change(field, { target: { value: "不存在" } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("搜索暂不可用，可直接输入六位代码添加。"));
    fireEvent.change(field, { target: { value: "600000" } });
    fireEvent.submit(field.closest("form")!);
    expect(input.onAdd).toHaveBeenCalledWith(OTHER);
  });

  it("reorders by dropping on the lower half and clears drag feedback when the drag ends", () => {
    const input = props({ symbols: [SYMBOL, OTHER, "600519.SH"] });
    render(<StockVibeWatchlist {...input} />);
    const list = screen.getByRole("list", { name: "自选股票" });
    const source = rowFor(list, "002460"), target = rowFor(list, "600000");
    setRowBounds(target);
    const data = transfer();
    fireEvent.dragStart(source, { dataTransfer: data });
    expect(source).toHaveAttribute("data-dragging", "true");
    dispatchDropTargetEvent(target, "dragover", data, 130);
    expect(target).toHaveAttribute("data-drop", "after");
    dispatchDropTargetEvent(target, "drop", data, 130);
    expect(input.onReorder).toHaveBeenCalledWith([OTHER, SYMBOL, "600519.SH"]);
    expect(input.onSelect).not.toHaveBeenCalled();
    expect(source).not.toHaveAttribute("data-dragging");
    expect(target).not.toHaveAttribute("data-drop");
    fireEvent.dragStart(source, { dataTransfer: transfer() });
    expect(source).toHaveAttribute("data-dragging", "true");
    fireEvent.dragEnd(source);
    expect(source).not.toHaveAttribute("data-dragging");
  });

  it("supports dropping before a row and sorting with Alt+Arrow keys", () => {
    const third = "600519.SH", input = props({ symbols: [SYMBOL, OTHER, third] });
    render(<StockVibeWatchlist {...input} />);
    const list = screen.getByRole("list", { name: "自选股票" });
    const source = rowFor(list, "600519"), target = rowFor(list, "002460");
    setRowBounds(target);
    const data = transfer();
    fireEvent.dragStart(source, { dataTransfer: data });
    dispatchDropTargetEvent(target, "dragover", data, 110);
    expect(target).toHaveAttribute("data-drop", "before");
    dispatchDropTargetEvent(target, "drop", data, 110);
    expect(input.onReorder).toHaveBeenCalledWith([third, SYMBOL, OTHER]);

    fireEvent.keyDown(within(list).getByRole("button", { name: /赣锋锂业/ }), { key: "ArrowDown", altKey: true });
    expect(input.onReorder).toHaveBeenLastCalledWith([OTHER, SYMBOL, third]);
  });

  it("keeps filtered-out rows in their slots when visible stocks are reordered", () => {
    const third = "600519.SH";
    const hidden = ["000001.SZ", "000002.SZ", "000003.SZ", "000004.SZ"];
    const input = props({ symbols: [SYMBOL, OTHER, third, ...hidden], knownQuotes: { [OTHER]: market(OTHER), [third]: market(third) } });
    render(<StockVibeWatchlist {...input} />);
    fireEvent.change(screen.getByRole("textbox", { name: "筛选自选" }), { target: { value: "600" } });
    const list = screen.getByRole("list", { name: "自选股票" });
    expect(within(list).queryByText("002460")).not.toBeInTheDocument();
    const source = rowFor(list, "600000"), target = rowFor(list, "600519");
    setRowBounds(target);
    const data = transfer();
    fireEvent.dragStart(source, { dataTransfer: data });
    dispatchDropTargetEvent(target, "dragover", data, 130);
    dispatchDropTargetEvent(target, "drop", data, 130);
    expect(input.onReorder).toHaveBeenCalledWith([SYMBOL, third, OTHER, ...hidden]);
  });

  it("ignores drops that do not originate from the watchlist", () => {
    const input = props({ symbols: [SYMBOL, OTHER] });
    render(<StockVibeWatchlist {...input} />);
    const list = screen.getByRole("list", { name: "自选股票" });
    const target = rowFor(list, "600000");
    const external = { effectAllowed: "", dropEffect: "", types: ["text/plain"], getData: () => "002460.SZ", setData: vi.fn() };
    fireEvent.dragOver(target, { dataTransfer: external, clientY: 130 });
    fireEvent.drop(target, { dataTransfer: external, clientY: 130 });
    expect(input.onReorder).not.toHaveBeenCalled();
    expect(target).not.toHaveAttribute("data-drop");
  });

  it("removes a right-clicked watchlist row without selecting it and has no management button", async () => {
    const input = props({ symbols: [SYMBOL, OTHER], knownQuotes: { [OTHER]: market(OTHER) } });
    render(<StockVibeWatchlist {...input} />);
    expect(screen.queryByRole("button", { name: "管理自选" })).not.toBeInTheDocument();
    expect(screen.queryByText("管理")).not.toBeInTheDocument();
    const list = screen.getByRole("list", { name: "自选股票" });
    fireEvent.contextMenu(rowFor(list, "600000"));
    const remove = await screen.findByRole("menuitem", { name: "移除自选" });
    await userEvent.click(remove);
    expect(input.onRemove).toHaveBeenCalledWith(OTHER);
    expect(input.onSelect).not.toHaveBeenCalled();
    expect(within(list).getByRole("button", { name: /浦发银行/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the shared paper account panel and supports keyboard tab switching", () => {
    const input = props(); render(<StockVibeWatchlist {...input} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "自选 1" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "模拟持仓" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("模拟账户内容")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "自选股票" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加自选" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("tab", { name: "模拟持仓" }), { key: "Home" });
    expect(screen.getByRole("list", { name: "自选股票" })).toBeInTheDocument();
    expect(input.onRemove).not.toHaveBeenCalled();
  });

  it("keeps current quotes authoritative and preserves other quotes when background refresh fails", async () => {
    const old = market(OTHER, 20); old.observed_at = "2020-01-01T00:00:00Z";
    const input = props({ symbols: [SYMBOL, OTHER], knownQuotes: { [OTHER]: old } });
    const { rerender } = render(<StockVibeWatchlist {...input} />);
    await waitFor(() => expect(api.market).toHaveBeenCalledWith(OTHER, "intraday"));
    expect(api.market).not.toHaveBeenCalledWith(SYMBOL, "intraday");
    await waitFor(() => expect(screen.getByRole("button", { name: /浦发银行/ }).getAttribute("title")).toContain("行情更新失败，保留上次行情。"));
    expect(screen.getByText("20.00")).toBeInTheDocument();
    expect(screen.getByText("39.29")).toBeInTheDocument();
    rerender(<StockVibeWatchlist {...input} currentMarket={{ ...market(SYMBOL, 42), observed_at: "2030-01-01T00:00:00Z" }} />);
    expect(screen.getByText("42.00")).toBeInTheDocument();
    expect(api.market).toHaveBeenCalledTimes(1);
    rerender(<StockVibeWatchlist {...input} selectedSymbol={null} symbols={[SYMBOL, OTHER, "920001.BJ"]} />);
    await act(async () => undefined);
    expect(api.market).toHaveBeenCalledTimes(1);
  });

  it("loads at most two list quotes concurrently and never replaces a newly selected quote", async () => {
    const completions = new Map<string, (value: { native: StockVibeWorkbenchMarketData }) => void>();
    api.market.mockImplementation((symbol: string) => new Promise((resolve) => { completions.set(symbol, resolve); }));
    const third = "920001.BJ", fourth = "000001.SZ";
    const input = props({ symbols: [SYMBOL, OTHER, third, fourth] });
    const { rerender } = render(<StockVibeWatchlist {...input} />);
    expect(api.market.mock.calls.map(([symbol]) => symbol)).toEqual([OTHER, third]);
    rerender(<StockVibeWatchlist {...input} selectedSymbol={OTHER} currentMarket={market(OTHER, 99)} knownQuotes={{ [SYMBOL]: input.currentMarket! }} />);
    await act(async () => { completions.get(OTHER)!({ native: market(OTHER, 20) }); });
    await waitFor(() => expect(api.market).toHaveBeenCalledWith(fourth, "intraday"));
    expect(screen.getByText("99.00")).toBeInTheDocument();
    expect(screen.queryByText("20.00")).not.toBeInTheDocument();
    expect(api.market).toHaveBeenCalledTimes(3);
    await act(async () => {
      completions.get(third)!({ native: market(third, 30) });
      completions.get(fourth)!({ native: market(fourth, 40) });
    });
    expect(screen.getByText("30.00")).toBeInTheDocument();
    expect(screen.getByText("40.00")).toBeInTheDocument();
  });
});
