import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notes = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/tauri", () => ({
  createNoteFromChat: notes.create,
}));

import { saveReplyImageAsNote } from "./reply-image-note";

describe("saveReplyImageAsNote", () => {
  beforeEach(() => {
    notes.create.mockReset().mockResolvedValue("note-1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the original image bytes and title to the note creation operation", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes, {
      headers: { "Content-Type": "image/png" },
    })));

    await expect(saveReplyImageAsNote("blob:reply-image", "C:\\images\\封面.png", "图片"))
      .resolves.toBe("note-1");

    expect(notes.create).toHaveBeenCalledWith("封面", "", undefined, {
      data: "data:image/png;base64,iVBORwECAw==",
      extension: "png",
    });
  });

  it("uses the fallback title and preserves a different supported image type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), {
      headers: { "Content-Type": "image/webp" },
    })));

    await saveReplyImageAsNote("blob:reply-image", undefined, "图片");
    expect(notes.create).toHaveBeenCalledWith("图片", "", undefined, {
      data: "data:image/webp;base64,AQI=",
      extension: "webp",
    });
  });

  it("does not create a note if the image cannot be saved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), {
      headers: { "Content-Type": "image/png" },
    })));
    notes.create.mockRejectedValue(new Error("storage failed"));

    await expect(saveReplyImageAsNote("blob:reply-image", undefined, "图片")).rejects.toThrow("storage failed");
    expect(notes.create).toHaveBeenCalledOnce();
  });

  it("stops an oversized image even when no content length was provided", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)); },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      headers: { "Content-Type": "image/png" },
    })));

    await expect(saveReplyImageAsNote("blob:reply-image", undefined, "图片")).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(notes.create).not.toHaveBeenCalled();
  });

  it.each([
    ["non-image", new Response("document", { headers: { "Content-Type": "text/html" } })],
    ["oversized", new Response("image", { headers: { "Content-Type": "image/png", "Content-Length": "10485761" } })],
    ["empty", new Response(null, { headers: { "Content-Type": "image/png" } })],
  ])("rejects a %s response before creating an asset", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(saveReplyImageAsNote("blob:reply-image", undefined, "图片")).rejects.toThrow();
    expect(notes.create).not.toHaveBeenCalled();
  });
});
