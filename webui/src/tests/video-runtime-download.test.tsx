import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VideoRuntimeDialog } from "@/components/doc/video/VideoRuntimeDialog";
import { VideoRuntimeDownloadIndicator } from "@/components/workspace/VideoRuntimeDownloadIndicator";
import { useVideoRuntimeDownloadStore } from "@/lib/video-runtime-download-store";

describe("VideoRuntimeDialog", () => {
  beforeEach(() => {
    useVideoRuntimeDownloadStore.setState({ jobs: [], error: null });
  });

  it("can close while installation continues in the background", () => {
    const onClose = vi.fn();
    useVideoRuntimeDownloadStore.setState({
      error: null,
      jobs: [
        {
          jobId: "job-1",
          state: "running",
          progress: 35,
          currentComponent: "ffmpeg",
          createdAt: 1,
          updatedAt: 2,
          components: {
            ffmpeg: {
              component: "ffmpeg",
              state: "downloading",
              progress: 35,
              receivedBytes: 35,
              totalBytes: 100,
            },
          },
        },
      ],
    });

    render(
      <VideoRuntimeDialog
        open
        onClose={onClose}
        runtimeStatus={{
          node: { ok: true, version: "v24" },
          ffmpeg: { ok: false },
          chrome: { ok: true, version: "151" },
        }}
        onInstall={vi.fn()}
      />,
    );

    expect(screen.getByText("35%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭，后台继续" }));
    expect(onClose).toHaveBeenCalled();
    expect(useVideoRuntimeDownloadStore.getState().jobs[0].state).toBe("running");
  });

  it("asks the user to install Edge or Chrome instead of downloading a browser", () => {
    const onInstall = vi.fn();

    render(
      <VideoRuntimeDialog
        open
        onClose={vi.fn()}
        runtimeStatus={{
          node: { ok: true, version: "v24" },
          ffmpeg: { ok: true, version: "6.1" },
          chrome: { ok: false },
        }}
        onInstall={onInstall}
      />,
    );

    expect(
      screen.getByText("请安装系统 Edge 或 Chrome 后再导出"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "一键下载缺失组件" }),
    ).not.toBeInTheDocument();
    expect(onInstall).not.toHaveBeenCalled();
  });
});

describe("VideoRuntimeDownloadIndicator", () => {
  beforeEach(() => {
    useVideoRuntimeDownloadStore.setState({ jobs: [], error: null });
  });

  it("does not expose legacy Chrome download entries", () => {
    useVideoRuntimeDownloadStore.setState({
      error: null,
      jobs: [
        {
          jobId: "legacy-browser-job",
          state: "completed",
          progress: 100,
          currentComponent: "chrome",
          createdAt: 1,
          updatedAt: 2,
          components: {
            chrome: {
              component: "chrome",
              state: "completed",
              progress: 100,
              receivedBytes: 100,
              totalBytes: 100,
            },
          },
        },
      ],
    });

    render(<VideoRuntimeDownloadIndicator />);

    expect(screen.queryByRole("button", { name: /视频组件下载/ })).not.toBeInTheDocument();
  });
});
