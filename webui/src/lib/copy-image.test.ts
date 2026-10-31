import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyImageToClipboard } from "./copy-image";

class TestClipboardItem {
  constructor(readonly contents: Record<string, Promise<Blob>>) {}
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let written: Blob | undefined;
const write = vi.fn(async (items: ClipboardItem[]) => {
  written = await (items[0] as unknown as TestClipboardItem).contents["image/png"];
});
const writeText = vi.fn();

beforeEach(() => {
  written = undefined;
  write.mockClear();
  writeText.mockClear();
  vi.stubGlobal("ClipboardItem", TestClipboardItem);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write, writeText },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("copyImageToClipboard", () => {
  it("starts clipboard writing immediately and preserves the PNG bytes", async () => {
    let respond!: (response: Response) => void;
    const fetchImage = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
    vi.stubGlobal("fetch", fetchImage);

    const copying = copyImageToClipboard("/api/media/signed-image");
    expect(fetchImage).toHaveBeenCalledWith("/api/media/signed-image");
    expect(write).toHaveBeenCalledOnce();

    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    respond(new Response(bytes, { headers: { "Content-Type": "image/png" } }));
    await expect(copying).resolves.toBeUndefined();
    expect(written?.type).toBe("image/png");
    expect(new Uint8Array(await written!.arrayBuffer())).toEqual(bytes);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("converts a non-PNG image to PNG and releases its temporary URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["jpeg"], { type: "image/jpeg" }))));
    const createObjectURL = vi.fn(() => "blob:source-image");
    const revokeObjectURL = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    let decoded: unknown;
    vi.stubGlobal("Image", class {
      naturalWidth = 18;
      naturalHeight = 9;
      onload: (() => void) | null = null;
      set src(_value: string) { decoded = this; queueMicrotask(() => this.onload?.()); }
    });
    const canvas = document.createElement("canvas");
    const drawImage = vi.fn();
    vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const png = new Blob(["converted"], { type: "image/png" });
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(png));
    vi.spyOn(document, "createElement").mockReturnValue(canvas);

    await copyImageToClipboard("blob:generated-image");

    expect(canvas.width).toBe(18);
    expect(canvas.height).toBe(9);
    expect(drawImage).toHaveBeenCalledWith(decoded, 0, 0);
    expect(written).toBe(png);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:source-image");
  });

  it("reports a failed image request instead of copying its URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));

    await expect(copyImageToClipboard("/api/media/missing")).rejects.toThrow("Image request failed: 404");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("releases the temporary URL when image decoding fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["broken"], { type: "image/webp" }))));
    const revokeObjectURL = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = () => "blob:broken-image";
      static revokeObjectURL = revokeObjectURL;
    });
    vi.stubGlobal("Image", class {
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    });

    await expect(copyImageToClipboard("blob:original")).rejects.toThrow("Image decoding failed");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:broken-image");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports unsupported image clipboard without fetching or copying text", async () => {
    const fetchImage = vi.fn();
    vi.stubGlobal("fetch", fetchImage);
    vi.stubGlobal("ClipboardItem", undefined);

    await expect(copyImageToClipboard("data:image/png;base64,AA==")).rejects.toThrow("Image clipboard unavailable");
    expect(fetchImage).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
});
