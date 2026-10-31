import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ status: vi.fn(), history: vi.fn(), files: vi.fn(), download: vi.fn(), restore: vi.fn(), previewTrash: vi.fn(), applyTrash: vi.fn() }));
vi.mock("@/lib/cloud-sync", () => ({ cloudSyncApi: api }));
import { CloudHistoryDialog } from "./CloudHistoryDialog";

const rid = "a".repeat(32);
const fileId = "b".repeat(64);
const conversations = [{ key: "websocket:other", resource_id: "e".repeat(32), version: 5, conflict_copy: false },
  { key: "websocket:one", resource_id: rid, version: 3, conflict_copy: false }];
const version = { version: 3, created_at: "2026-10-12T08:00:00Z", deleted: false };
const page = { items: [version], has_more: false, next_before: 3 };
const file = { id: fileId, name: "方案.docx", size: 1024, local: false };

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.status.mockResolvedValue({ available: true, space: { quota_bytes: 10, used_bytes: 1, reserved_bytes: 0, object_count: 1 }, conversations });
  api.history.mockResolvedValue(page);
  api.files.mockResolvedValue([file]);
  api.download.mockResolvedValue(undefined);
  api.restore.mockResolvedValue({ restored: true, key: "websocket:restored-one", reused: false });
  api.previewTrash.mockResolvedValue({ draft_id: "c".repeat(32), resource_id: rid, kind: "work_conversation", version: 3, action: "trash", expires_at: 1 });
  api.applyTrash.mockResolvedValue({ complete: true, resource_id: rid, kind: "work_conversation", version: 4, action: "trash", reused: false, released_bytes: 0 });
});
function show(onRestored = vi.fn()) {
  return render(<CloudHistoryDialog sessionKey="websocket:one" title="课程方案" onClose={vi.fn()} onRestored={onRestored} />);
}
async function open() {
  await screen.findByRole("button", { name: "恢复版本 3" });
}
function filesTab() { fireEvent.mouseDown(screen.getByRole("tab", { name: "关联文件" }), { button: 0, ctrlKey: false }); }

