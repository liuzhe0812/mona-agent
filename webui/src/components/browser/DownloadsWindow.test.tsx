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
  getCurrentWindow: () => ({ onFocusChanged: vi.fn().mockResolvedValue(vi.fn()) }),
}));
vi.mock("@/lib/browser-ipc", () => ({
  browserHideDownloads: vi.fn(),
  browserShowDownloadsWindow: vi.fn(),
}));

import { DownloadsWindow } from "./DownloadsWindow";

describe("DownloadsWindow", () => {
  it("shows download records in a floating panel", () => {
    render(<DownloadsWindow />);

    expect(screen.getByText("下载记录")).toBeTruthy();
    expect(screen.getByText("暂无下载记录")).toBeTruthy();
  });
});
