import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EffortSlider } from "./EffortSlider";

const stops = ["low", "high", "xhigh"];
const labelOf = (value: string) => value.toUpperCase();

describe("EffortSlider", () => {
  it("keeps the chosen level visible until an asynchronous save confirms it", async () => {
    let complete!: () => void;
    const saved = new Promise<void>((resolve) => { complete = resolve; });
    const onChange = vi.fn(() => saved);
    const options = ["high", "max"];
    const { rerender } = render(<EffortSlider stops={options} value="high" labelOf={labelOf} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "思考强度" });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 200 } as DOMRect);
    fireEvent.pointerDown(slider, { button: 0, isPrimary: true, pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 200 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 200 });
    expect(onChange).toHaveBeenCalledOnce();
    expect(slider).toHaveAttribute("aria-valuetext", "MAX");
    await act(async () => { complete(); await saved; });
    rerender(<EffortSlider stops={options} value="max" labelOf={labelOf} onChange={onChange} />);
    expect(slider).toHaveAttribute("aria-valuetext", "MAX");
  });

  it("returns to the confirmed level when saving fails", async () => {
    let fail!: (reason: Error) => void;
    const saved = new Promise<void>((_resolve, reject) => { fail = reject; });
    render(<EffortSlider stops={["high", "max"]} value="high" labelOf={labelOf} onChange={() => saved} />);
    const slider = screen.getByRole("slider", { name: "思考强度" });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({ left: 0, width: 200 } as DOMRect);
    fireEvent.pointerDown(slider, { button: 0, isPrimary: true, pointerId: 1, clientX: 0 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 200 });
    expect(slider).toHaveAttribute("aria-valuetext", "MAX");
    await act(async () => { fail(new Error("save failed")); await saved.catch(() => undefined); });
    expect(slider).toHaveAttribute("aria-valuetext", "HIGH");
  });
  it("commits the nearest stop only when the pointer is released", () => {
    const onChange = vi.fn();
    render(<EffortSlider stops={stops} value="low" labelOf={labelOf} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "思考强度" });
    vi.spyOn(slider, "getBoundingClientRect").mockReturnValue({
      left: 0,
      right: 200,
      top: 0,
      bottom: 24,
      width: 200,
      height: 24,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(slider, { button: 0, isPrimary: true, pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 180 });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(document, { pointerId: 1, clientX: 130 });
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("moves through the provided discrete stops with the keyboard", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <EffortSlider stops={stops} value="low" labelOf={labelOf} onChange={onChange} />,
    );
    const slider = screen.getByRole("slider", { name: "思考强度" });

    fireEvent.keyDown(slider, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("high");
    rerender(<EffortSlider stops={stops} value="high" labelOf={labelOf} onChange={onChange} />);

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("xhigh");
    rerender(<EffortSlider stops={stops} value="xhigh" labelOf={labelOf} onChange={onChange} />);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("low");
    rerender(<EffortSlider stops={stops} value="low" labelOf={labelOf} onChange={onChange} />);
    fireEvent.keyDown(slider, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("xhigh");
    expect(onChange).toHaveBeenCalledTimes(4);
  });
});
