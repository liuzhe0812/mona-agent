import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ status: vi.fn(), prepare: vi.fn(), enable: vi.fn(), scope: vi.fn(), pause: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/cloud-sync", () => ({ cloudSyncApi: api }));
import { CloudSyncSettings } from "./CloudSyncSettings";

const candidates = [{ key: "websocket:work-1", title: "工作会话一" }, { key: "websocket:work-2", title: "工作会话二" }];
const inactive = { available: true, enabled: false, phase: "idle", plan: "pro", space: null, candidates, selected_keys: [] };
const active = { ...inactive, enabled: true, last_sync: 1791780000,
  selected_keys: [candidates[0].key], space: { quota_bytes: 10_000_000_000, used_bytes: 2_000_000_000,
    reserved_bytes: 500_000_000, object_count: 3 } };
const draft = { draft_id: "a".repeat(32), new_space: true, candidates };

beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  api.status.mockResolvedValue(inactive);
  api.prepare.mockResolvedValue(draft);
  api.enable.mockResolvedValue({ enabled: true });
  api.scope.mockResolvedValue({ selected_keys: [] });
  api.pause.mockResolvedValue({ enabled: false });
  api.sync.mockResolvedValue({ scheduled: true });
});

describe("cloud sync settings", () => {
  it.each([
    ["cloud_not_configured", "云同步服务尚未配置完成。"],
    ["cloud_service_not_ready", "云同步服务尚未就绪，本地资料仍可正常使用。"],
  ])("shows %s without asking an authenticated user to log in again", async (code, message) => {
    api.status.mockResolvedValue({ ...inactive, available: false, problem: { code, message } });
    render(<CloudSyncSettings />);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/请登录并联网/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开启同步" })).not.toBeInTheDocument();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.enable).not.toHaveBeenCalled();
  });

  it("free account sees service upgrade but no local AI lock", async () => {
    api.status.mockResolvedValue({ ...inactive, plan: "free" });
    const upgrade = vi.fn();
    render(<CloudSyncSettings onUpgrade={upgrade} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 Pro" }));
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/解锁.*AI/)).not.toBeInTheDocument();
    expect(api.enable).not.toHaveBeenCalled();
  });

  it("enables only after scope confirmation without displaying a key", async () => {
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "开启同步" }));
    expect(api.prepare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "选择同步内容", exact: true }));
    expect(await screen.findByRole("button", { name: "确认开启" })).toBeEnabled();
    expect(screen.queryByLabelText("请保存恢复密钥")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "我已将恢复密钥保存到安全位置" })).not.toBeInTheDocument();
    expect(api.enable).not.toHaveBeenCalled();
    api.status.mockResolvedValue(active);
    fireEvent.click(screen.getByRole("button", { name: "确认开启" }));
    await waitFor(() => expect(api.enable).toHaveBeenCalledWith(draft.draft_id, candidates.map((c) => c.key), true, false, false, false));
    await screen.findByRole("button", { name: "暂停同步" });
    expect(screen.queryByLabelText("请保存恢复密钥")).not.toBeInTheDocument();
    expect(screen.getByLabelText("云空间使用量")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("2 GB / 10 GB")).toBeInTheDocument();
  });

  it("cancelling setup never enables synchronization", async () => {
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "开启同步" }));
    fireEvent.click(screen.getByRole("button", { name: "选择同步内容", exact: true }));
    await screen.findByRole("button", { name: "确认开启" });
    fireEvent.click(screen.getByRole("button", { name: "取消", exact: true }));
    expect(api.enable).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("imports existing key without exposing a stored key in ordinary settings", async () => {
    api.status.mockResolvedValue({ ...active, enabled: false, needs_key: true });
    api.prepare.mockResolvedValue({ ...draft, new_space: false });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "开启同步" }));
    expect(screen.getByRole("button", { name: "迁移旧云空间" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("旧云空间恢复密钥"), { target: { value: "synthetic-input-key" } });
    fireEvent.click(screen.getByRole("button", { name: "迁移旧云空间" }));
    await screen.findByRole("button", { name: "确认开启" });
    expect(api.prepare).toHaveBeenCalledWith("synthetic-input-key");
    expect(screen.queryByLabelText("请保存恢复密钥")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "我已将恢复密钥保存到安全位置" })).not.toBeInTheDocument();
  });

  it("scope changes do not delete files or pause all sync", async () => {
    api.status.mockResolvedValue(active);
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "同步范围" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "工作会话一" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "工作会话二" }));
    fireEvent.click(screen.getByRole("button", { name: "保存范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith(["websocket:work-2"], false, false, false, false));
    expect(api.pause).not.toHaveBeenCalled();
    expect(api.enable).not.toHaveBeenCalled();
  });

  it("a failed pause is not presented as completed", async () => {
    api.status.mockResolvedValue(active);
    api.pause.mockRejectedValue(new Error("暂停尚未确认，请重试。"));
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "暂停同步" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("暂停尚未确认，请重试。");
    fireEvent.click(screen.getByRole("button", { name: "关闭", exact: true }));
    expect(screen.getByRole("button", { name: "暂停同步" })).toBeInTheDocument();
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it("invalid success never dismisses scope confirmation", async () => {
    api.enable.mockResolvedValue({ enabled: false });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "开启同步" }));
    fireEvent.click(screen.getByRole("button", { name: "选择同步内容", exact: true }));
    await screen.findByRole("button", { name: "确认开启" });
    fireEvent.click(screen.getByRole("button", { name: "确认开启" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("尚未确认开启同步。");
    expect(screen.getByRole("button", { name: "确认开启" })).toBeInTheDocument();
  });

  it("preserves an intentionally empty selection when resuming sync", async () => {
    api.status.mockResolvedValue({ ...active, enabled: false, selected_keys: [], sync_new_conversations: false });
    api.prepare.mockResolvedValue({ ...draft, new_space: false, recovery: null });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "开启同步" }));
    fireEvent.click(screen.getByRole("button", { name: "选择同步内容", exact: true }));
    await screen.findByRole("button", { name: "确认开启" });
    expect(screen.getByRole("checkbox", { name: "工作会话一" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "自动同步此后新建的工作会话" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "确认开启" }));
    await waitFor(() => expect(api.enable).toHaveBeenCalledWith(draft.draft_id, [], false, false, false, false));
  });

  it("allows explicitly switching new-conversation auto-sync without selecting old conversations", async () => {
    api.status.mockResolvedValue({ ...active, selected_keys: [] });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "同步范围" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "自动同步此后新建的工作会话" }));
    fireEvent.click(screen.getByRole("button", { name: "保存范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([], true, false, false, false));
  });

  it("planning stays opt-in and is saved independently of conversation selection", async () => {
    api.status.mockResolvedValue({ ...active, selected_keys: [] });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "同步范围" }));
    const option = screen.getByRole("checkbox", { name: "同步现有及后续的日程与待办" });
    expect(option).not.toBeChecked();
    fireEvent.click(option);
    expect(api.scope).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([], false, true, false, false));
  });

  it("allows disabling planning without disabling Work synchronization", async () => {
    api.status.mockResolvedValue({ ...active, sync_planning: true });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "同步范围" }));
    const option = screen.getByRole("checkbox", { name: "同步现有及后续的日程与待办" });
    expect(option).toBeChecked();
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "保存范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([candidates[0].key], false, false, false, false));
    expect(api.pause).not.toHaveBeenCalled();
  });

  it("notes and their attachments require separate opt-in", async () => {
    api.status.mockResolvedValue({ ...active, selected_keys: [] });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "同步范围" }));
    const option = screen.getByRole("checkbox", { name: "同步本机笔记仓库及关联附件" });
    expect(option).not.toBeChecked();
    fireEvent.click(option);
    expect(api.scope).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([], false, false, true, false));
  });

  it("desktop preferences require a separate explicit selection", async () => {
    api.status.mockResolvedValue({ ...active, selected_keys: [] });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "同步范围" }));
    const option = screen.getByRole("checkbox", { name: "同步侧栏布局、默认页面、发送按键和快捷问答显示模式" });
    expect(option).not.toBeChecked();
    fireEvent.click(option);
    expect(api.scope).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([], false, false, false, true));
  });

  it("shows the real waiting state before the first completed sync", async () => {
    api.status.mockResolvedValue({ ...active, last_sync: null, phase: "waiting" });
    render(<CloudSyncSettings />);
    expect(await screen.findByText("等待当前任务结束")).toBeInTheDocument();
    expect(screen.queryByText("已同步", { exact: true })).not.toBeInTheDocument();
  });

  it("keeps trash visible and reveals cleanup only in space management", async () => {
    api.status.mockResolvedValue(active);
    render(<CloudSyncSettings />);
    expect(await screen.findByRole("button", { name: "回收站", exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清理过期历史", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清理上传残留", exact: true })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "空间管理", exact: true });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "清理过期历史", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清理上传残留", exact: true })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "清理上传残留", exact: true })).not.toBeInTheDocument();
  });

  it("identifies the affected conversation without clearing its selection", async () => {
    api.status.mockResolvedValue({ ...active, phase: "partial", blocked_keys: [candidates[0].key] });
    render(<CloudSyncSettings />);
    expect(await screen.findByText("部分内容待处理")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "同步范围" }));
    expect(screen.getByRole("checkbox", { name: /工作会话一.*关联文件缺失/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "工作会话二" })).not.toBeChecked();
    expect(api.scope).not.toHaveBeenCalled();
  });

  it("unmount aborts reads and does not bring back account information", async () => {
    let resolve!: (value: unknown) => void;
    api.status.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const rendered = render(<CloudSyncSettings />);
    const signal = api.status.mock.calls[0][0] as AbortSignal;
    rendered.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(active));
    expect(screen.queryByRole("region", { name: "云同步" })).not.toBeInTheDocument();
  });
});
