import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { KlineChart, type KlineView } from "./KlineChart";
import type { StockKlineBar } from "@/lib/stock-api";

function bar(date: string, open: number, close: number, high: number, low: number): StockKlineBar {
  return { date, open, close, high, low, volume: 1000 };
}

function series(count: number): StockKlineBar[] {
  return Array.from({ length: count }, (_, i) =>
    bar(`2026-01-${String(i + 1).padStart(2, "0")}`, 10, 10 + i * 0.1, 12, 9),
  );
}

/** 受控包装：视口状态提升，模拟 InstrumentStage 的用法。 */
function InteractiveChart({ bars }: { bars: StockKlineBar[] }) {
  const [view, setView] = useState<KlineView>({ offset: 0, count: bars.length });
  return <KlineChart bars={bars} view={view} onViewChange={setView} />;
}

describe("KlineChart", () => {
  it("renders one candle per bar with A-share direction (close >= open is up)", () => {
    const bars = [
      bar("2026-08-12", 10, 11, 12, 9.5), // up
      bar("2026-08-13", 11, 10.5, 11.5, 10), // down
      bar("2026-08-14", 10.5, 10.5, 11, 10), // flat counts as up
    ];
    const { container } = render(<KlineChart bars={bars} />);
    const svg = screen.getByRole("img", { name: "K线图" });
    expect(svg).toBeTruthy();
    const candles = container.querySelectorAll("[data-candle]");
    expect(candles).toHaveLength(3);
    expect(candles[0].getAttribute("data-direction")).toBe("up");
    expect(candles[1].getAttribute("data-direction")).toBe("down");
    expect(candles[2].getAttribute("data-direction")).toBe("up");
  });

  it("draws MA polylines when indicators are provided", () => {
    const bars = [bar("d1", 10, 11, 12, 9), bar("d2", 11, 12, 13, 10)];
    const { container } = render(
      <KlineChart
        bars={bars}
        ma={{ ma5: [10.5, 11.5], ma20: [null, 11.2], ma60: [null, null] }}
      />,
    );
    expect(container.querySelector('[data-ma="ma5"]')).toBeTruthy();
    expect(container.querySelector('[data-ma="ma20"]')).toBeTruthy();
    // ma60 is entirely null — nothing to draw.
    expect(container.querySelector('[data-ma="ma60"]')).toBeNull();
  });

  it("shows an empty placeholder without bars", () => {
    render(<KlineChart bars={[]} />);
    expect(screen.getByText("暂无K线数据")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "K线图" })).toBeNull();
  });

  // --- 看盘软件交互：滚轮缩放 / 拖动平移 / 十字光标 ---

  it("zooms in on wheel up and back out on wheel down around the cursor", () => {
    const bars = series(100);
    const { container } = render(<InteractiveChart bars={bars} />);
    const svg = screen.getByRole("img", { name: "K线图" });
    expect(container.querySelectorAll("[data-candle]")).toHaveLength(100);
    // jsdom 的 getBoundingClientRect 宽为 0，组件回退标称 600：clientX 直接映射。
    fireEvent.wheel(svg, { deltaY: -120, clientX: 300 });
    expect(container.querySelectorAll("[data-candle]")).toHaveLength(80);
    // 放大后窗口整体左移（锚点约在视口中央）：首根可见为 d11。
    expect(container.querySelector("[data-candle]")?.getAttribute("data-date")).toBe(
      "2026-01-11",
    );
    fireEvent.wheel(svg, { deltaY: 120, clientX: 300 });
    expect(container.querySelectorAll("[data-candle]")).toHaveLength(100);
    expect(container.querySelector("[data-candle]")?.getAttribute("data-date")).toBe(
      "2026-01-01",
    );
  });

  it("never zooms in below the minimum visible bars", () => {
    const bars = series(100);
    const { container } = render(<InteractiveChart bars={bars} />);
    const svg = screen.getByRole("img", { name: "K线图" });
    for (let i = 0; i < 30; i += 1) {
      fireEvent.wheel(svg, { deltaY: -120, clientX: 300 });
    }
    expect(container.querySelectorAll("[data-candle]")).toHaveLength(15);
  });

  it("pans through history by dragging and clamps at both edges", () => {
    const bars = series(100);
    const { container } = render(<InteractiveChart bars={bars} />);
    const svg = screen.getByRole("img", { name: "K线图" });
    // 视口 100 根占满，无法平移：offset 钳在 0。
    fireEvent.pointerDown(svg, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(container.querySelector("[data-candle]")?.getAttribute("data-date")).toBe(
      "2026-01-01",
    );
    // 放大到 80 根后拖动：右移 100px（≈15 根，槽宽 ≈6.8px）回看更早历史。
    fireEvent.wheel(svg, { deltaY: -120, clientX: 300 });
    fireEvent.pointerDown(svg, { clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    const firstDate = container
      .querySelector("[data-candle]")
      ?.getAttribute("data-date");
    expect(firstDate).toBe("2026-01-01");
    // 左拖（560→100）看更晚：offset 回到钳制上限 20（100-80）。
    fireEvent.pointerDown(svg, { clientX: 560, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    const lastFirst = container
      .querySelectorAll("[data-candle]")[0]
      .getAttribute("data-date");
    expect(lastFirst).toBe("2026-01-21");
  });

  it("shows a crosshair with OHLC readout on hover and clears on leave", () => {
    const bars = series(50);
    const { container } = render(<InteractiveChart bars={bars} />);
    const svg = screen.getByRole("img", { name: "K线图" });
    fireEvent.pointerMove(svg, { clientX: 200, clientY: 100, pointerId: 1 });
    expect(container.querySelector("[data-crosshair]")).toBeTruthy();
    // 悬停读数条显示 hover bar 的日期与开高低收。
    expect(screen.getByText(/2026-01-/)).toBeTruthy();
    expect(screen.getByText(/开 10\.00/)).toBeTruthy();
    // React 的 onPointerLeave 由 pointerout 合成：relatedTarget=null 即离场。
    fireEvent.pointerOut(svg, { relatedTarget: null });
    expect(container.querySelector("[data-crosshair]")).toBeNull();
  });

  it("resets to the default window on double click", () => {
    const bars = series(200);
    const { container } = render(<InteractiveChart bars={bars} />);
    const svg = screen.getByRole("img", { name: "K线图" });
    // 非受控初始全量 200 根；双击回默认 120 根（最近窗口）。
    fireEvent.doubleClick(svg);
    const candles = container.querySelectorAll("[data-candle]");
    expect(candles).toHaveLength(120);
    expect(candles[0].getAttribute("data-date")).toBe("2026-01-81");
  });
});
