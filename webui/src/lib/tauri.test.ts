import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  createNoteFromChat,
  deleteDesktopNotes,
  httpFetch,
  listWorkspaceCanvases,
  migrateLegacyCanvases,
  openWorkspaceCanvasFile,
  readWorkspaceCanvas,
  saveNoteImageData,
  saveWorkspaceCanvas,
  writeWorkspaceCanvasFile,
} from "./tauri";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createNoteFromChat", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    mocks.invoke.mockReset().mockResolvedValue("note-1");
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  it("notifies the notes module after a successful save", async () => {
    const changed = vi.fn();
    window.addEventListener("mona:notes-changed", changed);

    await expect(createNoteFromChat("标题", "# 内容", "notebook-1")).resolves.toBe("note-1");

    expect(mocks.invoke).toHaveBeenCalledWith("notes_create_from_chat", {
      title: "标题",
      contentMarkdown: "# 内容",
      notebookId: "notebook-1",
    });
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener("mona:notes-changed", changed);
  });

  it("does not notify the notes module when saving fails", async () => {
    const changed = vi.fn();
    const error = new Error("保存失败");
    mocks.invoke.mockRejectedValue(error);
    window.addEventListener("mona:notes-changed", changed);

    await expect(createNoteFromChat("标题", "# 内容")).rejects.toBe(error);

    expect(changed).not.toHaveBeenCalled();
    window.removeEventListener("mona:notes-changed", changed);
  });

  it("saves base64 image data through the notes command", async () => {
    mocks.invoke.mockResolvedValueOnce("assets/frame.png");
    await expect(saveNoteImageData("data:image/png;base64,aGVsbG8=", "frame.png"))
      .resolves.toBe("assets/frame.png");

    expect(mocks.invoke).toHaveBeenCalledWith("notes_save_image_data", {
      imageData: "data:image/png;base64,aGVsbG8=",
      fileName: "frame.png",
    });
  });

  it("deletes only the explicitly selected notes", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);

    await expect(deleteDesktopNotes(["note-1", "note-2"])).resolves.toBeUndefined();

    expect(mocks.invoke).toHaveBeenCalledWith("notes_delete", {
      noteIds: ["note-1", "note-2"],
    });
  });

  it("saves one canvas artifact and notifies the workspace", async () => {
    const canvas = {
      version: 1 as const,
      id: "canvas-1",
      kind: "flowchart" as const,
      title: "退款审批流程图",
      originChatId: "chat-1",
      createdAt: "2026-09-02T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
      contentMarkdown: "# 退款审批流程图",
    };
    const saved = { canvas, path: "D:\\workspace\\canvases\\退款审批流程图.mona-canvas" };
    mocks.invoke.mockResolvedValueOnce(saved);
    const changed = vi.fn();
    window.addEventListener("mona:workspace-canvas-changed", changed);

    await expect(saveWorkspaceCanvas("D:\\workspace", canvas)).resolves.toEqual(saved);

    expect(mocks.invoke).toHaveBeenCalledWith("workspace_canvas_save", {
      workspaceRoot: "D:\\workspace",
      canvas,
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      canvasId: "canvas-1",
      path: "D:\\workspace\\canvases\\退款审批流程图.mona-canvas",
    });
    window.removeEventListener("mona:workspace-canvas-changed", changed);
  });

  it("passes workspace canvas list, read, and migration arguments to Tauri", async () => {
    mocks.invoke.mockResolvedValueOnce([]);
    await expect(listWorkspaceCanvases("D:\\workspace", "chat-1")).resolves.toEqual([]);
    expect(mocks.invoke).toHaveBeenLastCalledWith("workspace_canvas_list", {
      workspaceRoot: "D:\\workspace",
      chatId: "chat-1",
    });

    const saved = {
      canvas: {
        version: 1 as const,
        id: "canvas-1",
        kind: "mindmap" as const,
        title: "产品规划思维导图",
        originChatId: "chat-1",
        createdAt: "2026-09-02T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
        contentMarkdown: "# 产品规划思维导图",
      },
      path: "D:\\workspace\\canvases\\产品规划思维导图.mona-canvas",
    };
    mocks.invoke.mockResolvedValueOnce(saved);
    await expect(
      readWorkspaceCanvas("D:\\workspace", saved.path),
    ).resolves.toEqual(saved);
    expect(mocks.invoke).toHaveBeenLastCalledWith("workspace_canvas_read", {
      workspaceRoot: "D:\\workspace",
      path: saved.path,
    });

    mocks.invoke.mockResolvedValueOnce(2);
    await expect(migrateLegacyCanvases("D:\\workspace")).resolves.toBe(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith("workspace_canvas_migrate_legacy", {
      workspaceRoot: "D:\\workspace",
    });
  });

  it("opens and writes standalone canvas files through Tauri", async () => {
    const canvas = {
      version: 1 as const,
      id: "canvas-1",
      kind: "flowchart" as const,
      title: "退款审批流程图",
      createdAt: "2026-09-02T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
      contentMarkdown: "# 退款审批流程图",
    };
    const saved = { canvas, path: "D:\\workspace\\退款审批流程图.mona-canvas" };
    mocks.invoke.mockResolvedValueOnce(saved);
    await expect(openWorkspaceCanvasFile(saved.path)).resolves.toEqual(saved);
    expect(mocks.invoke).toHaveBeenLastCalledWith("workspace_canvas_open_file", { path: saved.path });

    mocks.invoke.mockResolvedValueOnce(saved);
    await expect(writeWorkspaceCanvasFile(saved.path, canvas)).resolves.toEqual(saved);
    expect(mocks.invoke).toHaveBeenLastCalledWith("workspace_canvas_write_file", {
      path: saved.path,
      canvas,
    });
  });
});

