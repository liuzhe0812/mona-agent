import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostedPlatform } from "./hosted-platform";
import { moveToTrash, openWorkspaceCanvasFile } from "./tauri";

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
