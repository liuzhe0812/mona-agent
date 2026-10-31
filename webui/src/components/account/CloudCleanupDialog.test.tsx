import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ cleanupPreview: vi.fn(), cleanup: vi.fn(), retentionPreview: vi.fn(), retireHistory: vi.fn() }));
vi.mock("@/lib/cloud-sync", () => ({ cloudSyncApi: api }));
import { CloudCleanupDialog } from "./CloudCleanupDialog";

const draft = { draft_id: "a".repeat(32), count: 2, bytes: 2_000_000, has_more: false,
  expires_at: 2_000_000_000, minimum_age_seconds: 86400 };
const complete = { complete: true, removed: 2, already_removed: 0, retained: 0,
  failed: 0, pending: 0, released_bytes: 2_000_000 };
const history = { draft_id: "b".repeat(32), count: 3, retention_days: 30, has_more: false, expires_at: 2_000_000_000 };
const retired = { complete: true, retired: 3, already_retired: 0, retained: 0, released_bytes: 0 };
beforeEach(() => {
  api.cleanupPreview.mockReset().mockResolvedValue(draft);
  api.cleanup.mockReset().mockResolvedValue(complete);
  api.retentionPreview.mockReset().mockResolvedValue(history);
  api.retireHistory.mockReset().mockResolvedValue(retired);
});
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "清理空间", exact: true }));
  await screen.findByRole("button", { name: "确认清理" });
}

it("only previews on demand and cancel never deletes", async () => {
  render(<CloudCleanupDialog onCleaned={vi.fn()} />);
  expect(api.cleanupPreview).not.toHaveBeenCalled();
  await open();
  expect(screen.getByRole("dialog")).toHaveTextContent("保留最新内容、回收站及本机资料");
  expect(screen.getByRole("dialog")).toHaveTextContent("保留最近 30 天的历史");
  expect(screen.getByRole("dialog")).toHaveTextContent("3 个过期旧版本，预计最多释放 2 MB");
  expect(api.cleanup).not.toHaveBeenCalled();
  expect(api.retireHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(api.cleanup).not.toHaveBeenCalled();
  expect(api.retireHistory).not.toHaveBeenCalled();
});

it("cleans only the confirmed preview and refreshes the owning quota view", async () => {
  const refresh = vi.fn();
  render(<CloudCleanupDialog onCleaned={refresh} />);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  await screen.findByText("已清理 3 个旧版本，已释放 2 MB。");
  expect(api.retireHistory).toHaveBeenCalledOnce();
  expect(api.retireHistory).toHaveBeenCalledWith(history.draft_id);
  expect(api.cleanup).toHaveBeenCalledOnce();
  expect(api.cleanup).toHaveBeenCalledWith(draft.draft_id);
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "确认清理" })).not.toBeInTheDocument();
});

it("retains the same confirmation when the result is unknown", async () => {
  api.cleanup.mockRejectedValueOnce(new Error("清理结果尚未确认，请重试核对。"));
  render(<CloudCleanupDialog onCleaned={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("status")).toHaveTextContent("已清理 3 个旧版本；空间清理结果尚未确认。");
  fireEvent.click(screen.getByRole("button", { name: "重试清理" }));
  await screen.findByText("已清理 3 个旧版本，已释放 2 MB。");
  expect(api.retireHistory.mock.calls).toEqual([[history.draft_id]]);
  expect(api.cleanup.mock.calls).toEqual([[draft.draft_id], [draft.draft_id]]);
  expect(api.cleanupPreview).toHaveBeenCalledOnce();
});

it("shows partial completion without silently continuing to more objects", async () => {
  api.cleanup.mockResolvedValue({ ...complete, complete: false, removed: 1, failed: 1, released_bytes: 1_000_000 });
  render(<CloudCleanupDialog onCleaned={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  await screen.findByText(/清理尚未全部完成/);
  expect(screen.getByRole("button", { name: "重试清理" })).toBeEnabled();
  expect(api.cleanup).toHaveBeenCalledOnce();
});

it("requires a fresh preview when authorization changes or confirmation expires", async () => {
  api.cleanup.mockRejectedValue(Object.assign(new Error("清理确认已失效"), { code: "cleanup_preview_expired" }));
  render(<CloudCleanupDialog onCleaned={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "重试清理" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
  await waitFor(() => expect(api.cleanupPreview).toHaveBeenCalledTimes(2));
  expect(api.cleanup).toHaveBeenCalledOnce();
});

it("never offers a delete when no orphan files are eligible", async () => {
  api.cleanupPreview.mockResolvedValue({ ...draft, draft_id: null, count: 0, bytes: 0 });
  api.retentionPreview.mockResolvedValue({ ...history, draft_id: null, count: 0 });
  render(<CloudCleanupDialog onCleaned={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "清理空间", exact: true }));
  await screen.findByText("暂无可清理内容。");
  expect(screen.queryByRole("button", { name: "确认清理" })).not.toBeInTheDocument();
  expect(api.cleanup).not.toHaveBeenCalled();
  expect(api.retireHistory).not.toHaveBeenCalled();
});

it("prevents double submission and dismissal while a confirmed cleanup is pending", async () => {
  let finish!: (value: unknown) => void;
  api.cleanup.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<CloudCleanupDialog onCleaned={vi.fn()} />);
  await open();
  const button = screen.getByRole("button", { name: "确认清理" });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(api.cleanup).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
  view.unmount();
  await act(async () => finish(complete));
});

it("retries an unknown history result with the same confirmation before cleaning files", async () => {
  api.retireHistory.mockRejectedValueOnce(new Error("清理结果尚未确认"));
  render(<CloudCleanupDialog onCleaned={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  await screen.findByRole("alert");
  expect(api.cleanup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重试清理" }));
  await screen.findByText("已清理 3 个旧版本，已释放 2 MB。");
  expect(api.retireHistory.mock.calls).toEqual([[history.draft_id], [history.draft_id]]);
  expect(api.retentionPreview).toHaveBeenCalledOnce();
  expect(api.cleanupPreview).toHaveBeenCalledOnce();
  expect(api.cleanup).toHaveBeenCalledWith(draft.draft_id);
});

it("does not claim history retirement alone released storage", async () => {
  api.cleanupPreview.mockResolvedValue({ ...draft, draft_id: null, count: 0, bytes: 0 });
  render(<CloudCleanupDialog onCleaned={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  await screen.findByText("已清理 3 个旧版本，已释放 0 KB。");
  expect(api.cleanup).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "确认清理" })).not.toBeInTheDocument();
});

it("does not allow confirmation when one preview failed", async () => {
  api.retentionPreview.mockRejectedValue(new Error("历史检查失败，请重试。"));
  render(<CloudCleanupDialog onCleaned={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "清理空间", exact: true }));
  expect(await screen.findByRole("alert")).toHaveTextContent("历史检查失败");
  expect(screen.queryByRole("button", { name: "确认清理" })).not.toBeInTheDocument();
  expect(api.cleanup).not.toHaveBeenCalled();
  expect(api.retireHistory).not.toHaveBeenCalled();
});
