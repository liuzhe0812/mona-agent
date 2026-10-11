import { cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VirtualTimeline } from "./VirtualTimeline";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("binds the parent's scroll ref after commit and virtualizes the historical turns", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 100, width: 800, height: this.dataset.v4TurnUnit ? 100 : 400, toJSON: () => ({}) };
  });
  function Host() {
    const scroll = useRef<HTMLDivElement | null>(null), following = useRef(false);
    const units = Array.from({ length: 80 }, (_, index) => ({ key: `turn-${index}`, isRunning: false, messageIds: [`message-${index}`], content: <p>Turn {index}</p> }));
    return <div ref={(element) => {
      scroll.current = element;
      if (element) Object.defineProperties(element, { clientHeight: { configurable: true, value: 400 }, offsetHeight: { configurable: true, value: 400 }, offsetWidth: { configurable: true, value: 800 } });
    }}><VirtualTimeline units={units} scrollRef={scroll} followingRef={following} /></div>;
  }
  const view = render(<Host />);
  await waitFor(() => expect(view.container.querySelectorAll("[data-v4-turn-unit]").length).toBeGreaterThan(0));
  expect(view.container.querySelectorAll("[data-v4-turn-unit]").length).toBeLessThan(40);
});
