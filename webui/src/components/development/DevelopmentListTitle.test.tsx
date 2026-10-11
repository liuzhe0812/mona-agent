import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevelopmentListTitle } from "./DevelopmentListTitle";

class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  readonly targets: Element[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }

  observe(target: Element) { this.targets.push(target); }
  disconnect() {}
  notify() { act(() => this.callback([], this as unknown as ResizeObserver)); }
}

const rect = (left: number, width: number): DOMRect => ({
  x: left, y: 0, left, top: 0, right: left + width, bottom: 10, width, height: 10,
  toJSON: () => ({}),
});

function fixture(text: string) {
  const actionsRef = createRef<HTMLDivElement>();
  const view = render(<div style={{ fontSize: "13px" }}>
    <DevelopmentListTitle text={text} actionsRef={actionsRef} />
    <div ref={actionsRef} data-testid="actions" />
  </div>);
  return {
    ...view,
    actionsRef,
    viewport: view.container.querySelector<HTMLElement>(".development-list-title")!,
    content: view.container.querySelector<HTMLElement>(".development-list-title-text")!,
    actions: screen.getByTestId("actions"),
  };
}

function setMeasurements(viewport: HTMLElement, content: HTMLElement, actions: HTMLElement, width: number, textWidth: number, covered: number) {
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(content, "scrollWidth", { configurable: true, value: textWidth });
  Object.defineProperty(viewport, "getBoundingClientRect", { configurable: true, value: () => rect(0, width) });
  Object.defineProperty(actions, "getBoundingClientRect", { configurable: true, value: () => rect(width - covered, covered) });
}

beforeEach(() => {
  ControlledResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("development list title", () => {
  it("includes the covered action area when measuring long-title scroll distance", () => {
    const view = fixture("a long project or task title");
    setMeasurements(view.viewport, view.content, view.actions, 100, 260, 24);
    const observer = ControlledResizeObserver.instances.at(-1)!;
    observer.notify();

    expect(observer.targets).toEqual([view.viewport, view.content, view.actions]);
    expect(view.viewport).toHaveAttribute("data-overflow", "true");
    expect(view.viewport.style.getPropertyValue("--dev-list-title-covered")).toBe("24px");
    expect(view.viewport.style.getPropertyValue("--dev-list-title-offset")).toBe("-197px");
  });

  it("does not scroll a title that fits before the covered action area", () => {
    const view = fixture("short title");
    setMeasurements(view.viewport, view.content, view.actions, 100, 60, 24);
    ControlledResizeObserver.instances.at(-1)!.notify();

    expect(view.viewport).toHaveAttribute("data-overflow", "false");
    expect(view.viewport.style.getPropertyValue("--dev-list-title-offset")).toBe("0px");
    expect(view.viewport.style.getPropertyValue("--dev-list-title-duration")).toBe("3s");
  });

  it("recalculates after the row narrows and the title changes", () => {
    const view = fixture("a long project title");
    setMeasurements(view.viewport, view.content, view.actions, 100, 260, 24);
    const observer = ControlledResizeObserver.instances.at(-1)!;
    observer.notify();
    expect(view.viewport.style.getPropertyValue("--dev-list-title-offset")).toBe("-197px");

    setMeasurements(view.viewport, view.content, view.actions, 80, 260, 30);
    observer.notify();
    expect(view.viewport.style.getPropertyValue("--dev-list-title-offset")).toBe("-223px");

    Object.defineProperty(view.content, "scrollWidth", { configurable: true, value: 320 });
    view.rerender(<div style={{ fontSize: "13px" }}>
      <DevelopmentListTitle text="a renamed and longer project title" actionsRef={view.actionsRef} />
      <div ref={view.actionsRef} data-testid="actions" />
    </div>);
    expect(view.viewport.style.getPropertyValue("--dev-list-title-offset")).toBe("-283px");
  });
});
