import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevExecutor, DevProject, DevSession } from "@/lib/development-api";
import { DevelopmentReview } from "./DevelopmentReview";
import { diffLines } from "./DevelopmentDiff";
import { useDevelopmentStore } from "./store";

const api = vi.hoisted(() => ({ git: vi.fn(), reviewDiff: vi.fn(), delegate: vi.fn(), collaborationRequest: vi.fn() }));
const presetApi = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/development-api", async (original) => ({ ...(await original<typeof import("@/lib/development-api")>()), developmentApi: api }));
vi.mock("./workspace-api", () => ({ subagentApi: presetApi }));
const project: DevProject = { id: "project_review", displayName: "Review", rootPath: "D:/review", lastOpenedAt: "" };
const session: DevSession = { id: "dev_review", projectId: project.id, executor: "mona", title: "审查", model: null, readonly: false, parentSessionId: null, archived: false, pinned: false, revision: 0, updatedAt: "" };
const executors: DevExecutor[] = [{ id: "mona", name: "Mona Coding", available: true, reason: "", models: [] }];
const diff = "diff --git a/source.ts b/source.ts\n--- a/source.ts\n+++ b/source.ts\n@@ -1,2 +1,2 @@\n-before\n+after\n context\n";
const preset = { id: "reviewer", name: "审查员", executor: "mona" as const, instructions: "review", model: "review-model", provider: "team", effort: null, readonly: true, enabled: true };
const source = { path: "source.ts", version: "a".repeat(64) };
const show = () => render(<DevelopmentReview project={project} session={session} executors={executors} presets={[preset, { ...preset, id: "coder", readonly: false, name: "开发员" }]} onOpenAgent={vi.fn()} />);
async function chooseFile() { fireEvent.click(await screen.findByRole("button", { name: /source.ts/ })); await screen.findByLabelText("代码差异"); }
async function confirmReview() { fireEvent.click(screen.getByRole("button", { name: "只读审查", exact: true })); return screen.getByRole("dialog"); }
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  api.collaborationRequest.mockResolvedValue(null);
  api.git.mockResolvedValue({ available: true, branch: "main", files: [{ path: "source.ts", status: " M" }] });
  api.reviewDiff.mockResolvedValue({ diff, sha256: "sha-reviewed", attribution: "workspace", source });
  api.delegate.mockResolvedValue({ id: "collab", childSessionId: "child_review" });
  presetApi.run.mockResolvedValue({ id: "collab", childSessionId: "child_review" });
});
afterEach(cleanup);

