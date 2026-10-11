import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { DevSession, DevSnapshot } from "@/lib/development-api";

const api = vi.hoisted(() => ({
  send: vi.fn(), interrupt: vi.fn(), cancelInput: vi.fn(), decide: vi.fn(), permissions: vi.fn(),
}));
vi.mock("@/lib/development-api", async (original) => ({ ...await original<typeof import("@/lib/development-api")>(), developmentApi: api }));
vi.mock("./DevelopmentTranscript", () => ({ DevelopmentTranscript: () => null }));
vi.mock("./DevelopmentHeader", () => ({ DevelopmentHeader: ({ statusContent }: { statusContent: ReactNode }) => <header>{statusContent}</header> }));
vi.mock("./useDevelopmentSession", () => ({
  useDevelopmentSession: (id: string) => useDevelopmentStore((state) => state.snapshots[id]),
  refreshDevelopmentSession: vi.fn(),
}));
import { DevelopmentPane } from "./DevelopmentPane";
import { useDevelopmentStore } from "./store";

const project = { id: "project_permissions", displayName: "项目", rootPath: "D:/project", lastOpenedAt: "" };
const session: DevSession = {
  id: "dev_permissions", title: "权限测试", projectId: project.id, executor: "mona", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "", permissionMode: "ask",
};
const snapshot = (value = session): DevSnapshot => ({
  session: value, messages: [], messageCount: 0, before: null, runs: [], pendingInputs: [], events: [], eventCursor: 0, live: null,
});

function mount(value = snapshot()) {
  useDevelopmentStore.getState().setSnapshot(value.session.id, value);
  return render(<DevelopmentPane project={project} session={value.session} executors={[
    { id: value.session.executor, name: "开发模型", available: true, reason: "", models: [{ id: "", label: "默认模型" }] },
  ]} />);
}

async function chooseMode(label: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: /权限模式：/ }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  api.send.mockResolvedValue({ queued: false });
  api.interrupt.mockResolvedValue({});
  api.cancelInput.mockResolvedValue({});
  api.permissions.mockImplementation(async (current: DevSession, mode: DevSession["permissionMode"]) => ({
    ...current, permissionMode: mode, revision: current.revision + 1,
  }));
});
afterEach(cleanup);

it("updates the selected mode only after the server accepts it", async () => {
  mount();

  await chooseMode("自动审批");

  await waitFor(() => expect(api.permissions).toHaveBeenCalledWith(session, "auto", false));
  expect(await screen.findByRole("button", { name: "权限模式：自动审批" })).toBeInTheDocument();
});

it("requires confirmation for full access and keeps the existing mode when cancelled", async () => {
  mount();

  await chooseMode("完全访问");

  const dialog = await screen.findByRole("dialog", { name: "启用完全访问" });
  expect(api.permissions).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "权限模式：请求批准" })).toBeInTheDocument());
  expect(api.permissions).not.toHaveBeenCalled();
});

it("keeps the old mode and shows the existing failure dialog when saving fails", async () => {
  api.permissions.mockRejectedValueOnce(new Error("保存失败"));
  mount();

  await chooseMode("自动审批");

  expect(await screen.findByRole("heading", { name: "操作未完成" })).toBeInTheDocument();
  expect(screen.getByText("保存失败")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "知道了" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "权限模式：请求批准" })).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "权限模式：自动审批" })).toBeNull();
});
