import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ status: vi.fn(), prepare: vi.fn(), enable: vi.fn(), scope: vi.fn(), pause: vi.fn(), resume: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/cloud-sync", () => ({ cloudSyncApi: api }));
import { CloudSyncSettings } from "./CloudSyncSettings";

const candidates = [{ key: "websocket:work-1", title: "工作会话一" }, { key: "websocket:work-2", title: "工作会话二" }];
const inactive = { available: true, enabled: false, upload_enabled: false, sync_operations: false, sync_operations_credentials: false,
  phase: "idle", plan: "pro", space: null, candidates, selected_keys: [] };
const active = { ...inactive, enabled: true, upload_enabled: true, last_sync: 1791780000,
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
  api.resume.mockResolvedValue({ enabled: true });
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
    fireEvent.click(screen.getByRole("button", { name: "选择要上传的内容", exact: true }));
    expect(await screen.findByRole("button", { name: "确认开启并上传" })).toBeEnabled();
    expect(screen.queryByLabelText("请保存恢复密钥")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "我已将恢复密钥保存到安全位置" })).not.toBeInTheDocument();
    expect(api.enable).not.toHaveBeenCalled();
    api.status.mockResolvedValue(active);
    fireEvent.click(screen.getByRole("button", { name: "确认开启并上传" }));
    await waitFor(() => expect(api.enable).toHaveBeenCalledWith(draft.draft_id, candidates.map((c) => c.key), true, false, false, false, false, false));
    await screen.findByRole("button", { name: "暂停同步" });
    expect(screen.queryByLabelText("请保存恢复密钥")).not.toBeInTheDocument();
    expect(screen.getByLabelText("云空间使用量")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("2 GB / 10 GB")).toBeInTheDocument();
  });

  it("cancelling setup never enables synchronization", async () => {
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "开启同步" }));
    fireEvent.click(screen.getByRole("button", { name: "选择要上传的内容", exact: true }));
    await screen.findByRole("button", { name: "确认开启并上传" });
    fireEvent.click(screen.getByRole("button", { name: "取消", exact: true }));
    expect(api.enable).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("imports existing key without exposing a stored key in ordinary settings", async () => {
    api.status.mockResolvedValue({ ...active, enabled: false, needs_key: true });
    api.prepare.mockResolvedValue({ ...draft, new_space: false });
    render(<CloudSyncSettings />);
    fireEvent.click(within(await screen.findByRole("group", { name: "云同步操作" })).getByRole("button", { name: "迁移旧云空间" }));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "迁移旧云空间" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("旧云空间恢复密钥"), { target: { value: "synthetic-input-key" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "迁移旧云空间" }));
    await screen.findByRole("button", { name: "确认上传本机资料" });
    expect(api.prepare).toHaveBeenCalledWith("synthetic-input-key");
    expect(screen.queryByLabelText("请保存恢复密钥")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "我已将恢复密钥保存到安全位置" })).not.toBeInTheDocument();
  });

  it("scope changes do not delete files or pause all sync", async () => {
    api.status.mockResolvedValue(active);
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "上传范围" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "工作会话一" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "工作会话二" }));
    fireEvent.click(screen.getByRole("button", { name: "保存上传范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith(["websocket:work-2"], false, false, false, false, false, false));
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

  it("receives existing cloud content without granting upload permission on page load", async () => {
    api.status.mockResolvedValue({ ...active, upload_enabled: false });
    render(<CloudSyncSettings />);
    expect(await screen.findByText("已同步")).toBeInTheDocument();
    expect(screen.getByText("自动接收已开启；上传本机资料需单独确认。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传本机资料" })).toBeInTheDocument();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.enable).not.toHaveBeenCalled();
    expect(api.scope).not.toHaveBeenCalled();
  });

  it("keeps operations host upload optional and gates its credentials behind that choice", async () => {
    api.status.mockResolvedValue({ ...active, sync_operations: false, sync_operations_credentials: false });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "上传范围" }));
    const hosts = screen.getByRole("checkbox", { name: "运维主机配置" });
    const credentials = screen.getByRole("checkbox", { name: "包含密码和 SSH 私钥" });
    expect(hosts).not.toBeChecked();
    expect(credentials).not.toBeChecked();
    expect(credentials).toBeDisabled();
    fireEvent.click(hosts);
    expect(credentials).toBeEnabled();
    fireEvent.click(credentials);
    expect(api.scope).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存上传范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([candidates[0].key], false, false, false, false, true, true));
  });

  it("requires explicit confirmation before enabling local uploads for an existing space", async () => {
    api.status.mockResolvedValueOnce({ ...active, upload_enabled: false }).mockResolvedValueOnce(active);
    api.prepare.mockResolvedValue({ ...draft, new_space: false });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "上传本机资料" }));
    expect(api.prepare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "选择要上传的内容", exact: true }));
    await screen.findByRole("button", { name: "确认上传本机资料" });
    expect(api.enable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认上传本机资料" }));
    await waitFor(() => expect(api.enable).toHaveBeenCalledOnce());
    expect(api.scope).not.toHaveBeenCalled();
  });

  it("invalid success never dismisses scope confirmation", async () => {
    api.enable.mockResolvedValue({ enabled: false });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "开启同步" }));
    fireEvent.click(screen.getByRole("button", { name: "选择要上传的内容", exact: true }));
    await screen.findByRole("button", { name: "确认开启并上传" });
    fireEvent.click(screen.getByRole("button", { name: "确认开启并上传" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("尚未确认开启同步。");
    expect(screen.getByRole("button", { name: "确认开启并上传" })).toBeInTheDocument();
  });

  it("resumes an existing cloud space without asking again for upload authorization", async () => {
    const paused = { ...active, enabled: false, upload_enabled: false, selected_keys: [], sync_new_conversations: false };
    api.status.mockResolvedValueOnce(paused).mockResolvedValueOnce({ ...paused, enabled: true });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "恢复同步" }));
    await waitFor(() => expect(api.resume).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("已同步")).toBeInTheDocument();
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.enable).not.toHaveBeenCalled();
    expect(api.scope).not.toHaveBeenCalled();
  });

  it("allows explicitly switching new-conversation auto-sync without selecting old conversations", async () => {
    api.status.mockResolvedValue({ ...active, selected_keys: [] });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "上传范围" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "上传此后新建的工作会话" }));
    fireEvent.click(screen.getByRole("button", { name: "保存上传范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([], true, false, false, false, false, false));
  });

  it("planning stays opt-in and is saved independently of conversation selection", async () => {
    api.status.mockResolvedValue({ ...active, selected_keys: [] });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "上传范围" }));
    const option = screen.getByRole("checkbox", { name: "上传本机现有及后续的日程与待办" });
    expect(option).not.toBeChecked();
    fireEvent.click(option);
    expect(api.scope).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存上传范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([], false, true, false, false, false, false));
  });

  it("allows disabling planning without disabling Work synchronization", async () => {
    api.status.mockResolvedValue({ ...active, sync_planning: true });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "上传范围" }));
    const option = screen.getByRole("checkbox", { name: "上传本机现有及后续的日程与待办" });
    expect(option).toBeChecked();
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "保存上传范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([candidates[0].key], false, false, false, false, false, false));
    expect(api.pause).not.toHaveBeenCalled();
  });

  it("notes and their attachments require separate opt-in", async () => {
    api.status.mockResolvedValue({ ...active, selected_keys: [] });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "上传范围" }));
    const option = screen.getByRole("checkbox", { name: "上传本机笔记仓库及关联附件" });
    expect(option).not.toBeChecked();
    fireEvent.click(option);
    expect(api.scope).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存上传范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([], false, false, true, false, false, false));
  });

  it("desktop preferences require a separate explicit selection", async () => {
    api.status.mockResolvedValue({ ...active, selected_keys: [] });
    render(<CloudSyncSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "上传范围" }));
    const option = screen.getByRole("checkbox", { name: "上传本机侧栏布局、默认页面、发送按键和快捷问答显示模式" });
    expect(option).not.toBeChecked();
    fireEvent.click(option);
    expect(api.scope).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存上传范围" }));
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([], false, false, false, true, false, false));
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
    fireEvent.click(screen.getByRole("button", { name: "上传范围" }));
    expect(screen.getByRole("checkbox", { name: /工作会话一.*关联文件缺失/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "工作会话二" })).not.toBeChecked();
    expect(api.scope).not.toHaveBeenCalled();
  });

  it.each(["取消", "保存上传范围"])("handles pending conversations only after %s", async (action) => {
    const problemMessage = "1 个会话因关联文件缺失或过大暂未同步，其他内容会继续同步。";
    api.status.mockResolvedValue({ ...active, phase: "partial", selected_keys: candidates.map((item) => item.key),
      blocked_keys: [candidates[1].key], sync_new_conversations: true, sync_planning: true,
      sync_notes: true, sync_preferences: true, problem: { code: "associated_file_unavailable", message: problemMessage } });
    render(<CloudSyncSettings />);
    const pending = await screen.findByRole("button", { name: "查看待处理会话" });
    expect(pending).toHaveTextContent("1 个会话待处理");
    expect(screen.queryByText(problemMessage)).not.toBeInTheDocument();
    fireEvent.click(pending);
    const choices = screen.getAllByRole("checkbox", { name: /^工作会话/ });
    expect(choices[0]).toHaveAccessibleName(/工作会话二.*关联文件缺失/);
    expect(choices[0]).toBeChecked();
    expect(choices[1]).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "取消选择待处理会话" }));
    expect(choices[0]).not.toBeChecked();
    expect(choices[1]).toBeChecked();
    expect(api.scope).not.toHaveBeenCalled();
    if (action === "保存上传范围") {
      api.scope.mockImplementation(async () => {
        api.status.mockResolvedValue({ ...active, phase: "partial", blocked_keys: [],
          problem: { code: "associated_file_unavailable", message: problemMessage } });
        return { selected_keys: [candidates[0].key] };
      });
    }
    fireEvent.click(screen.getByRole("button", { name: action, exact: true }));
    if (action === "保存上传范围") {
    await waitFor(() => expect(api.scope).toHaveBeenCalledWith([candidates[0].key], true, true, true, true, false, false));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "查看待处理会话" })).not.toBeInTheDocument();
    } else {
      expect(api.scope).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "查看待处理会话" }));
      expect(screen.getByRole("checkbox", { name: /工作会话二.*关联文件缺失/ })).toBeChecked();
    }
  });

  it("continues showing errors that require an immediate response", async () => {
    const problem = { code: "cloud_quota_exceeded", message: "云空间不足，请清理空间后重试。" };
    api.status.mockResolvedValue({ ...active, upload_enabled: false, phase: "error", problem });
    render(<CloudSyncSettings />);
    expect(await screen.findByText("同步未完成")).toBeInTheDocument();
    expect(screen.getByText("自动接收已开启；上传本机资料需单独确认。")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(problem.message);
    expect(screen.queryByRole("button", { name: "查看待处理会话" })).not.toBeInTheDocument();
  });

  it("groups the actions together and explains them on hover", async () => {
    api.status.mockResolvedValue({ ...active, conversations: [{ key: candidates[0].key,
      resource_id: "a".repeat(32), version: 1, conflict_copy: false, trashed: false }] });
    render(<CloudSyncSettings />);
    const actions = within(await screen.findByRole("group", { name: "云同步操作" }));
    for (const name of ["立即同步", "上传范围", "回收站", "会话与历史", "空间管理"]) {
      expect(actions.getByRole("button", { name, exact: true })).toBeInTheDocument();
    }
    fireEvent.pointerMove(actions.getByRole("button", { name: "上传范围" }), { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip", { name: "选择要上传的本机资料；不影响接收云端已有内容" })).toBeInTheDocument();
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
