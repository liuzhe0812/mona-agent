import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { VideoSeries } from "@/lib/api";
import { SavedVideoStyleGallery } from "./SavedVideoStyleGallery";

const mocks = vi.hoisted(() => ({
  fetchVideoStyleVersions: vi.fn(async () => ({ styles: [{ version: 1 }] })),
  previewVideoStyle: vi.fn(async () => ({ html: "<html>preview</html>" })),
  fetchVideoStyleSample: vi.fn(),
  httpFetch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchVideoStyleVersions: mocks.fetchVideoStyleVersions,
  previewVideoStyle: mocks.previewVideoStyle,
  getServicesHttpBase: vi.fn(),
}));
vi.mock("@/lib/video-style-api", () => ({ fetchVideoStyleSample: mocks.fetchVideoStyleSample }));
vi.mock("@/lib/tauri", () => ({ httpFetch: mocks.httpFetch }));

describe("SavedVideoStyleGallery", () => {
  it("does not retain a poster blob that finishes loading after the gallery is hidden", async () => {
    let finishBlob!: (value: Blob) => void;
    const blob = vi.fn(() => new Promise<Blob>((resolve) => { finishBlob = resolve; }));
    mocks.httpFetch.mockResolvedValue({ ok: true, blob });
    const originalCreate = URL.createObjectURL;
    const create = vi.fn(() => "blob:poster");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
    const item = { id: "poster", name: "样片", latestStyleVersion: 1,
      styleSummary: { preview: { poster: "/poster.png" } } } as VideoSeries;
    const noop = () => {};
    const view = (visible: boolean) => <SavedVideoStyleGallery token="tok" series={[item]} selectedId="poster"
      visible={visible} onSelect={noop} onEdit={noop} onCopy={noop} onRename={noop} onDelete={noop} onCreate={noop} />;
    try {
      const rendered = render(view(true));
      await waitFor(() => expect(blob).toHaveBeenCalledOnce());
      rendered.rerender(view(false));
      await act(async () => finishBlob(new Blob(["poster"], { type: "image/png" })));
      expect(create).not.toHaveBeenCalled();
      expect(screen.queryByAltText("样片风格样片")).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
    }
  });

  it("does not load hidden previews and releases them without losing selection", async () => {
    const item = { id: "legacy", name: "旧风格", latestStyleVersion: 1 } as VideoSeries;
    const noop = () => {};
    const view = (visible: boolean) => <SavedVideoStyleGallery token="tok" series={[item]} selectedId="legacy"
      visible={visible} onSelect={noop} onEdit={noop} onCopy={noop} onRename={noop} onDelete={noop} onCreate={noop} />;
    const rendered = render(view(false));
    expect(mocks.fetchVideoStyleVersions).not.toHaveBeenCalled();
    expect(screen.queryByTitle("旧风格样式预览")).not.toBeInTheDocument();

    rendered.rerender(view(true));
    await screen.findByTitle("旧风格样式预览");
    fireEvent.click(screen.getByRole("button", { name: "预览旧风格" }));
    await screen.findByTitle("旧风格完整样片");

    rendered.rerender(view(false));
    expect(screen.queryByTitle("旧风格样式预览")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTitle("旧风格完整样片")).not.toBeInTheDocument());
    rendered.rerender(view(true));

    await screen.findByTitle("旧风格样式预览");
    expect(screen.queryByTitle("旧风格完整样片")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择旧风格" })).toHaveAttribute("aria-pressed", "true");
  });
});
