import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StockVibeOpportunityCandidate } from "@/lib/stock-vibe-opportunity-api";
import { StockVibeOpportunityCandidates } from "./StockVibeOpportunityCandidates";

function candidates(count: number): StockVibeOpportunityCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    symbol: `${600000 + index}.SH`, name: `候选${index + 1}`, rank: index + 1,
    support: [`已核实依据${index + 1}`], risks: [`已有风险${index + 1}`],
  }));
}

function actions() {
  return { onSelect: vi.fn(), onCompare: vi.fn(), onMarket: vi.fn(), onAdd: vi.fn() };
}

function renderedNames() {
  return screen.getAllByRole("button", { name: /查看候选\d+的入选依据/ })
    .map((button) => button.getAttribute("aria-label"));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("opportunity candidate pages", () => {
  it("fills the available height with whole cards and accounts for row gaps", () => {
    let height = 520;
    let resize = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.classList.contains("stock-vibe-opportunity-candidates-list")) return new DOMRect(0, 0, 600, height);
      if (this.classList.contains("stock-vibe-opportunity-candidate")) return new DOMRect(0, 0, 600, this.isConnected ? 80 : 0);
      return originalRect.call(this);
    });
    const callbacks = actions();
    const { container } = render(<StockVibeOpportunityCandidates candidates={candidates(237)} comparisonSymbols={[]} symbols={[]} {...callbacks} />);
    (container.querySelector(".stock-vibe-opportunity-candidates-list") as HTMLElement).style.rowGap = "8px";
    act(() => resize());
    expect(renderedNames()).toHaveLength(6);
    expect(screen.getByText("1–6 / 237 只")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "跳转到页" }), { target: { value: "39" } });
    expect(screen.getByText("235–237 / 237 只")).toBeVisible();
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("600234.SH");
    fireEvent.change(screen.getByRole("combobox", { name: "跳转到页" }), { target: { value: "0" } });
    height = 519;
    act(() => resize());
    expect(renderedNames()).toHaveLength(5);
    expect(screen.getByText("1–5 / 237 只")).toBeVisible();
  });

  it("keeps the selected stock visible as the window grows or shrinks", () => {
    let height = 520;
    let resize = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.classList.contains("stock-vibe-opportunity-candidates-list")) return new DOMRect(0, 0, 600, height);
      if (this.classList.contains("stock-vibe-opportunity-candidate")) return new DOMRect(0, 0, 600, this.isConnected ? 80 : 0);
      return originalRect.call(this);
    });
    const rows = candidates(20), callbacks = actions();
    const { container, rerender } = render(<StockVibeOpportunityCandidates candidates={rows} comparisonSymbols={[]} symbols={[]} {...callbacks} />);
    (container.querySelector(".stock-vibe-opportunity-candidates-list") as HTMLElement).style.rowGap = "8px";
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    rerender(<StockVibeOpportunityCandidates candidates={rows} selectedSymbol="600007.SH" comparisonSymbols={[]} symbols={[]} {...callbacks} />);
    callbacks.onSelect.mockClear();
    height = 608;
    act(() => resize());
    expect(screen.getByText("8–14 / 20 只")).toBeVisible();
    height = 696;
    act(() => resize());
    expect(screen.getByText("1–8 / 20 只")).toBeVisible();
    expect(screen.getByRole("button", { name: "查看候选8的入选依据" })).toHaveAttribute("aria-pressed", "true");
    height = 256;
    act(() => resize());
    expect(screen.getByText("7–9 / 20 只")).toBeVisible();
    expect(renderedNames()).toHaveLength(3);
    expect(screen.getByRole("button", { name: "查看候选8的入选依据" })).toHaveAttribute("aria-pressed", "true");
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });

  it("paginates without losing any result, and selects the first item when changing pages", () => {
    const callbacks = actions();
    render(<StockVibeOpportunityCandidates candidates={candidates(10)} comparisonSymbols={[]} symbols={[]} {...callbacks} />);
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(screen.getByText("1–4 / 10 只")).toBeVisible();
    const seen = [...renderedNames()];
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("600004.SH");
    expect(screen.getByText("5–8 / 10 只")).toBeVisible();
    seen.push(...renderedNames());
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("600008.SH");
    expect(screen.getByText("9–10 / 10 只")).toBeVisible();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    seen.push(...renderedNames());
    expect(seen).toEqual(Array.from({ length: 10 }, (_, index) => `查看候选${index + 1}的入选依据`));
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("600004.SH");
    expect(renderedNames()).toHaveLength(4);
  });

  it("jumps directly to the last and first pages without rendering every page as a button", () => {
    const callbacks = actions();
    render(<StockVibeOpportunityCandidates candidates={candidates(237)} comparisonSymbols={[]} symbols={[]} {...callbacks} />);
    fireEvent.change(screen.getByRole("combobox", { name: "跳转到页" }), { target: { value: "59" } });
    expect(screen.getByText("237–237 / 237 只")).toBeVisible();
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("600236.SH");
    expect(renderedNames()).toEqual(["查看候选237的入选依据"]);
    expect(within(screen.getByRole("navigation", { name: "选股结果分页" })).getAllByRole("button")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "跳转到页" }), { target: { value: "0" } });
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("600000.SH");
    expect(screen.getByText("1–4 / 237 只")).toBeVisible();
  });

  it("keeps icon actions separate from selection and enforces existing comparison and watchlist limits", () => {
    const callbacks = actions();
    render(<StockVibeOpportunityCandidates candidates={candidates(4)} selectedSymbol="600000.SH"
      comparisonSymbols={["600000.SH", "600001.SH", "600002.SH"]} symbols={["600000.SH"]} {...callbacks} />);
    const selected = screen.getByRole("button", { name: "查看候选1的入选依据" });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    const first = within(selected.closest("article")!);
    const fourth = within(screen.getByRole("button", { name: "查看候选4的入选依据" }).closest("article")!);
    expect(first.getByRole("button", { name: "已加自选" })).toBeDisabled();
    expect(fourth.getByRole("button", { name: "加入对比" })).toBeDisabled();
    fireEvent.click(first.getByRole("button", { name: "移出对比" }));
    expect(callbacks.onCompare).toHaveBeenCalledWith("600000.SH");
    fireEvent.click(first.getByRole("button", { name: "看行情" }));
    expect(callbacks.onMarket).toHaveBeenCalledWith("600000.SH");
    fireEvent.click(fourth.getByRole("button", { name: "加自选" }));
    expect(callbacks.onAdd).toHaveBeenCalledWith("600003.SH");
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    fireEvent.click(selected);
    expect(callbacks.onSelect).toHaveBeenCalledWith("600000.SH");
    expect(screen.getByText("600000")).toBeVisible();
    expect(screen.queryByText("600000.SH")).not.toBeInTheDocument();
  });

  it("clamps a stale page when the result shrinks and synchronizes the selected candidate", () => {
    const callbacks = actions();
    const initial = candidates(10);
    const { rerender } = render(<StockVibeOpportunityCandidates candidates={initial} comparisonSymbols={[]} symbols={[]} {...callbacks} />);
    fireEvent.change(screen.getByRole("combobox", { name: "跳转到页" }), { target: { value: "2" } });
    callbacks.onSelect.mockClear();
    rerender(<StockVibeOpportunityCandidates candidates={initial.slice(0, 5)} comparisonSymbols={[]} symbols={[]} {...callbacks} />);
    expect(screen.getByText("5–5 / 5 只")).toBeVisible();
    expect(renderedNames()).toEqual(["查看候选5的入选依据"]);
    expect(callbacks.onSelect).toHaveBeenCalledOnce();
    expect(callbacks.onSelect).toHaveBeenCalledWith("600004.SH");
    expect(screen.getByRole("combobox", { name: "跳转到页" })).toHaveValue("1");
    rerender(<StockVibeOpportunityCandidates candidates={[]} comparisonSymbols={[]} symbols={[]} {...callbacks} />);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("does not invent positive reasons when the source does not provide any", () => {
    render(<StockVibeOpportunityCandidates candidates={[{ symbol: "600000.SH", support: [], risks: [] }]}
      comparisonSymbols={[]} symbols={[]} {...actions()} />);
    expect(screen.getByText("入选原因待补充")).toBeVisible();
    expect(screen.getByText("留意：风险资料待补充")).toBeVisible();
  });

  it("preserves actual quote fields and their financial color without filling missing values", () => {
    const actual = candidates(2);
    actual[0] = { ...actual[0], price: 1500, change_pct: -1.2 };
    actual[1] = { ...actual[1], price: Number.NaN, change_pct: Number.POSITIVE_INFINITY };
    const { rerender } = render(<StockVibeOpportunityCandidates candidates={actual} comparisonSymbols={[]} symbols={[]} {...actions()} />);
    expect(screen.getByText("1500")).toBeVisible();
    expect(screen.getByText("-1.2%")).toHaveClass("stock-vibe-opportunity-down");
    const second = screen.getByRole("button", { name: "查看候选2的入选依据" }).closest("article")!;
    expect(second.querySelector(".stock-vibe-opportunity-candidate-quote")).toBeNull();
    rerender(<StockVibeOpportunityCandidates candidates={[{ ...actual[0], price: 1500.123, change_pct: 1.234 }]}
      comparisonSymbols={[]} symbols={[]} {...actions()} />);
    expect(screen.getByText("1500.12")).toBeVisible();
    expect(screen.getByText("+1.23%")).toHaveClass("stock-vibe-opportunity-up");
  });
});