describe("versioned diff review", () => {
  it("uses the parent engine availability for a preset that inherits its model", async () => {
    render(<DevelopmentReview project={project} session={{ ...session, executor: "codex" }}
      executors={[{ ...executors[0], available: false }, { id: "codex", name: "Codex", available: true, reason: "", models: [] }]}
      presets={[{ ...preset, id: "builtin_explorer", name: "explorer", inheritModel: true }]} onOpenAgent={vi.fn()} />);
    await chooseFile(); const dialog = await confirmReview();
    expect(within(dialog).getByRole("button", { name: "开始只读审查" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "开始只读审查" }));
    await waitFor(() => expect(presetApi.run).toHaveBeenCalledOnce());
    expect(presetApi.run.mock.calls[0][1]).toBe("builtin_explorer");
  });
  it("opens configuration when no read-only preset exists instead of creating a temporary task", async () => {
    const configure = vi.fn();
    render(<DevelopmentReview project={project} session={session} executors={executors} presets={[]} onOpenAgent={vi.fn()} onConfigure={configure} />);
    await chooseFile(); const dialog = await confirmReview();
    expect(within(dialog).getByText("尚未配置可用的只读子智能体。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "开始只读审查" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "配置子智能体" }));
    expect(configure).toHaveBeenCalledOnce();
    expect(api.delegate).not.toHaveBeenCalled(); expect(presetApi.run).not.toHaveBeenCalled();
  });
  it("shows a configuration read error and lets the user retry instead of claiming no preset exists", async () => {
    const retry = vi.fn();
    render(<DevelopmentReview project={project} session={session} executors={executors} presets={[]} presetsError="服务暂不可用" onRetryPresets={retry} onOpenAgent={vi.fn()} />);
    await chooseFile(); const dialog = await confirmReview();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("子智能体配置读取失败：服务暂不可用");
    expect(within(dialog).queryByText("尚未配置可用的只读子智能体。")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "重试读取配置" }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it("shows diff read failures in the diff area and offers a retry", async () => {
    api.reviewDiff.mockRejectedValueOnce(new Error("差异服务暂不可用"));
    show(); fireEvent.click(await screen.findByRole("button", { name: /source.ts/ }));
    await screen.findByRole("alert");
    expect(screen.getByText("差异读取失败：差异服务暂不可用")).toBeInTheDocument();
    expect(screen.queryByText(/此范围没有可展示的差异/)).not.toBeInTheDocument();
    api.reviewDiff.mockResolvedValueOnce({ diff, sha256: "sha-reviewed", source });
    fireEvent.click(screen.getByRole("button", { name: "重试读取差异" }));
    await screen.findByLabelText("代码差异");
    expect(api.reviewDiff).toHaveBeenCalledTimes(2);
  });
  it("shows exact line numbers and does not confuse headers with changed lines", () => {
    const rows = diffLines(diff);
    expect(rows.find((row) => row.text === "+++ b/source.ts")?.kind).toBe("header");
    expect(rows.find((row) => row.text === "-before")).toMatchObject({ kind: "remove", left: 1, right: null });
    expect(rows.find((row) => row.text === "+after")).toMatchObject({ kind: "add", left: null, right: 1 });
    expect(rows.find((row) => row.text === " context")).toMatchObject({ left: 2, right: 2 });
  });
  it("confirms the exact preview version and lets the server supply read-only evidence", async () => {
    show(); await chooseFile(); const dialog = await confirmReview();
    expect(api.delegate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "开始只读审查" }));
    await waitFor(() => expect(presetApi.run).toHaveBeenCalledOnce());
    const [id, presetId, requestId, goal, , readonly, reviewSource] = presetApi.run.mock.calls[0];
    expect(id).toBe(session.id); expect(presetId).toBe(preset.id);
    expect(requestId).toMatch(/^collab_/); expect(readonly).toBe(true);
    expect(reviewSource).toEqual(source); expect(goal).toBe("审查 source.ts");
    expect(reviewSource).not.toHaveProperty("diff");
    expect(api.delegate).not.toHaveBeenCalled();
    expect(api.reviewDiff).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("button", { name: "查看审查" })).toBeInTheDocument();
  });
  it("reviews a bounded multi-file scope with the same explicit confirmation", async () => {
    const combined = diff + diff.replaceAll("source.ts", "new.ts");
    const whole = { path: "", version: "b".repeat(64) };
    api.git.mockResolvedValue({ available: true, branch: "main", files: [{ path: "source.ts", status: " M" }, { path: "new.ts", status: "??" }] });
    api.reviewDiff.mockResolvedValue({ diff: combined, sha256: "scope", source: whole });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "全部变更" }));
    await screen.findByLabelText("代码差异");
    expect(api.reviewDiff).toHaveBeenCalledWith(project.id, "");
    const dialog = await confirmReview();
    expect(within(dialog).getByText("全部变更")).toBeInTheDocument();
    expect(presetApi.run).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "开始只读审查" }));
    await waitFor(() => expect(presetApi.run).toHaveBeenCalledOnce());
    expect(presetApi.run.mock.calls[0][6]).toEqual(whole);
    expect(api.delegate).not.toHaveBeenCalled();
  });

  it("refuses to dispatch a changed version rather than silently approving new code", async () => {
    show(); await chooseFile(); await confirmReview();
    api.reviewDiff.mockResolvedValueOnce({ diff: "+new version", sha256: "changed", source: { ...source, version: "b".repeat(64) } });
    fireEvent.click(screen.getByRole("button", { name: "开始只读审查" }));
    await screen.findByText(/代码已变化/);
    expect(api.delegate).not.toHaveBeenCalled(); expect(presetApi.run).not.toHaveBeenCalled();
  });
  it("reuses the same request identity after an uncertain dispatch", async () => {
    presetApi.run.mockRejectedValueOnce(new Error("连接中断，结果待核对"));
    show(); await chooseFile(); const dialog = await confirmReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "开始只读审查" }));
    await within(dialog).findByText("连接中断，结果待核对");
    expect(document.body.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const first = presetApi.run.mock.calls[0][2];
    fireEvent.click(within(dialog).getByRole("button", { name: "开始只读审查" }));
    await waitFor(() => expect(presetApi.run).toHaveBeenCalledTimes(2));
    expect(presetApi.run.mock.calls[1][2]).toBe(first);
    expect(api.delegate).not.toHaveBeenCalled();
  });
  it("retains the original request identity after an uncertain reply and tab remount", async () => {
    presetApi.run.mockRejectedValueOnce(new Error("连接中断，结果待核对"));
    const first = show(); await chooseFile(); const dialog = await confirmReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "开始只读审查" }));
    await within(dialog).findByText("连接中断，结果待核对");
    const original = presetApi.run.mock.calls[0][2];
    first.unmount(); show(); await chooseFile();
    const retry = await confirmReview();
    fireEvent.click(within(retry).getByRole("button", { name: "开始只读审查" }));
    await waitFor(() => expect(presetApi.run).toHaveBeenCalledTimes(2));
    expect(presetApi.run.mock.calls[1][2]).toBe(original);
    expect(api.delegate).not.toHaveBeenCalled();
  });
  it("uses the explicitly selected read-only preset and does not offer write-enabled presets", async () => {
    show(); await chooseFile(); const dialog = await confirmReview();
    const select = within(dialog).getByRole("combobox", { name: "审查子智能体" });
    expect(within(select).queryByRole("option", { name: /开发员/ })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: preset.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: "开始只读审查" }));
    await waitFor(() => expect(presetApi.run).toHaveBeenCalledOnce());
    expect(presetApi.run.mock.calls[0].slice(0, 2)).toEqual([session.id, preset.id]);
    expect(presetApi.run.mock.calls[0][6]).toEqual(source);
    expect(api.delegate).not.toHaveBeenCalled();
  });
  it("does not apply a previous project's late file list to the new review", async () => {
    let finish!: (value: unknown) => void;
    api.git.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = show();
    const next = { ...project, id: "project_next" };
    api.git.mockResolvedValue({ available: true, branch: "next", files: [{ path: "new.ts", status: " M" }] });
    view.rerender(<DevelopmentReview project={next} session={{ ...session, id: "dev_next", projectId: next.id }} executors={executors} presets={[]} onOpenAgent={vi.fn()} />);
    await screen.findByRole("button", { name: /new.ts/ });
    await act(async () => { finish({ available: true, branch: "old", files: [{ path: "old.ts", status: " M" }] }); });
    expect(screen.queryByRole("button", { name: /old.ts/ })).not.toBeInTheDocument();
    expect(api.delegate).not.toHaveBeenCalled();
  });
  it("does not truncate oversized evidence and pretend it was all reviewed", async () => {
    api.reviewDiff.mockResolvedValue({ diff: "large".repeat(4000), sha256: "large", source });
    show(); await chooseFile(); const dialog = await confirmReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "开始只读审查" }));
    await within(dialog).findByText(/超出单次审查范围/);
    expect(api.delegate).not.toHaveBeenCalled();
  });
});
