import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDesktopUnreadBadge } from "@/hooks/useDesktopUnreadBadge";

const mocks = vi.hoisted(() => ({
  window: {
    label: "main",
    setOverlayIcon: vi.fn(async () => {}),
    setBadgeLabel: vi.fn(async () => {}),
  },
  newImage: vi.fn(),
}));

vi.mock("@tauri-apps/api/image", () => ({ Image: { new: mocks.newImage } }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks.window }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("desktop unread badge", () => {
  it("draws the Windows count, releases its image and clears the overlay at zero", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Windows");
    const icon = { close: vi.fn(async () => {}) };
    mocks.newImage.mockResolvedValue(icon);
    const draw = {
      beginPath: vi.fn(),
      roundRect: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray(32 * 32 * 4) }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(draw as unknown as CanvasRenderingContext2D);

    const { rerender } = renderHook(useDesktopUnreadBadge, { initialProps: 104 });
    await waitFor(() => expect(icon.close).toHaveBeenCalledOnce());
    expect(draw.fillText).toHaveBeenCalledWith("99+", 16, 16, 26);
    expect(mocks.window.setOverlayIcon).toHaveBeenLastCalledWith(icon);

    rerender(0);
    await waitFor(() => expect(mocks.window.setOverlayIcon).toHaveBeenLastCalledWith(undefined));
  });

  it("sets and clears the macOS Dock label", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Macintosh");

    const { rerender } = renderHook(useDesktopUnreadBadge, { initialProps: 3 });
    await waitFor(() => expect(mocks.window.setBadgeLabel).toHaveBeenLastCalledWith("3"));
    rerender(0);
    await waitFor(() => expect(mocks.window.setBadgeLabel).toHaveBeenLastCalledWith(undefined));
    expect(mocks.window.setOverlayIcon).not.toHaveBeenCalled();
  });
});
