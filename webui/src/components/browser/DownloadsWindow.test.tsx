import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useDownloads", () => ({
  useDownloads: () => ({
    downloads: [],
    hasActiveDownloads: false,
    cancelDownload: vi.fn(),
    pauseDownload: vi.fn(),
    resumeDownload: vi.fn(),
    openDownload: vi.fn(),
    revealDownload: vi.fn(),
    removeDownload: vi.fn(),
    clearCompleted: vi.fn(),
  }),
}));

vi.mock("@/hooks/useTheme", () => ({ useTheme: () => ({}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setSize: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/browser-ipc", () => ({
  browserHideDownloads: vi.fn(),
}));

import { DownloadsWindow } from "./DownloadsWindow";

describe("DownloadsWindow", () => {
  it("shows recent downloads card with empty state", () => {
    render(<DownloadsWindow />);

    expect(screen.getByText("近期的下载记录")).toBeTruthy();
    expect(screen.getByText("暂无下载记录")).toBeTruthy();
  });
});
