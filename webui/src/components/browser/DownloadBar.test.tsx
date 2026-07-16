import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DownloadBar } from "./DownloadBar";

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

describe("DownloadBar", () => {
  it("shows an empty state when opened from download records", () => {
    render(<DownloadBar open onOpenChange={vi.fn()} />);

    expect(screen.getByText("暂无下载记录")).toBeTruthy();
  });
});
