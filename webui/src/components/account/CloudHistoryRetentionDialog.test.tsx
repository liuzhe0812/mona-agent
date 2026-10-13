import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ retentionPreview: vi.fn(), retireHistory: vi.fn() }));
vi.mock("@/lib/cloud-sync", () => ({ cloudSyncApi: api }));
import { CloudHistoryRetentionDialog } from "./CloudHistoryRetentionDialog";

const draft = { draft_id: "a".repeat(32), count: 2, retention_days: 30, has_more: false, expires_at: 9999999999 };
const result = { complete: true, retired: 2, already_retired: 0, retained: 0, released_bytes: 0 };
beforeEach(() => { api.retentionPreview.mockReset(); api.retireHistory.mockReset(); api.retentionPreview.mockResolvedValue(draft); api.retireHistory.mockResolvedValue(result); });
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "清理过期历史" }));
  await screen.findByText("本批将清理 2 个旧版本。");
}

it("only previews on opening and cancellation does not mutate data", async () => {
  render(<CloudHistoryRetentionDialog onChanged={vi.fn()} />);
  expect(api.retentionPreview).not.toHaveBeenCalled();
  await open();
  expect(api.retireHistory).not.toHaveBeenCalled();
  expect(screen.getByText(/最新版本不受时间限制/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(api.retireHistory).not.toHaveBeenCalled();
});

it("clears only the confirmed history and does not pretend quota was released", async () => {
  const changed = vi.fn();
  render(<CloudHistoryRetentionDialog onChanged={changed} />);
  await open();
  expect(screen.getByText(/文件实际删除后才释放空间/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认清理旧版本" }));
  await screen.findByText(/已清理 2 个旧版本/);
  expect(api.retireHistory).toHaveBeenCalledWith(draft.draft_id);
  expect(changed).toHaveBeenCalledOnce();
});

it("unknown result retains the confirmation without an automatic retry", async () => {
  api.retireHistory.mockRejectedValueOnce(new Error("结果尚未确认"));
  render(<CloudHistoryRetentionDialog onChanged={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "确认清理旧版本" }));
  await screen.findByRole("alert");
  expect(api.retireHistory).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "确认清理旧版本" }));
  await waitFor(() => expect(api.retireHistory).toHaveBeenCalledTimes(2));
  expect(api.retireHistory.mock.calls[0]).toEqual(api.retireHistory.mock.calls[1]);
});

it("rejects dismiss and duplicate submission while awaiting confirmation", async () => {
  let finish!: (value: unknown) => void;
  api.retireHistory.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<CloudHistoryRetentionDialog onChanged={vi.fn()} />);
  await open();
  const button = screen.getByRole("button", { name: "确认清理旧版本" });
  fireEvent.click(button); fireEvent.click(button);
  expect(api.retireHistory).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  await act(async () => finish(result));
});

it("no eligible histories means no delete button", async () => {
  api.retentionPreview.mockResolvedValue({ ...draft, draft_id: null, count: 0 });
  render(<CloudHistoryRetentionDialog onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "清理过期历史" }));
  await screen.findByText("暂无可清理的过期历史。");
  expect(screen.queryByRole("button", { name: "确认清理旧版本" })).not.toBeInTheDocument();
});

it("account changes require a fresh preview", async () => {
  api.retireHistory.mockRejectedValue(Object.assign(new Error("账号已变化"), { code: "account_changed" }));
  render(<CloudHistoryRetentionDialog onChanged={vi.fn()} />);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "确认清理旧版本" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "确认清理旧版本" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
});
