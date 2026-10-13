import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ trash: vi.fn(), previewTrash: vi.fn(), applyTrash: vi.fn() }));
vi.mock("@/lib/cloud-sync", () => ({ cloudSyncApi: api }));
import { CloudTrashDialog } from "./CloudTrashDialog";

const item = { resource_id: "a".repeat(32), kind: "note", version: 2, title: "课程笔记", deleted_at: "2026-10-13T00:00:00Z", recoverable: true };
const draft = { draft_id: "b".repeat(32), resource_id: item.resource_id, kind: "note", version: 2, action: "restore", expires_at: 2_000_000_000 };
const result = { complete: true, resource_id: item.resource_id, kind: "note", version: 3, action: "restore", reused: false, released_bytes: 0 };
beforeEach(() => {
  api.trash.mockReset().mockResolvedValue({ items: [item], next_before: 22, has_more: false });
  api.previewTrash.mockReset().mockImplementation(async (_id, version, action) => ({ ...draft, version, action }));
  api.applyTrash.mockReset().mockImplementation(async (value) => ({ ...result, action: value.action, version: value.version + (value.action === "purge" ? 0 : 1) }));
});
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "回收站", exact: true }));
  await screen.findByText(item.title);
}
async function select(action = "恢复") {
  fireEvent.click(screen.getByRole("button", { name: `${action} ${item.title}` }));
  await waitFor(() => expect(screen.getByRole("button", { name: `确认${action}` })).toBeEnabled());
}

it("loads only when opened and cancelling confirmation never changes data", async () => {
  render(<CloudTrashDialog onChanged={vi.fn()} />);
  expect(api.trash).not.toHaveBeenCalled();
  await open(); await select();
  expect(screen.getByRole("dialog")).toHaveTextContent("不自动执行历史任务");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(api.applyTrash).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: `恢复 ${item.title}` })).toBeInTheDocument();
});

it("restores only the confirmed record and refreshes the owning settings", async () => {
  const changed = vi.fn(); render(<CloudTrashDialog onChanged={changed} />);
  await open(); await select();
  fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
  await screen.findByText("已恢复到云空间，开启对应同步后可在原模块查看。");
  expect(api.applyTrash).toHaveBeenCalledOnce();
  expect(api.applyTrash.mock.calls[0][0]).toMatchObject(draft);
  expect(changed).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: `恢复 ${item.title}` })).not.toBeInTheDocument();
});

it("permanent removal clearly protects local copies and does not claim immediate space credit", async () => {
  render(<CloudTrashDialog onChanged={vi.fn()} />); await open(); await select("彻底删除");
  expect(screen.getByRole("dialog")).toHaveTextContent("不可撤销");
  expect(screen.getByRole("dialog")).toHaveTextContent("本地副本不删除");
  expect(api.applyTrash).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认彻底删除" }));
  await screen.findByText("已彻底移除云恢复记录。可清理上传残留以释放无引用文件占用。");
});

it("supports moving the selected Work cloud copy without another picker", async () => {
  const target = { resource_id: item.resource_id, version: 1, title: "方案会话" };
  render(<CloudTrashDialog target={target} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "移至云回收站", exact: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "确认移至云回收站" })).toBeEnabled());
  expect(api.trash).not.toHaveBeenCalled();
  expect(api.previewTrash).toHaveBeenCalledWith(target.resource_id, 1, "trash");
  expect(screen.getByRole("dialog")).toHaveTextContent("本地会话、文件和运行任务保持不变");
  fireEvent.click(screen.getByRole("button", { name: "确认移至云回收站" }));
  await screen.findByText("已移至云回收站，本地资料仍保留。");
});

it("retains the same confirmation for an explicit retry after an uncertain result", async () => {
  api.applyTrash.mockRejectedValueOnce(new Error("结果尚未确认"));
  render(<CloudTrashDialog onChanged={vi.fn()} />); await open(); await select();
  fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
  await screen.findByText("已恢复到云空间，开启对应同步后可在原模块查看。");
  expect(api.previewTrash).toHaveBeenCalledOnce();
  expect(api.applyTrash.mock.calls[0]).toEqual(api.applyTrash.mock.calls[1]);
});

it("expired or changed confirmation requires a new preview", async () => {
  api.applyTrash.mockRejectedValue(Object.assign(new Error("记录已变化"), { code: "cloud_trash_changed" }));
  render(<CloudTrashDialog onChanged={vi.fn()} />); await open(); await select();
  fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "确认恢复" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重新核对" }));
  await waitFor(() => expect(api.previewTrash).toHaveBeenCalledTimes(2));
});

it("pending changes cannot be double submitted or dismissed", async () => {
  let finish!: (value: unknown) => void;
  api.applyTrash.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const changed = vi.fn(); const view = render(<CloudTrashDialog onChanged={changed} />);
  await open(); await select();
  const confirm = screen.getByRole("button", { name: "确认恢复" });
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(api.applyTrash).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  view.unmount();
  await act(async () => finish(result));
  expect(changed).not.toHaveBeenCalled();
});

it("failed reads do not pretend the recycle bin is empty", async () => {
  api.trash.mockRejectedValue(new Error("网络不可用"));
  render(<CloudTrashDialog onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "回收站", exact: true }));
  expect(await screen.findByRole("alert")).toHaveTextContent("网络不可用");
  expect(screen.queryByText("回收站为空")).not.toBeInTheDocument();
});

it("unrecoverable records cannot trigger restore, and pages are read only on demand", async () => {
  api.trash.mockResolvedValue({ items: [{ ...item, recoverable: false }], next_before: 22, has_more: true });
  render(<CloudTrashDialog onChanged={vi.fn()} />); await open();
  expect(screen.getByRole("button", { name: `恢复 ${item.title}` })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "更早记录" }));
  await waitFor(() => expect(api.trash).toHaveBeenCalledWith(22, expect.any(AbortSignal)));
  expect(api.applyTrash).not.toHaveBeenCalled();
});
