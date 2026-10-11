import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DevelopmentTurnNavigator } from "./DevelopmentTurnNavigator";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const items = [1, 2, 3].map((n) => ({ id: `message-${n}`, userPreview: `问题 ${n}`, assistantPreview: `回复 ${n}`, running: false }));

function Harness({ onJump = () => {}, loadOlder = async () => {}, hasOlder = false, count = 3 }: {
  onJump?: (id: string) => void; loadOlder?: () => Promise<void>; hasOlder?: boolean; count?: number;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  return <><DevelopmentTurnNavigator items={items.slice(0, count)} scrollRef={scroll} contentRef={content} onJump={onJump} hasOlder={hasOlder} loadOlder={loadOlder} />
    <div ref={scroll} data-testid="scroll"><div ref={content}>{items.map((item) => <article key={item.id} data-message-id={item.id}>{item.assistantPreview}</article>)}</div></div></>;
}

it("shows question/answer previews, neighboring tick expansion and jumps to stable message ids", async () => {
  const jump = vi.fn();
  render(<Harness onJump={jump} />);
  const second = screen.getByRole("button", { name: "跳转到第 2 轮：问题 2" });
  expect(second).toHaveClass("h-2.5");
  expect(second.querySelector("span")).toHaveClass("w-1.5", "h-0.5");
  act(() => second.focus());
  expect(second.querySelector("span")).toHaveStyle({ transform: "scaleX(2.6)" });
  expect(screen.getByRole("button", { name: "跳转到第 1 轮：问题 1" }).querySelector("span")).toHaveStyle({ transform: "scaleX(1.7)" });
  expect(await screen.findByRole("tooltip")).toHaveTextContent("问题 2回复 2");
  fireEvent.click(second);
  expect(jump).toHaveBeenCalledWith("message-2");
  fireEvent.keyDown(second, { key: "ArrowDown" });
  expect(screen.getByRole("button", { name: "跳转到第 3 轮：问题 3" })).toHaveFocus();
});

it("updates the active tick from the transcript scroll position", async () => {
  let top = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = Number(this.dataset.messageId?.split("-")[1] ?? 0);
    const y = index ? (index - 1) * 200 - top : 0;
    return { top: y, bottom: y + 50, left: 0, right: 100, width: 100, height: 50, x: 0, y, toJSON: () => {} };
  });
  render(<Harness />);
  const scroll = screen.getByTestId("scroll");
  Object.defineProperty(scroll, "clientHeight", { value: 150 });
  top = 210;
  fireEvent.scroll(scroll);
  await waitFor(() => expect(screen.getByRole("button", { name: "跳转到第 2 轮：问题 2" })).toHaveAttribute("aria-current", "location"));
});

it("guards repeated history loading and hides a single-turn rail", async () => {
  let finish!: () => void;
  const load = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = render(<Harness count={1} />);
  expect(screen.queryByRole("navigation")).toBeNull();
  view.rerender(<Harness hasOlder loadOlder={load} count={1} />);
  const button = screen.getByRole("button", { name: "加载更早轮次" });
  fireEvent.click(button); fireEvent.click(button);
  expect(load).toHaveBeenCalledOnce();
  expect(button).toBeDisabled();
  await act(async () => finish());
  expect(button).toBeEnabled();
});
