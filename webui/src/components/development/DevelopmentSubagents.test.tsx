import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevelopmentApiError, type DevExecutor } from "@/lib/development-api";
import { DevelopmentSubagents } from "./DevelopmentSubagents";
import { useDevelopmentStore } from "./store";
import type { SubagentPreset } from "./workspace-api";

const api = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), run: vi.fn() }));
vi.mock("./workspace-api", () => ({ subagentApi: api }));

const preset: SubagentPreset = { id: "preset_a", name: "我的审查员", description: "审查代码改动", instructions: "只读审查", executor: "mona", model: null, provider: null, effort: null, readonly: true, enabled: true };
const other: SubagentPreset = { ...preset, id: "preset_b", name: "另一位助手", description: "查找实现", instructions: "读取项目文件" };
const explorer: SubagentPreset = { ...preset, id: "builtin_explorer", name: "explorer", inheritModel: true };
const worker: SubagentPreset = { ...explorer, id: "builtin_worker", name: "worker", readonly: false };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  api.list.mockResolvedValue({ revision: 1, presets: [preset] });
  api.save.mockImplementation(async (_project, value) => ({ ...value, revision: 2 }));
});
afterEach(cleanup);
const props = { projectId: "project_a", executors: [], onChanged: vi.fn() };

it("shows only configured model names beside agents and updates inherited models", async () => {
  const fixed = { ...worker, inheritModel: false, executor: "claude" as const, model: "claude-sonnet" };
  const legacy = { ...preset, model: "review-preset" };
  api.list.mockResolvedValueOnce({ revision: 1, presets: [explorer, fixed, legacy] });
  const executors: DevExecutor[] = [
    { id: "codex", name: "Codex", available: true, reason: "", probe: { state: "ready", reason: "", defaultModel: "gpt-6-luna" }, models: [
      { id: "", label: "执行者默认模型" }, { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }, { id: "gpt-6-luna", label: "GPT-6-Luna" }] },
    { id: "claude", name: "Claude Code", available: true, reason: "", models: [{ id: "claude-sonnet", label: "Claude Sonnet" }] },
    { id: "mona", name: "Mona Coding", available: true, reason: "", models: [{ id: "review-preset", label: "审查 · deepseek-v4-pro", model: "deepseek-v4-pro", preset: true }] },
  ];
  const view = render(<DevelopmentSubagents {...props} executors={executors} session={{ executor: "codex", model: "gpt-6.1-sol" }} />);
  expect(await screen.findByRole("button", { name: "explorer" })).toHaveTextContent("GPT-6.1-Sol");
  expect(screen.getByRole("button", { name: "worker" })).toHaveTextContent("Claude Sonnet");
  expect(screen.getByRole("button", { name: preset.name })).toHaveTextContent("deepseek-v4-pro");
  expect(screen.queryByText("审查 · deepseek-v4-pro")).not.toBeInTheDocument();
  view.rerender(<DevelopmentSubagents {...props} executors={executors} session={{ executor: "codex", model: "gpt-6-luna" }} />);
  expect(screen.getByRole("button", { name: "explorer" })).toHaveTextContent("GPT-6-Luna");
  expect(screen.getByRole("button", { name: "worker" })).toHaveTextContent("Claude Sonnet");
  view.rerender(<DevelopmentSubagents {...props} executors={executors} session={{ executor: "codex", model: null }} />);
  expect(screen.getByRole("button", { name: "explorer" })).toHaveTextContent("GPT-6-Luna");
  expect(api.save).not.toHaveBeenCalled();
  expect(api.run).not.toHaveBeenCalled();
});

it("shows protected builtins with direct enable switches and preserves custom management", async () => {
  api.list.mockResolvedValueOnce({ revision: 1, presets: [explorer, worker, preset] });
  render(<DevelopmentSubagents {...props} />);
  const toggle = await screen.findByRole("switch", { name: "explorer 启用" });
  expect(toggle).toBeChecked();
  expect(screen.getByRole("switch", { name: "worker 启用" })).toBeChecked();
  expect(screen.queryByRole("button", { name: "删除 explorer" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "删除 worker" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "编辑 worker" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "删除 我的审查员" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "添加子智能体" })).toBeEnabled();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(api.save.mock.calls[0][1]).toEqual({ revision: 1, presets: [{ ...explorer, enabled: false }, worker, preset] });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(api.save.mock.calls[1][1]).toEqual({ revision: 2, presets: [explorer, worker, preset] });
  expect(api.run).not.toHaveBeenCalled();
});

