import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ history: vi.fn(), files: vi.fn(), download: vi.fn(), restore: vi.fn() }));
vi.mock("@/lib/cloud-sync", () => ({ cloudSyncApi: api }));
import { CloudHistoryDialog } from "./CloudHistoryDialog";

const rid = "a".repeat(32);
const fileId = "b".repeat(64);
const conversations = [{ key: "websocket:one", resource_id: rid, version: 3, conflict_copy: false }];
const candidates = [{ key: "websocket:one", title: "课程方案" }];
const version = { version: 3, created_at: "2026-10-12T08:00:00Z", deleted: false };
const page = { items: [version], has_more: false, next_before: 3 };
const file = { id: fileId, name: "方案.docx", size: 1024, local: false };

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.history.mockResolvedValue(page);
  api.files.mockResolvedValue([file]);
  api.download.mockResolvedValue(undefined);
  api.restore.mockResolvedValue({ restored: true, key: "websocket:restored-one", reused: false });
});
function show(onRestored = vi.fn()) {
  return render(<CloudHistoryDialog conversations={conversations} candidates={candidates} onRestored={onRestored} />);
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "会话与历史" }));
  await screen.findByRole("button", { name: "恢复版本 3" });
}
function filesTab() { fireEvent.mouseDown(screen.getByRole("tab", { name: "关联文件" }), { button: 0, ctrlKey: false }); }

describe("cloud history and on-demand files", () => {
  it("does not fetch histories or file bytes until the dialog is opened", async () => {
    show();
    expect(api.history).not.toHaveBeenCalled();
    expect(api.files).not.toHaveBeenCalled();
    await open();
    expect(screen.getByRole("button", { name: "选择云会话" })).toHaveTextContent("课程方案");
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
    show(); fireEvent.click(screen.getByRole("button", { name: "会话与历史" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("暂无历史版本")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await screen.findByRole("button", { name: "恢复版本 3" });
  });

  it("account unmount aborts reads and discards late private results", async () => {
    let finish!: (value: unknown) => void;
    api.history.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = show();
    fireEvent.click(screen.getByRole("button", { name: "会话与历史" }));
    await waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
    const signal = api.history.mock.calls[0][2] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish(page));
    expect(screen.queryByText("课程方案")).not.toBeInTheDocument();
  });
});
