import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartupScene } from "@/components/StartupScene";
import { MONA_BRAND_AVATAR } from "@/lib/brand-assets";

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
    vi.restoreAllMocks();
  });

  it("waits 400ms before showing the new brand connection scene", () => {
    render(<StartupScene />);

    expect(screen.queryByTestId("startup-scene")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(399));
    expect(screen.queryByTestId("startup-scene")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("startup-scene")).toBeInTheDocument();

    const scene = screen.getByTestId("startup-scene");
    expect(scene).toHaveClass("absolute", "inset-0");
    expect(scene).not.toHaveClass("fixed");
    expect(scene.querySelectorAll("img")).toHaveLength(1);
    expect(scene.querySelector("img")).toHaveAttribute("src", MONA_BRAND_AVATAR);
    expect(screen.getByRole("status", { name: "正在启动 Mona" })).toHaveTextContent("正在接通你的工作台");
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

  it("does not flash a startup scene when the runtime is ready before the delay", () => {
    const onExitComplete = vi.fn();
    const { rerender } = render(<StartupScene onExitComplete={onExitComplete} />);

    act(() => vi.advanceTimersByTime(150));
    rerender(<StartupScene exiting onExitComplete={onExitComplete} />);
    act(() => vi.advanceTimersByTime(0));

    expect(screen.queryByTestId("startup-scene")).not.toBeInTheDocument();
    expect(onExitComplete).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByTestId("startup-scene")).not.toBeInTheDocument();
  });

  it("waits for real readiness before completing the exit transition", () => {
    const onExitComplete = vi.fn();
    const { rerender } = render(<StartupScene onExitComplete={onExitComplete} />);
    act(() => vi.advanceTimersByTime(400));
    act(() => vi.advanceTimersByTime(10_000));
    expect(onExitComplete).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "正在启动 Mona" })).toBeInTheDocument();

    rerender(<StartupScene exiting onExitComplete={onExitComplete} />);
    expect(screen.getByRole("status", { name: "Mona 已就绪" })).toHaveTextContent("工作台已就绪");

    act(() => vi.advanceTimersByTime(319));
    expect(onExitComplete).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onExitComplete).toHaveBeenCalledOnce();
  });

  it("does not delay exit for reduced motion", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const onExitComplete = vi.fn();
    const { rerender } = render(<StartupScene onExitComplete={onExitComplete} />);
    act(() => vi.advanceTimersByTime(400));
    rerender(<StartupScene exiting onExitComplete={onExitComplete} />);
    act(() => vi.advanceTimersByTime(0));
    expect(onExitComplete).toHaveBeenCalledOnce();
  });

  it("cancels an exit if the connection starts again", () => {
    const onExitComplete = vi.fn();
    const { rerender } = render(<StartupScene onExitComplete={onExitComplete} />);
    act(() => vi.advanceTimersByTime(400));
    rerender(<StartupScene exiting onExitComplete={onExitComplete} />);
    act(() => vi.advanceTimersByTime(150));
    rerender(<StartupScene onExitComplete={onExitComplete} />);
    act(() => vi.advanceTimersByTime(500));
    expect(onExitComplete).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "正在启动 Mona" })).toBeInTheDocument();
  });
});