it("toggles custom entries directly without changing their configuration or dispatching tasks", async () => {
  api.list.mockResolvedValueOnce({ revision: 1, presets: [explorer, worker, preset, other] });
  render(<DevelopmentSubagents {...props} />);
  const toggle = await screen.findByRole("switch", { name: "我的审查员 启用" });
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(api.save.mock.calls[0][1]).toEqual({ revision: 1, presets: [explorer, worker, { ...preset, enabled: false }, other] });
  expect(screen.getByRole("button", { name: "编辑 我的审查员" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "删除 我的审查员" })).toBeEnabled();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(api.save.mock.calls[1][1]).toEqual({ revision: 2, presets: [explorer, worker, preset, other] });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(api.run).not.toHaveBeenCalled();
});

it("locks builtin names and allows an explicit engine and model instead of inheritance", async () => {
  api.list.mockResolvedValueOnce({ revision: 1, presets: [explorer, worker, preset] });
  const executors: DevExecutor[] = [{ id: "codex", name: "Codex", available: true, reason: "", models: [{ id: "native-code", label: "Native Coding" }] }];
  render(<DevelopmentSubagents {...props} executors={executors} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 worker" }));
  expect(screen.getByRole("textbox", { name: "子智能体名称" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "子智能体名称" })).toHaveValue("worker");
  expect(screen.getByRole("textbox", { name: "子智能体描述" })).toHaveAttribute("readonly");
  expect(screen.getByRole("textbox", { name: "子智能体执行指令" })).toHaveAttribute("readonly");
  expect(screen.getByRole("checkbox", { name: "跟随主任务模型" })).toBeChecked();
  expect(screen.getByRole("button", { name: "跟随主任务模型" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "跟随主任务模型" }));
  const selector = screen.getByRole("button", { name: "Mona Coding 默认模型" });
  fireEvent.pointerDown(selector, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: /Native Coding/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存子智能体" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1].presets[1]).toMatchObject({ name: "worker", executor: "codex", model: "native-code", provider: null, inheritModel: false });
  expect(api.save.mock.calls[0][1].presets[2]).toEqual(preset);
  expect(api.run).not.toHaveBeenCalled();
});

it("restores builtin prompt text from the current settings instead of an old editable draft", async () => {
  api.list.mockResolvedValueOnce({ revision: 1, presets: [explorer, worker, preset] });
  useDevelopmentStore.getState().setSubagentDraft("project_a", { ...worker, description: "旧描述草稿", instructions: "旧指令草稿" });
  render(<DevelopmentSubagents {...props} />);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "子智能体描述" })).toHaveValue(worker.description));
  expect(screen.getByRole("textbox", { name: "子智能体执行指令" })).toHaveValue(worker.instructions);
  fireEvent.click(screen.getByRole("switch", { name: "编辑器内启用" }));
  fireEvent.click(screen.getByRole("button", { name: "保存子智能体" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1].presets).toEqual([explorer, { ...worker, enabled: false }, preset]);
});

it("deletes custom entries while retaining both builtins", async () => {
  api.list.mockResolvedValueOnce({ revision: 1, presets: [explorer, worker, preset] });
  render(<DevelopmentSubagents {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "删除 我的审查员" }));
  fireEvent.click(screen.getByRole("button", { name: "删除配置" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1]).toEqual({ revision: 1, presets: [explorer, worker] });
  expect(api.run).not.toHaveBeenCalled();
});