describe("cloud history and on-demand files", () => {
  it("loads only the selected conversation and defers file downloads", async () => {
    show(); await open();
    expect(screen.getByText("课程方案")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择云会话" })).not.toBeInTheDocument();
    expect(api.status).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(api.history).toHaveBeenCalledWith(rid, undefined, expect.any(AbortSignal));
    expect(api.files).not.toHaveBeenCalled();
    expect(api.download).not.toHaveBeenCalled();
  });

  it("restoring requires explicit confirmation and cancellation has no effect", async () => {
    show(); await open();
    fireEvent.click(screen.getByRole("button", { name: "恢复版本 3" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("当前会话不会被覆盖");
    expect(api.restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(api.restore).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "恢复版本 3" })).toBeInTheDocument();
  });

  it("successful restore shows the new-conversation result and refreshes its owner", async () => {
    const refreshed = vi.fn(); show(refreshed); await open();
    fireEvent.click(screen.getByRole("button", { name: "恢复版本 3" }));
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
    expect(await screen.findByText("已恢复为新会话，可在会话列表中查看。")).toBeInTheDocument();
    expect(api.restore).toHaveBeenCalledWith(rid, 3, expect.stringMatching(/^[a-f0-9]{32}$/));
    expect(refreshed).toHaveBeenCalledTimes(1);
  });

  it("an uncertain restore retains its operation id for an explicit retry", async () => {
    api.restore.mockRejectedValueOnce(new Error("恢复结果尚未确认，请重试核对。"))
      .mockResolvedValueOnce({ restored: true, key: "websocket:restored-one", reused: true });
    show(); await open();
    fireEvent.click(screen.getByRole("button", { name: "恢复版本 3" }));
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("恢复结果尚未确认");
    expect(api.restore).toHaveBeenCalledTimes(1);
    const operation = api.restore.mock.calls[0][2];
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
    await screen.findByText("已恢复为新会话，可在会话列表中查看。");
    expect(api.restore.mock.calls[1][2]).toBe(operation);
  });

  it("pending restore cannot be submitted twice or dismissed", async () => {
    let finish!: (value: unknown) => void;
    api.restore.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = show(); await open();
    fireEvent.click(screen.getByRole("button", { name: "恢复版本 3" }));
    const confirm = screen.getByRole("button", { name: "确认恢复" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(api.restore).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    view.unmount();
    await act(async () => finish({ restored: true, key: "websocket:restored-one", reused: false }));
  });

  it("file listing is separate from downloading and waits for confirmed download", async () => {
    show(); await open(); filesTab();
    fireEvent.click(await screen.findByRole("button", { name: "下载 方案.docx" }));
    await waitFor(() => expect(api.download).toHaveBeenCalledWith(rid, fileId));
    expect(await screen.findByText("1 KB · 已在本机")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下载 方案.docx" })).not.toBeInTheDocument();
  });

  it("download failure does not turn a cloud-only file into a local file", async () => {
    api.download.mockRejectedValue(new Error("云文件内容校验失败。"));
    show(); await open(); filesTab();
    fireEvent.click(await screen.findByRole("button", { name: "下载 方案.docx" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("云文件内容校验失败");
    expect(screen.getByText("1 KB · 仅在云端")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 方案.docx" })).toBeEnabled();
    expect(api.download).toHaveBeenCalledTimes(1);
  });

  it("loads earlier versions only on demand with the returned cursor", async () => {
    api.history.mockResolvedValueOnce({ ...page, has_more: true })
      .mockResolvedValueOnce({ items: [{ ...version, version: 2 }], has_more: false, next_before: 2 });
    show(); await open();
    fireEvent.click(screen.getByRole("button", { name: "更早版本" }));
    await screen.findByRole("button", { name: "恢复版本 2" });
    expect(api.history).toHaveBeenLastCalledWith(rid, 3, expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "恢复版本 3" })).toBeInTheDocument();
  });

  it("failed reads stay failures instead of empty history", async () => {
    api.history.mockRejectedValueOnce(new Error("历史版本暂不可用。"));
    show();
    await screen.findByRole("alert");
    expect(screen.queryByText("暂无历史版本")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await screen.findByRole("button", { name: "恢复版本 3" });
  });

  it("account unmount aborts reads and discards late private results", async () => {
    let finish!: (value: unknown) => void;
    api.history.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = show();
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
    const signal = api.history.mock.calls[0][2] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish(page));
    expect(screen.queryByText("课程方案")).not.toBeInTheDocument();
  });

  it.each([
    { name: "never uploaded", conversations: [] },
    { name: "unconfirmed version", conversations: [{ ...conversations[1], version: 0 }] },
    { name: "another conversation", conversations: [conversations[0]] },
  ])("shows an empty state for $name without reading another session", async ({ conversations: rows }) => {
    api.status.mockResolvedValue({ available: true, space: {}, conversations: rows });
    show();
    expect(await screen.findByText("此会话暂无云端历史。同步上传成功后可在这里查看。")).toBeInTheDocument();
    expect(api.history).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "移至云回收站" })).not.toBeInTheDocument();
  });

  it("shows account and status failures rather than an empty history, then retries", async () => {
    api.status.mockResolvedValueOnce({ available: false, problem: { message: "请登录 Mona 后接收云内容。" } });
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("请登录 Mona");
    expect(screen.queryByText(/此会话暂无云端历史/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await open();
  });

  it("points to the cloud recycle bin when this conversation was deleted in the cloud", async () => {
    api.status.mockResolvedValue({ available: true, space: {}, conversations: [{ ...conversations[1], trashed: true }] });
    show();
    expect(await screen.findByText(/云端副本已移至回收站，可前往/)).toHaveTextContent("云空间管理 → 回收站");
    expect(screen.queryByText(/此会话暂无云端历史/)).not.toBeInTheDocument();
    expect(api.history).not.toHaveBeenCalled();
  });

  it("moves only this conversation to cloud trash after explicit confirmation", async () => {
    const refreshed = vi.fn(); show(refreshed); await open();
    fireEvent.click(screen.getByRole("button", { name: "移至云回收站" }));
    expect(await screen.findByRole("button", { name: "确认移至云回收站" })).toBeEnabled();
    expect(api.previewTrash).toHaveBeenCalledWith(rid, 3, "trash");
    expect(api.applyTrash).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认移至云回收站" }));
    expect(await screen.findByText("云端副本已移至回收站，可前往“云空间管理 → 回收站”恢复。本地会话仍保留。")).toBeInTheDocument();
    expect(api.applyTrash).toHaveBeenCalledOnce();
    expect(refreshed).toHaveBeenCalledOnce();
  });
});
