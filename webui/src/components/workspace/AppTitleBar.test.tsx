import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startDragging = vi.fn().mockResolvedValue(undefined);
const windowState = vi.hoisted(() => ({ maximized: false, onResize: undefined as (() => void) | undefined }));
const unlistenResize = vi.hoisted(() => vi.fn());
const toggleMaximize = vi.hoisted(() => vi.fn(async () => { windowState.maximized = !windowState.maximized; }));

vi.mock("@/components/ConnectionBadge", () => ({ ConnectionBadge: () => null }));
vi.mock("@/components/browser/BrowserTab", () => ({ BrowserTabItem: () => null }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging,
    toggleMaximize,
    isMaximized: async () => windowState.maximized,
    onResized: async (handler: () => void) => {
      windowState.onResize = handler;
      return unlistenResize;
    },
  }),
}));

import { AppTitleBar } from "./AppTitleBar";
import { useVideoRuntimeDownloadStore } from "@/lib/video-runtime-download-store";

describe("AppTitleBar", () => {
  beforeEach(() => {
    startDragging.mockClear();
    windowState.maximized = false;
    windowState.onResize = undefined;
    unlistenResize.mockClear();
    toggleMaximize.mockClear();
    useVideoRuntimeDownloadStore.setState({ jobs: [], error: null });
  });

  it("marks non-interactive title bar content as a native drag region", () => {
    const { container } = render(
      <AppTitleBar
        tabs={[]}
        activeTabId="mona"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

    expect(container.querySelector("header")?.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("does not issue a second drag command alongside Tauri's native drag region", () => {
    const { container } = render(
      <AppTitleBar
        tabs={[]}
        activeTabId="mona"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

    fireEvent.mouseDown(container.querySelector("header > div")!, { button: 0 });

    expect(startDragging).not.toHaveBeenCalled();
  });

  it("names the browser-tab creation control", () => {
    render(
      <AppTitleBar
        tabs={[]}
        activeTabId="mona"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "New browser tab" })).toBeInTheDocument();
  });

  it("shows background video-runtime download progress in the title bar", async () => {
    useVideoRuntimeDownloadStore.setState({
      error: null,
      jobs: [
        {
          jobId: "job-1",
          state: "running",
          progress: 42,
          currentComponent: "ffmpeg",
          createdAt: 1,
          updatedAt: 2,
          components: {
            ffmpeg: {
              component: "ffmpeg",
              state: "downloading",
              progress: 42,
              receivedBytes: 42,
              totalBytes: 100,
            },
          },
        },
      ],
    });

    render(
      <AppTitleBar
        tabs={[]}
        activeTabId="mona"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewTab={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "视频组件下载中 42%" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByText("FFmpeg")).toBeInTheDocument();
    expect(screen.getAllByText("42%").length).toBeGreaterThan(0);
  });

  it("switches between maximize and restore when the window is toggled", async () => {
    render(<AppTitleBar tabs={[]} activeTabId="mona" onTabClick={vi.fn()} onTabClose={vi.fn()} onNewTab={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    expect(await screen.findByRole("button", { name: "还原" })).toHaveAttribute("title", "还原");
    fireEvent.click(screen.getByRole("button", { name: "还原" }));
    expect(await screen.findByRole("button", { name: "最大化" })).toHaveAttribute("title", "最大化");
    expect(toggleMaximize).toHaveBeenCalledTimes(2);
  });

  it("reads the initial window state and follows native window resize events", async () => {
    windowState.maximized = true;
    const { unmount } = render(<AppTitleBar tabs={[]} activeTabId="mona" onTabClick={vi.fn()} onTabClose={vi.fn()} onNewTab={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "还原" })).toBeInTheDocument();

    await act(async () => {
      windowState.maximized = false;
      windowState.onResize?.();
    });
    expect(screen.getByRole("button", { name: "最大化" })).toBeInTheDocument();
    unmount();
    expect(unlistenResize).toHaveBeenCalledTimes(1);
  });
});