it("keeps an unsaved subagent draft through tab unmount and does not save or dispatch implicitly", async () => {
  const view = render(<DevelopmentSubagents {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 我的审查员" }));
  fireEvent.change(screen.getByRole("textbox", { name: "子智能体描述" }), { target: { value: "待确认的审查范围" } });
  view.unmount();
  render(<DevelopmentSubagents {...props} />);
  expect(await screen.findByRole("textbox", { name: "子智能体描述" })).toHaveValue("待确认的审查范围");
  expect(api.save).not.toHaveBeenCalled(); expect(api.run).not.toHaveBeenCalled();
  const saved = JSON.parse(localStorage.getItem("mona.development.workbench.v1")!).state;
  expect(saved.subagentDrafts.project_a.description).toBe("待确认的审查范围");
});

it("creates an entry with description routing and keeps its execution instruction optional", async () => {
  api.list.mockResolvedValueOnce({ revision: 1, presets: [preset, other] });
  render(<DevelopmentSubagents {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "添加子智能体" }));
  expect(screen.getByText("我的审查员")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: "子智能体名称" }), { target: { value: "测试助手" } });
  fireEvent.change(screen.getByRole("textbox", { name: "子智能体描述" }), { target: { value: "定位相关代码" } });
  fireEvent.click(screen.getByRole("button", { name: "保存子智能体" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  const request = api.save.mock.calls[0][1];
  expect(request.presets.map((entry: SubagentPreset) => entry.id)).toEqual(["preset_a", "preset_b", expect.stringMatching(/^subagent_/) ]);
  expect(request.presets[2]).toMatchObject({ name: "测试助手", description: "定位相关代码", instructions: "定位相关代码", executor: "mona" });
  expect(api.run).not.toHaveBeenCalled();
});

it("clears a cancelled draft on close and Escape so the next create starts fresh", async () => {
  render(<DevelopmentSubagents {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "添加子智能体" }));
  fireEvent.change(screen.getByRole("textbox", { name: "子智能体名称" }), { target: { value: "未保存的配置" } });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(useDevelopmentStore.getState().subagentDrafts.project_a).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "添加子智能体" }));
  expect(screen.getByRole("textbox", { name: "子智能体名称" })).toHaveValue("");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(useDevelopmentStore.getState().subagentDrafts.project_a).toBeUndefined());
  expect(api.save).not.toHaveBeenCalled(); expect(api.run).not.toHaveBeenCalled();
});

it("edits in place, roundtrips description, and retains a draft through a revision conflict", async () => {
  api.list.mockResolvedValueOnce({ revision: 1, presets: [preset, other] });
  api.save.mockRejectedValueOnce(new DevelopmentApiError(409, "conflict", "记录已变化，请刷新后重试。"));
  render(<DevelopmentSubagents {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 我的审查员" }));
  expect(screen.getByRole("textbox", { name: "子智能体描述" })).not.toHaveAttribute("readonly");
  expect(screen.getByRole("textbox", { name: "子智能体执行指令" })).not.toHaveAttribute("readonly");
  fireEvent.change(screen.getByRole("textbox", { name: "子智能体描述" }), { target: { value: "检查安全问题" } });
  fireEvent.click(screen.getByRole("button", { name: "保存子智能体" }));
  api.list.mockResolvedValueOnce({ revision: 2, presets: [preset, other] });
  fireEvent.click(await screen.findByRole("button", { name: "重新读取并保留草稿" }));
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText("加载中")).not.toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText("记录已变化，请刷新后重试。")).not.toBeInTheDocument());
  expect(screen.getByRole("textbox", { name: "子智能体描述" })).toHaveValue("检查安全问题");
  fireEvent.click(screen.getByRole("button", { name: "保存子智能体" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
  const request = api.save.mock.calls[1][1];
  expect(request.revision).toBe(2);
  expect(request.presets).toEqual([{ ...preset, description: "检查安全问题" }, other]);
  expect(api.run).not.toHaveBeenCalled();
});

it("persists enable changes without reordering entries or dispatching them", async () => {
  api.list.mockResolvedValueOnce({ revision: 1, presets: [preset, other] });
  render(<DevelopmentSubagents {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 我的审查员" }));
  fireEvent.click(screen.getByRole("switch", { name: "编辑器内启用" }));
  fireEvent.click(screen.getByRole("button", { name: "保存子智能体" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce());
  expect(api.save.mock.calls[0][1]).toEqual({ revision: 1, presets: [{ ...preset, enabled: false }, other] });
  expect(api.run).not.toHaveBeenCalled();
});

it("never applies one project's settings draft to another project", async () => {
  useDevelopmentStore.getState().setSubagentDraft("project_a", { ...preset, instructions: "仅项目 A" });
  render(<DevelopmentSubagents {...props} projectId="project_b" />);
  await screen.findByRole("button", { name: "编辑 我的审查员" });
  expect(screen.queryByRole("textbox", { name: "子智能体描述" })).not.toBeInTheDocument();
  expect(useDevelopmentStore.getState().subagentDrafts.project_a.instructions).toBe("仅项目 A");
});
