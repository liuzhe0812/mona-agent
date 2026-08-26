import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartupScene } from "@/components/StartupScene";

describe("StartupScene", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits 400ms before revealing the branded connection scene", () => {
    render(<StartupScene />);

    expect(screen.queryByTestId("startup-scene")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(399));
    expect(screen.queryByTestId("startup-scene")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("startup-scene")).toBeInTheDocument();
    expect(screen.getByText("MONA / BOOTING")).toBeInTheDocument();
    expect(screen.getByText("Mona 正在醒来")).toBeInTheDocument();
    expect(screen.getByText("正在接通你的工作台")).toBeInTheDocument();
    expect(screen.getByText("WORKSPACE / CONNECTING")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Mona" })).toHaveAttribute(
      "src",
      "/brand/mona_app_icon.png",
    );
  });

  it("cleans up the delayed reveal when the runtime becomes ready", () => {
    const { unmount } = render(<StartupScene />);
    unmount();

    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByTestId("startup-scene")).not.toBeInTheDocument();
  });
});
