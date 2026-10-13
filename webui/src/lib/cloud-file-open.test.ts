import { afterEach, beforeEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  ensure: vi.fn(), openPath: vi.fn(), reveal: vi.fn(), shell: vi.fn(), message: vi.fn(), invoke: vi.fn(),
}));
vi.mock("@/lib/cloud-sync", () => ({ ensureCloudFile: calls.ensure }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: calls.openPath, revealItemInDir: calls.reveal }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: calls.shell }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: calls.message }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: calls.invoke }));
import { openPathWithSystemApp, openWorkspaceCanvasFile, revealItemInDir } from "./tauri";
const path = `D:\\data\\cloud\\${"a".repeat(32)}\\${"b".repeat(64)}\\报告.docx`;

beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  for (const call of Object.values(calls)) call.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { delete window.__TAURI_INTERNALS__; });

it("does not open the native app until the cloud file is actually available", async () => {
  let finish!: () => void;
  calls.ensure.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const opening = openPathWithSystemApp(path);
  await vi.waitFor(() => expect(calls.ensure).toHaveBeenCalledWith(path));
  expect(calls.openPath).not.toHaveBeenCalled();
  finish(); await opening;
  expect(calls.openPath).toHaveBeenCalledWith(path);
  expect(calls.shell).not.toHaveBeenCalled();
});
it.each(["open", "reveal"])("a rejected cloud download displays one failure and never opens stale content: %s", async (operation) => {
  calls.ensure.mockRejectedValueOnce(new Error("文件版本已变化，请刷新会话。"));
  await (operation === "open" ? openPathWithSystemApp(path) : revealItemInDir(path));
  expect(calls.message).toHaveBeenCalledTimes(1);
  expect(calls.message).toHaveBeenCalledWith("文件版本已变化，请刷新会话。", { title: "文件尚未打开", kind: "error" });
  expect(calls.openPath).not.toHaveBeenCalled();
  expect(calls.reveal).not.toHaveBeenCalled();
  expect(calls.shell).not.toHaveBeenCalled();
});
it("ordinary files and folders keep their local-only behavior", async () => {
  await openPathWithSystemApp("D:\\documents\\file.docx");
  await revealItemInDir("D:\\documents\\file.docx");
  expect(calls.ensure).not.toHaveBeenCalled();
  expect(calls.openPath).toHaveBeenCalledOnce(); expect(calls.reveal).toHaveBeenCalledOnce();
});
it("editable canvas files are hydrated before the actual desktop read", async () => {
  const canvasPath = path.replace(/\.docx$/, ".mona-canvas");
  calls.invoke.mockResolvedValueOnce({ path: canvasPath });
  await expect(openWorkspaceCanvasFile(canvasPath)).resolves.toEqual({ path: canvasPath });
  expect(calls.ensure).toHaveBeenCalledWith(canvasPath);
  expect(calls.invoke).toHaveBeenCalledTimes(1);
  expect(calls.invoke).toHaveBeenCalledWith("workspace_canvas_open_file", { path: canvasPath });
  calls.invoke.mockClear(); calls.ensure.mockRejectedValueOnce(new Error("暂时无法下载"));
  await expect(openWorkspaceCanvasFile(canvasPath)).rejects.toThrow("暂时无法下载");
  expect(calls.invoke).not.toHaveBeenCalled();
});
