import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostedPlatform } from "./hosted-platform";
import { listWorkspaceCanvases, moveToTrash, openWorkspaceCanvasFile, writeWorkspaceCanvasFile } from "./tauri";

const path = "/workspace/canvases/observed.mona-canvas";
const observed = "a".repeat(64);
const latest = "b".repeat(64);
const releases: Array<() => void> = [];
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const saved = { path, sha256: observed, canvas: { id: "observed" } };
const configure = (token: string) => releases.push(configureHostedPlatform({ apiBase: "/api/work/desktop", token }));

beforeEach(() => { configure("synthetic-account-A"); });
afterEach(() => { while (releases.length) releases.pop()?.(); vi.unstubAllGlobals(); });

describe("hosted recoverable file deletion", () => {
  it("requires an already observed version without reading a fresh version before deletion", async () => {
    const fetcher = vi.fn().mockResolvedValue(reply(null));
    vi.stubGlobal("fetch", fetcher);
    await expect(moveToTrash(path)).rejects.toThrow("刷新文件列表");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(moveToTrash("/workspace/result.txt", observed)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ command: "move_to_trash",
      args: { path: "/workspace/result.txt", expectedSha256: observed } });
  });

  it("uses a canvas version already read, while the selected file version takes precedence", async () => {
    const fetcher = vi.fn(async (_url, init) => reply(JSON.parse(init.body).command === "workspace_canvas_open_file" ? saved : null));
    vi.stubGlobal("fetch", fetcher);
    await openWorkspaceCanvasFile(path);
    await moveToTrash(path);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).args).toEqual({ path, expectedSha256: observed });
    await openWorkspaceCanvasFile(path);
    await moveToTrash(path, latest);
    expect(JSON.parse(fetcher.mock.calls[3][1].body).args).toEqual({ path, expectedSha256: latest });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("surfaces a stale version and does not reuse another account's canvas version", async () => {
    const fetcher = vi.fn(async (_url, init) => JSON.parse(init.body).command === "workspace_canvas_open_file"
      ? reply(saved) : reply({ error: { code: "file_changed", message: "文件已变化，请刷新后核对。" } }, 409));
    vi.stubGlobal("fetch", fetcher);
    await openWorkspaceCanvasFile(path);
    await expect(moveToTrash(path)).rejects.toMatchObject({ message: "文件已变化，请刷新后核对。", status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    configure("synthetic-account-B");
    await expect(moveToTrash(path)).rejects.toThrow("刷新文件列表");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("hosted canvas save revisions", () => {
  it("finishes an already queued save before opening the canvas again", async () => {
    let finishWrite!: (response: Response) => void;
    let onServer = saved;
    const fetcher = vi.fn(async (_url, init) => JSON.parse(init.body).command === "workspace_canvas_write_file"
      ? new Promise<Response>(resolve => { finishWrite = resolve; }) : reply(onServer));
    vi.stubGlobal("fetch", fetcher);
    const opened = await openWorkspaceCanvasFile(path);
    const saving = writeWorkspaceCanvasFile(path, opened.canvas);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const reopening = openWorkspaceCanvasFile(path);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
    onServer = { ...saved, sha256: latest };
    finishWrite(reply(onServer));
    await saving;
    await expect(reopening).resolves.toMatchObject({ sha256: latest });
  });

  it("does not let an old list response roll back the version of a completed save", async () => {
    let finishList!: (response: Response) => void;
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.command === "workspace_canvas_list") return new Promise<Response>(resolve => { finishList = resolve; });
      return reply(body.command === "workspace_canvas_write_file" ? { ...saved, sha256: latest } : saved);
    });
    vi.stubGlobal("fetch", fetcher);
    const opened = await openWorkspaceCanvasFile(path);
    const stale = listWorkspaceCanvases("/workspace");
    const rejected = expect(stale).rejects.toMatchObject({ status: 409, code: "canvas_changed" });
    await writeWorkspaceCanvasFile(path, opened.canvas);
    finishList(reply([saved]));
    await rejected;
    await writeWorkspaceCanvasFile(path, opened.canvas);
    const writes = fetcher.mock.calls.map(call => JSON.parse(call[1].body))
      .filter(body => body.command === "workspace_canvas_write_file");
    expect(writes.map(body => body.args.expectedSha256)).toEqual([observed, latest]);
  });

  it("discards a canvas body if the account changes during JSON decoding", async () => {
    const response = reply(saved);
    let finishBody!: (value: unknown) => void;
    const decode = vi.spyOn(response, "json").mockImplementation(() => new Promise(resolve => { finishBody = resolve; }));
    const fetcher = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetcher);
    const opening = openWorkspaceCanvasFile(path);
    const rejected = expect(opening).rejects.toThrow("账号已变化");
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    configure("synthetic-account-B");
    finishBody(saved);
    await rejected;
    await expect(moveToTrash(path)).rejects.toThrow("刷新文件列表");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
