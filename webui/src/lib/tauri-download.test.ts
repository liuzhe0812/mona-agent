import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ save: vi.fn(), writeFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: native.writeFile }));

import { downloadMediaBlob, downloadMediaUrl } from "./tauri";

describe("downloadMediaUrl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
    native.save.mockReset();
    native.writeFile.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
  });

  it.each(["data:text/plain,hello", "blob:browser-owned"])(
    "downloads local %s directly without fetching or revoking the caller's URL",
    async (url) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
        expect(this.href).toBe(url);
        expect(this.download).toBe("map.mm");
        expect(this.isConnected).toBe(true);
      });

      await expect(downloadMediaUrl(url, "map.mm")).resolves.toBeNull();
      expect(click).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it("keeps a generated blob URL alive until after download starts", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:generated");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["image"], { type: "image/png" });

    await expect(downloadMediaBlob(blob, "map.png")).resolves.toBeNull();
    expect(create).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:generated");
  });

  it("fetches HTTP media, rejects failed responses, and releases successful downloads later", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["ok"]) });
    vi.stubGlobal("fetch", fetchMock);
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await expect(downloadMediaUrl("https://example.test/missing", "file.png"))
      .rejects.toThrow("文件暂时无法下载");
    expect(create).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    await expect(downloadMediaUrl("https://example.test/file", "file.png")).resolves.toBeNull();
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:http");
  });

  it("keeps the native save dialog and byte write", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    native.save.mockResolvedValueOnce("C:/downloads/map.mm");
    native.writeFile.mockResolvedValueOnce(undefined);
    await expect(downloadMediaUrl("data:text/plain;charset=utf-8,%E6%A0%B9", "map.mm"))
      .resolves.toBe("C:/downloads/map.mm");
    expect(native.save).toHaveBeenCalledWith({ defaultPath: "map.mm" });
    expect(native.writeFile).toHaveBeenCalledWith("C:/downloads/map.mm", new TextEncoder().encode("根"));
  });
});
