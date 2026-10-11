import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "./ModelSelector";
import { ProviderMark } from "./ProviderMark";
import { modelKey, sourceId, useModelPreferences, type ModelOption } from "./model-sources";
import { developmentModels, developmentModelRoute } from "@/components/development/development-models";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const models: ModelOption[] = [
  { provider: "mona_managed", providerLabel: "Mona AI", model: "self-test", label: "自供示例", active: true, isBuiltin: true },
  { provider: "openai", providerLabel: "OpenAI", model: "same-model", label: "Same Model", active: false },
  { provider: "custom-relay", providerLabel: "我的转发服务", model: "same-model", label: "Same Model", active: false },
  { provider: "native:codex", providerLabel: "OpenAI", model: "native-test", label: "原生示例", executor: "codex", active: false },
];
beforeEach(() => { useModelPreferences.setState({ hiddenNative: [], providerOrder: [] }); });
afterEach(cleanup);
async function open(onSelect = vi.fn()) {
  render(<ModelSelector options={models} label="选择模型" onSelect={onSelect} onManage={vi.fn()} />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "选择模型" }), { button: 0, ctrlKey: false });
  await screen.findByRole("textbox", { name: "搜索模型" });
  return onSelect;
}
describe("source-first unified model selector", () => {
  it("changes only advertised effort stops in the model flyout and keeps it open", async () => {
    const select = vi.fn();
    const option = { ...models[1], reasoningEfforts: ["low", "high", "xhigh"], reasoningEffort: "high", defaultReasoningEffort: "high" };
    render(<ModelSelector options={[option]} label="选择模型" onSelect={select} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "选择模型" }), { button: 0, ctrlKey: false });
    fireEvent.pointerMove(await screen.findByRole("menuitem", { name: "OpenAI · Same Model" }), { pointerType: "mouse" });
    const slider = await screen.findByRole("slider", { name: "思考强度" });
    expect(slider).toHaveAttribute("aria-valuemax", "2");
    fireEvent.keyDown(slider, { key: "End" });
    expect(select).toHaveBeenLastCalledWith(option, "xhigh");
    await waitFor(() => expect(slider).toHaveAttribute("aria-disabled", "false"));
    expect(slider).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "恢复推荐" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "搜索模型" })).toBeInTheDocument();
  });
  it("keeps model details mounted while the model list scrolls under the pointer", async () => {
    const select = vi.fn();
    const option = { ...models[1], reasoningEfforts: ["low", "high", "xhigh"], reasoningEffort: "high", defaultReasoningEffort: "high" };
    render(<ModelSelector options={[option]} label="选择模型" onSelect={select} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "选择模型" }), { button: 0, ctrlKey: false });
    const row = await screen.findByRole("menuitem", { name: "OpenAI · Same Model" });
    const sourceGroup = row.closest('[role="group"]');
    const modelList = sourceGroup?.parentElement;
    expect(modelList).not.toBeNull();

    fireEvent.pointerMove(row, { pointerType: "mouse" });
    const slider = await screen.findByRole("slider", { name: "思考强度" });
    expect(screen.getByText("来源：OpenAI")).toBeInTheDocument();

    (modelList as HTMLDivElement).scrollTop = 24;
    fireEvent.scroll(modelList!);
    fireEvent.pointerMove(row, { pointerType: "mouse" });

    await waitFor(() => expect(screen.getByRole("slider", { name: "思考强度" })).toBe(slider));
    expect(screen.getByText("来源：OpenAI")).toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });
  it("keeps a model submenu stable while moving across row children inside the edit dialog", async () => {
    const select = vi.fn();
    const option = { ...models[1], reasoningEfforts: ["low", "high", "xhigh"], reasoningEffort: "high", defaultReasoningEffort: "high" };
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>编辑子智能体</DialogTitle>
          <DialogDescription>配置子智能体</DialogDescription>
          <ModelSelector options={[option]} label="选择模型" onSelect={select} />
        </DialogContent>
      </Dialog>,
    );
    await screen.findByRole("dialog", { name: "编辑子智能体" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "选择模型" }), { button: 0, ctrlKey: false });
    const row = await screen.findByRole("menuitem", { name: "OpenAI · Same Model" });
    fireEvent.pointerMove(row, { pointerType: "mouse" });
    const slider = await screen.findByRole("slider", { name: "思考强度" });
    const submenu = slider.closest('[data-radix-menu-content]');
    const label = within(row).getByText("Same Model");
    const cpu = row.querySelector("svg.lucide-cpu");
    expect(label.tagName).toBe("SPAN");
    expect(cpu).not.toBeNull();
    expect(submenu).not.toBeNull();

    for (const target of [label, row, cpu!]) {
      fireEvent.pointerMove(target, { pointerType: "mouse" });
      await waitFor(() => {
        expect(screen.getByRole("slider", { name: "思考强度" })).toBe(slider);
        expect(slider.closest('[data-radix-menu-content]')).toBe(submenu);
      });
    }
    expect(select).not.toHaveBeenCalled();
  });
  it.each([
    [["high", "max"], "max"],
    [["minimal", "low", "medium", "high"], "high"],
  ])("uses the exact %s effort levels for the selected model", async (reasoningEfforts, lastEffort) => {
    const select = vi.fn();
    const option = { ...models[1], reasoningEfforts, reasoningEffort: reasoningEfforts[0] };
    render(<ModelSelector options={[option]} label="选择模型" onSelect={select} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "选择模型" }), { button: 0, ctrlKey: false });
    fireEvent.pointerMove(await screen.findByRole("menuitem", { name: "OpenAI · Same Model" }), { pointerType: "mouse" });
    const slider = await screen.findByRole("slider", { name: "思考强度" });
    expect(slider).toHaveAttribute("aria-valuemax", String(reasoningEfforts.length - 1));
    fireEvent.keyDown(slider, { key: "End" });
    expect(select).toHaveBeenCalledWith(option, lastEffort);
    await waitFor(() => expect(slider).toHaveAttribute("aria-disabled", "false"));
  });
  it.each([undefined, [], ["high"]])("does not invent an adjustable effort for %s", async (reasoningEfforts) => {
    render(<ModelSelector options={[{ ...models[1], reasoningEfforts }]} label="选择模型" onSelect={vi.fn()} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "选择模型" }), { button: 0, ctrlKey: false });
    fireEvent.pointerMove(await screen.findByRole("menuitem", { name: "OpenAI · Same Model" }), { pointerType: "mouse" });
    await screen.findByText("来源：OpenAI");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });
  it("uses the Alibaba Cloud mark for Bailian sources", () => {
    const { container } = render(<ProviderMark provider="aliyun-bailian-coding" label="阿里云百炼" />);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("alibabacloud-color.svg");
  });
  it("shows stable primary sources and never infers supplier from a model name", async () => {
    const select = await open();
    expect(screen.getByRole("tab", { name: "Mona AI" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "OpenAI" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Anthropic" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "CodeBuddy" }).querySelector("img")?.getAttribute("src")).toContain("codebuddy-color.svg");
    fireEvent.click(screen.getByRole("tab", { name: "我的转发服务" }));
    expect(screen.queryByRole("menuitem", { name: "OpenAI · Same Model" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "我的转发服务 · Same Model" }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ provider: "custom-relay", model: "same-model" }), null);
    expect(sourceId("custom-relay")).toBe("custom-relay");
  });
  it("has no model favorites and keeps sources distinct", async () => {
    await open();
    expect(screen.queryByRole("tab", { name: "收藏" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /收藏/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "我的转发服务 · Same Model" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "OpenAI · Same Model" })).toBeInTheDocument();
  });
  it("filters within source and honors the actual native visibility preference", async () => {
    useModelPreferences.getState().setNativeVisible([modelKey(models[3])], false);
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "OpenAI" }));
    expect(screen.queryByText("原生示例")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索模型" }), { target: { value: "no-match" } });
    expect(screen.getByText("暂无可选择的模型")).toBeInTheDocument();
  });
  it("focuses search and lets the keyboard select a filtered result without opening its details", async () => {
    const select = await open();
    const search = screen.getByRole("textbox", { name: "搜索模型" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "原生示例" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const result = screen.getByRole("menuitem", { name: "OpenAI · 原生示例" });
    expect(result).toHaveFocus();
    fireEvent.keyDown(result, { key: "Enter" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ executor: "codex", provider: "native:codex" }), null);
  });
  it("navigates provider categories with arrows and preserves the exact source", async () => {
    const select = await open();
    const tab = screen.getByRole("tab", { name: "OpenAI" });
    tab.focus();
    fireEvent.keyDown(tab, { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: "Anthropic" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("tab", { name: "我的转发服务" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    const result = screen.getByRole("menuitem", { name: "我的转发服务 · Same Model" });
    expect(result).toHaveFocus();
    expect(select).not.toHaveBeenCalled();
  });
  it("keeps preset, source API and CLI routes independent in development", () => {
    const options = developmentModels([
      { id: "mona", name: "Mona Coding", available: true, reason: "", models: [
        { id: "", label: "默认", model: "same-model", provider: "openai", preset: true },
        { id: "same-model", label: "API", provider: "custom-relay", preset: false },
      ] },
      { id: "codex", name: "Codex", available: true, reason: "", models: [{ id: "same-model", label: "订阅" }] },
    ]);
    expect(developmentModelRoute(options[0])).toEqual({ executor: "mona", model: null, provider: null, effort: null });
    expect(developmentModelRoute(options[1]).provider).toBe("custom-relay");
    expect(developmentModelRoute(options[2])).toEqual({ executor: "codex", model: "same-model", provider: null, effort: null });
    expect(developmentModelRoute(options[2], "xhigh").effort).toBe("xhigh");
    expect(new Set(options.map(modelKey)).size).toBe(3);
  });

  it("routes a configured Mona model through its saved engine and original provider", () => {
    const options = developmentModels([
      { id: "mona", name: "Mona Coding", available: true, reason: "", models: [
        { id: "custom-qwen", model: "custom-qwen", label: "Qwen", provider: "custom-relay", providerLabel: "我的转发服务", preset: false, engine: "codex" },
      ] },
      { id: "codex", name: "Codex", available: true, reason: "", models: [{ id: "native-codex", label: "Native Codex" }] },
    ]);

    const configuredModel = options.find((option) => option.provider === "custom-relay");
    expect(configuredModel).toMatchObject({ executor: "codex", provider: "custom-relay", model: "custom-qwen" });
    expect(developmentModelRoute(configuredModel!)).toEqual({
      executor: "codex", model: "custom-qwen", provider: "custom-relay", effort: null,
    });
  });

  it("keeps a current task active on its old engine after the configured default changes", () => {
    const current = {
      id: "session-1", projectId: "project-1", title: "Existing task", executor: "mona" as const,
      model: "custom-qwen", modelProvider: "custom-relay", readonly: false, parentSessionId: null,
      pinned: false, archived: false, revision: 1, updatedAt: "2026-09-30T00:00:00Z",
    };
    const options = developmentModels([
      { id: "mona", name: "Mona Coding", available: true, reason: "", models: [
        { id: "custom-qwen", model: "custom-qwen", label: "Qwen", provider: "custom-relay", preset: false, engine: "codex" },
      ] },
      { id: "codex", name: "Codex", available: true, reason: "", models: [{ id: "native-codex", label: "Native Codex" }] },
    ], current);
    const preferred = options.find((option) => option.executor === "codex");
    const activeOldEngine = options.find((option) => option.executor === "mona" && option.active);

    expect(preferred).toMatchObject({ executor: "codex", active: false, provider: "custom-relay" });
    expect(activeOldEngine).toMatchObject({ executor: "mona", active: true, provider: "custom-relay" });
    expect(developmentModelRoute(activeOldEngine!)).toEqual({
      executor: "mona", model: "custom-qwen", provider: "custom-relay", effort: null,
    });
  });
});
