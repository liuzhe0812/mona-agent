import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureHostedPlatform } from "@/lib/hosted-platform";
import type { SavedWorkspaceCanvas, WorkspaceCanvasDocument } from "@/lib/tauri";

const mocks = vi.hoisted(() => ({ open: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ openWorkspaceCanvasFile: mocks.open, writeWorkspaceCanvasFile: mocks.write }));
vi.mock("./ConversationCanvasPanel", () => ({
  ConversationCanvasPanel: ({ canvas, onContentChange }: {
    canvas: { note: { id: string; contentMarkdown: string }; saveStatus: string; error?: string };
    onContentChange: (id: string, value: { contentMarkdown: string }) => void;
  }) => <div><textarea aria-label="画布正文" value={canvas.note.contentMarkdown}
    onChange={(event) => onContentChange(canvas.note.id, { contentMarkdown: event.target.value })} />
    <span data-testid="save-status">{canvas.saveStatus}</span><span>{canvas.error}</span></div>,
}));

import { CanvasFileView } from "./CanvasFileView";

const FIRST = "/workspace/canvases/first.mona-canvas";
const SECOND = "/workspace/canvases/second.mona-canvas";
function saved(path: string, contentMarkdown = "# 原始内容"): SavedWorkspaceCanvas {
  return { path, canvas: { version: 1, id: "same-canvas-id", kind: "mindmap", title: "画布",
    createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z", contentMarkdown } };
}

describe("CanvasFileView pending saves", () => {
  let releaseAccount: (() => void) | undefined;
  beforeEach(() => {
    mocks.open.mockReset().mockImplementation(async (path: string) => saved(path));
    mocks.write.mockReset().mockImplementation(async (path: string, canvas: WorkspaceCanvasDocument) => ({ path, canvas }));
  });
  afterEach(() => {
    cleanup();
    releaseAccount?.();
    releaseAccount = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("flushes the old file before switching and keeps its later error out of the new file", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const { rerender } = render(<CanvasFileView filePath={FIRST} />);
    await screen.findByRole("textbox", { name: "画布正文" });
    let fail!: (error: Error) => void;
    mocks.write.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    mocks.open.mockImplementation(async (path: string) => saved(path, "# 最后一笔"));
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "# 最后一笔" } });
    rerender(<CanvasFileView filePath={SECOND} />);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledWith(FIRST, expect.objectContaining({ contentMarkdown: "# 最后一笔" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("save-status")).toHaveTextContent("saved");
    await act(async () => { fail(new Error("旧写入结果未知")); await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByTestId("save-status")).toHaveTextContent("saved");
    expect(screen.queryByText(/旧写入结果未知/)).not.toBeInTheDocument();
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledOnce();
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("保存未能确认"));
  });

  it.each([0, 450])("saves once on unmount with a pending or dispatched write after %i ms", async (elapsed) => {
    const { unmount } = render(<CanvasFileView filePath={FIRST} />);
    await screen.findByRole("textbox", { name: "画布正文" });
    mocks.write.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "# 离开前编辑" } });
    act(() => vi.advanceTimersByTime(elapsed));
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledWith(FIRST, expect.objectContaining({ contentMarkdown: "# 离开前编辑" }));
  });

  it("does not send the old account's pending file to a new hosted session", async () => {
    const releaseOld = configureHostedPlatform({ apiBase: "/api/work/desktop", token: "account-a" });
    const { unmount } = render(<CanvasFileView filePath={FIRST} />);
    await screen.findByRole("textbox", { name: "画布正文" });
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "# 旧账号内容" } });
    releaseAccount = configureHostedPlatform({ apiBase: "/api/work/desktop", token: "account-b" });
    unmount();
    releaseOld();
    act(() => vi.advanceTimersByTime(1000));
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
