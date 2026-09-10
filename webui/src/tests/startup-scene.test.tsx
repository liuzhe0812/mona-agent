import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartupScene } from "@/components/StartupScene";

const globalsCss = readFileSync(
  resolve(process.cwd(), "src/globals.css"),
  "utf8",
);

describe("StartupScene", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits 400ms before revealing the human-form connection scene", () => {
    render(<StartupScene />);

    expect(screen.queryByTestId("startup-scene")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(399));
    expect(screen.queryByTestId("startup-scene")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("startup-scene")).toBeInTheDocument();

    const scene = screen.getByTestId("startup-scene");
    expect(scene).toHaveClass("absolute", "inset-0");
    expect(scene).not.toHaveClass("fixed");
    expect(scene.querySelectorAll(".mona-startup-human")).toHaveLength(3);
    expect(scene.querySelector('img[src="/brand/mona_app_icon.png"]')).toBeNull();
    expect(
      scene.querySelector('img[src="/brand/mona_startup_human_ghost_dark.png"]'),
    ).toBeInTheDocument();
    expect(
      scene.querySelector('img[src="/brand/mona_startup_human_ghost_light.png"]'),
    ).toBeInTheDocument();
    expect(
      scene.querySelector('img[src="/brand/mona_startup_human_solid.png"]'),
    ).toBeInTheDocument();
    expect(
      scene.querySelector('img[src="/brand/mona_startup_cat_sleeping.png"]'),
    ).toBeInTheDocument();
    expect(screen.getByText("Mona 唤醒中")).toBeInTheDocument();
    expect(scene).not.toHaveTextContent("服务启动中");
  });

  it("keeps the startup state static when reduced motion is requested", () => {
    const startupStyles = globalsCss.slice(
      globalsCss.indexOf(".mona-startup-scene"),
      globalsCss.indexOf(".shadow-inner-right"),
    );

    expect(startupStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(startupStyles).toMatch(/animation:\s*none/);
  });

  it("cleans up the delayed reveal when the runtime becomes ready", () => {
    const { unmount } = render(<StartupScene />);
    unmount();

    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByTestId("startup-scene")).not.toBeInTheDocument();
  });

  it("reveals before exiting when the runtime becomes ready during the delay", () => {
    const { rerender } = render(<StartupScene />);

    rerender(<StartupScene exiting />);
    act(() => vi.advanceTimersByTime(0));

    expect(screen.getByTestId("startup-scene")).toHaveClass("is-exiting");
  });

  it("reveals the solid form and completes the exit transition", () => {
    const onExitComplete = vi.fn();
    const { rerender } = render(<StartupScene onExitComplete={onExitComplete} />);
    act(() => vi.advanceTimersByTime(400));

    rerender(<StartupScene exiting onExitComplete={onExitComplete} />);
    expect(screen.getByTestId("startup-scene")).toHaveClass("is-exiting");

    act(() => vi.advanceTimersByTime(859));
    expect(onExitComplete).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onExitComplete).toHaveBeenCalledOnce();
  });
});
