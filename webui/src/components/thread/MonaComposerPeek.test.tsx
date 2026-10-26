import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MonaComposerPeek } from "./MonaComposerPeek";

afterEach(() => vi.restoreAllMocks());

describe("MonaComposerPeek", () => {
  it("renders a single decorative vector with no image layers or focus targets", () => {
    const { container } = render(<MonaComposerPeek />);
    const peek = container.querySelector(".mona-composer-peek");
    expect(peek).toHaveAttribute("aria-hidden", "true");
    expect(peek).toHaveAttribute("data-paused", "false");
    expect(peek).toHaveAttribute("focusable", "false");
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(peek?.querySelector(".mona-composer-peek-head")).toBeInTheDocument();
    expect(peek?.querySelectorAll(".mona-composer-peek-eyes ellipse")).toHaveLength(2);
    expect(container.querySelector("img,image,canvas,button,[tabindex]")).toBeNull();
  });

  it("pauses when its parent is occupied without replacing the artwork", () => {
    const { container, rerender } = render(<MonaComposerPeek />);
    const head = container.querySelector(".mona-composer-peek-head");
    rerender(<MonaComposerPeek paused />);
    expect(container.querySelector(".mona-composer-peek")).toHaveAttribute("data-paused", "true");
    expect(container.querySelector(".mona-composer-peek-head")).toBe(head);
    rerender(<MonaComposerPeek />);
    expect(container.querySelector(".mona-composer-peek")).toHaveAttribute("data-paused", "false");
  });

  it("pauses in a hidden page and cleans up its visibility listener", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const remove = vi.spyOn(document, "removeEventListener");
    const { container, unmount } = render(<MonaComposerPeek />);
    hidden.mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.querySelector(".mona-composer-peek")).toHaveAttribute("data-paused", "true");
    hidden.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.querySelector(".mona-composer-peek")).toHaveAttribute("data-paused", "false");
    unmount();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });
});