describe("httpFetch cancellation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    mocks.invoke.mockReset();
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  it("passes an abort handle through the loopback bridge", async () => {
    mocks.invoke
      .mockResolvedValueOnce(41)
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: [["content-type", "image/png"]],
        body: [112, 110, 103],
      });
    const signal = new AbortController().signal;

    const response = await httpFetch("http://127.0.0.1:17173/api/file-preview", { signal });

    expect(await response.text()).toBe("png");
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "local_http_prepare_cancel", undefined);
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "local_http_request", {
      method: "GET",
      url: "http://127.0.0.1:17173/api/file-preview",
      headers: [],
      body: null,
      cancellationId: 41,
    });
  });

  it("cancels a prepared handle if aborted while preparing it", async () => {
    const prepare = deferred<number>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "local_http_prepare_cancel") return prepare.promise;
      return Promise.resolve(undefined);
    });
    const controller = new AbortController();

    const pending = httpFetch("http://127.0.0.1:17173/api/file-preview", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "local_http_prepare_cancel",
      undefined,
    ));
    controller.abort();
    prepare.resolve(52);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.invoke).toHaveBeenCalledWith("local_http_cancel", { cancellationId: 52 });
    expect(mocks.invoke).not.toHaveBeenCalledWith("local_http_request", expect.anything());
  });

  it("cancels an in-flight loopback request and reports AbortError", async () => {
    const request = deferred<{
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
      body: number[];
    }>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "local_http_prepare_cancel") return Promise.resolve(63);
      if (command === "local_http_request") return request.promise;
      if (command === "local_http_cancel") {
        request.reject(new Error("request cancelled"));
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    const controller = new AbortController();
    const pending = httpFetch("http://127.0.0.1:17173/api/file-preview", {
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "local_http_request",
      expect.objectContaining({ cancellationId: 63 }),
    ));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.invoke).toHaveBeenCalledWith("local_http_cancel", { cancellationId: 63 });
  });

  it("preserves the timeout reason and cancels the native request without waiting for it", async () => {
    const request = deferred<never>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "local_http_prepare_cancel") return Promise.resolve(74);
      if (command === "local_http_request") return request.promise;
      return Promise.resolve(undefined);
    });
    const controller = new AbortController();
    const pending = httpFetch("http://127.0.0.1:17173/api/webui/history", {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "local_http_request",
      expect.objectContaining({ cancellationId: 74 }),
    ));

    const timeout = new DOMException("The request timed out.", "TimeoutError");
    controller.abort(timeout);

    await expect(pending).rejects.toBe(timeout);
    expect(mocks.invoke).toHaveBeenCalledWith("local_http_cancel", { cancellationId: 74 });
  });

  it("keeps uncancellable loopback calls on the existing request contract", async () => {
    mocks.invoke.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: [],
      body: [],
    });

    await httpFetch("http://127.0.0.1:17173/api/file-preview");

    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("local_http_request", {
      method: "GET",
      url: "http://127.0.0.1:17173/api/file-preview",
      headers: [],
      body: null,
    });
  });
});
