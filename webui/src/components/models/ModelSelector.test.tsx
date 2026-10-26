import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "./ModelSelector";
import { ProviderMark } from "./ProviderMark";
import { modelKey, sourceId, useModelPreferences, type ModelOption } from "./model-sources";
import { developmentModels, developmentModelRoute } from "@/components/development/development-models";
import { DevelopmentApiError } from "@/lib/development-api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const models: ModelOption[] = [
  { provider: "mona_managed", providerLabel: "Mona AI", model: "self-test", label: "自供示例", active: true, isBuiltin: true },
  { provider: "openai", providerLabel: "OpenAI", model: "same-model", label: "Same Model", active: false },
  { provider: "custom-relay", providerLabel: "我的转发服务", model: "same-model", label: "Same Model", active: false },
  { provider: "native:codex", providerLabel: "OpenAI", model: "native-test", label: "原生示例", executor: "codex", active: false },
];
beforeEach(() => { useModelPreferences.setState({ hiddenNative: [], providerOrder: [] }); });
afterEach(cleanup);
async function open(onSelect = vi.fn(), options = models) {
  render(<ModelSelector options={options} label="选择模型" onSelect={onSelect} onManage={vi.fn()} />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "选择模型" }), { button: 0, ctrlKey: false });
  await screen.findByRole("textbox", { name: "搜索模型" });
  return onSelect;
}
describe("source-first unified model selector", () => {
  it("shows the selected model label while passing its id to the selection callback", async () => {
    const option = { ...models[1], model: "api/model-v2", label: "Friendly Name", active: false };
    const select = vi.fn();
    const { rerender } = render(<ModelSelector options={[option]} onSelect={select} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "选择模型" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "OpenAI · Friendly Name" }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0]).toBe(option);
    expect(select.mock.calls[0][0].model).toBe("api/model-v2");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "搜索模型" })).not.toBeInTheDocument());

    rerender(<ModelSelector options={[{ ...option, active: true }]} onSelect={select} />);
    expect(screen.getByRole("button", { name: "Friendly Name" })).toHaveTextContent("Friendly Name");
  });

  it("keeps an icon when no model is selected", () => {
    render(<ModelSelector options={[{ ...models[1], active: false }]} onSelect={vi.fn()} />);
    const button = screen.getByRole("button", { name: "选择模型" });
    expect(button.querySelector("svg.lucide-cpu")).not.toBeNull();
  });

  it("shows the full selected model label in a tooltip without changing its accessible name", async () => {
    const option = {
      ...models[1], active: true, reasoningEfforts: ["low", "high"], reasoningEffort: "high",
    };
    render(<ModelSelector options={[option]} onSelect={vi.fn()} />);

    const button = screen.getByRole("button", { name: "Same Model" });
    expect(button).not.toHaveAttribute("title");
    fireEvent.focus(button);
    expect(await screen.findByRole("tooltip", { name: "Same Model · OpenAI · 思考强度：高" })).toBeInTheDocument();

    fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: "mouse" });
    await screen.findByRole("textbox", { name: "搜索模型" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps the panel open until a model save succeeds and blocks another model selection", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const select = vi.fn(() => pending);
    const options = [
      { ...models[1], active: false },
      { ...models[2], model: "second-model", label: "Second Model", active: false },
    ];
    await open(select, options);

    const first = await screen.findByRole("menuitem", { name: "OpenAI · Same Model" });
    fireEvent.click(first);
    await waitFor(() => expect(first).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByRole("textbox", { name: "搜索模型" })).toBeInTheDocument();
    const second = screen.getByRole("menuitem", { name: "我的转发服务 · Second Model" });
    expect(second).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(second);
    expect(select).toHaveBeenCalledTimes(1);

    await act(async () => { resolve(); await pending; });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "搜索模型" })).not.toBeInTheDocument());
  });

  it("shares the in-flight lock with effort changes and keeps the panel open after success", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const select = vi.fn(() => pending);
    const option = {
      ...models[1], active: true, reasoningEfforts: ["low", "high"],
      reasoningEffort: "low", defaultReasoningEffort: "low",
    };
    await open(select, [option]);
    const row = await screen.findByRole("menuitem", { name: "OpenAI · Same Model" });
    fireEvent.pointerMove(row, { pointerType: "mouse" });
    const slider = await screen.findByRole("slider", { name: "思考强度" });
    fireEvent.keyDown(slider, { key: "End" });

    await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    expect(select).toHaveBeenCalledWith(option, "high");
    expect(slider).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.click(row);
    expect(select).toHaveBeenCalledTimes(1);

    await act(async () => { resolve(); await pending; });
    await waitFor(() => expect(slider).toHaveAttribute("aria-disabled", "false"));
    expect(screen.getByRole("textbox", { name: "搜索模型" })).toBeInTheDocument();
  });

  it("shows the translated DevelopmentApiError reason when an effort save fails", async () => {
    const error = new DevelopmentApiError(422, "unsupported_reasoning_effort", "当前模型不支持该思考强度，请刷新目录后重试。");
    const select = vi.fn().mockRejectedValue(error);
    const option = {
      ...models[1], active: true, reasoningEfforts: ["low", "high"],
      reasoningEffort: "low", defaultReasoningEffort: "low",
    };
    await open(select, [option]);
    const row = await screen.findByRole("menuitem", { name: "OpenAI · Same Model" });
    fireEvent.pointerMove(row, { pointerType: "mouse" });
    const slider = await screen.findByRole("slider", { name: "思考强度" });
    fireEvent.keyDown(slider, { key: "End" });

    const dialog = await screen.findByRole("alertdialog", { name: "设置未保存" });
    expect(within(dialog).getByText("思考强度未保存。当前模型不支持该思考强度，请刷新目录后重试。")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("请检查连接");
  });

  it("does not expose raw errors and describes both operations for an inactive model slider", async () => {
    const select = vi.fn().mockRejectedValue(new Error("internal request details"));
    const option = {
      ...models[1], model: "inactive-model", label: "Inactive Model", active: false,
      reasoningEfforts: ["low", "high"], reasoningEffort: "low", defaultReasoningEffort: "low",
    };
    await open(select, [option]);
    const row = await screen.findByRole("menuitem", { name: "OpenAI · Inactive Model" });
    fireEvent.pointerMove(row, { pointerType: "mouse" });
    const slider = await screen.findByRole("slider", { name: "思考强度" });
    fireEvent.keyDown(slider, { key: "End" });

    const dialog = await screen.findByRole("alertdialog", { name: "设置未保存" });
    expect(within(dialog).getByText("模型未切换，思考强度未保存。请稍后重试。")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("internal request details");
  });

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
    expect(screen.getByRole("tab", { name: "WorkBuddy" }).querySelector("img")?.getAttribute("src")).toContain("codebuddy-color.svg");
    fireEvent.click(screen.getByRole("tab", { name: "我的转发服务" }));
    expect(screen.queryByRole("menuitem", { name: "OpenAI · Same Model" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "我的转发服务 · Same Model" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "搜索模型" })).not.toBeInTheDocument());
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

  it("shows WorkBuddy credit multipliers on rows without hover and preserves plain details and reasoning", async () => {
    const free: ModelOption = {
      provider: "native:codebuddy", providerLabel: "WorkBuddy", model: "free-model",
      label: "零倍率模型", executor: "codebuddy", active: false, description: "x0.00",
    };
    const standard: ModelOption = {
      provider: "native:codebuddy", providerLabel: "WorkBuddy", model: "standard-model",
      label: "标准倍率模型", executor: "codebuddy", active: false, description: "x1.50",
    };
    const spaced: ModelOption = {
      provider: "native:codebuddy", providerLabel: "WorkBuddy", model: "spaced-model",
      label: "空格倍率模型", executor: "codebuddy", active: false, description: "× 2.00",
    };
    const plain: ModelOption = {
      provider: "native:codebuddy", providerLabel: "WorkBuddy", model: "plain-model",
      label: "说明模型", executor: "codebuddy", active: false,
      description: "适合复杂推理，不单独说明积分倍率。",
      reasoningEfforts: ["low", "high"], reasoningEffort: "high", defaultReasoningEffort: "low",
      contextWindow: 1_000_000,
    };
    const unknown: ModelOption = {
      provider: "native:codebuddy", providerLabel: "WorkBuddy", model: "unknown-model",
      label: "未知倍率模型", executor: "codebuddy", active: false, description: "倍率暂未提供",
    };
    const select = vi.fn();
    await open(select, [free, standard, spaced, plain, unknown]);

    const group = screen.getByRole("group", { name: "WorkBuddy" });
    expect(within(group).getByText("积分消耗")).toBeInTheDocument();
    const freeRow = within(group).getByRole("menuitem", { name: "WorkBuddy · 零倍率模型" });
    const standardRow = within(group).getByRole("menuitem", { name: "WorkBuddy · 标准倍率模型" });
    const spacedRow = within(group).getByRole("menuitem", { name: "WorkBuddy · 空格倍率模型" });
    const plainRow = within(group).getByRole("menuitem", { name: "WorkBuddy · 说明模型" });
    const unknownRow = within(group).getByRole("menuitem", { name: "WorkBuddy · 未知倍率模型" });
    expect(within(freeRow).getByText("×0.00")).toBeInTheDocument();
    expect(within(standardRow).getByText("×1.50")).toBeInTheDocument();
    expect(within(spacedRow).getByText("×2.00")).toBeInTheDocument();
    expect(within(plainRow).queryByText(/×\s*\d/)).not.toBeInTheDocument();
    expect(within(unknownRow).queryByText(/×\s*\d/)).not.toBeInTheDocument();
    expect(screen.queryByText(plain.description!)).not.toBeInTheDocument();

    fireEvent.pointerMove(plainRow, { pointerType: "mouse" });
    expect(await screen.findByRole("slider", { name: "思考强度" })).toBeInTheDocument();
    expect(screen.getByText(plain.description!)).toBeInTheDocument();
    expect(screen.getByText(/来源：WorkBuddy · .*上下文/)).toBeInTheDocument();

    fireEvent.click(freeRow);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "搜索模型" })).not.toBeInTheDocument());
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(free, null);
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
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "搜索模型" })).not.toBeInTheDocument());
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

  it("keeps a configured API model on Mona despite a legacy engine override", () => {
    const options = developmentModels([
      { id: "mona", name: "Mona Coding", available: true, reason: "", models: [
        { id: "custom-qwen", model: "custom-qwen", label: "Qwen", provider: "custom-relay", providerLabel: "我的转发服务", preset: false, engine: "codex" },
      ] },
      { id: "codex", name: "Codex", available: true, reason: "", models: [{ id: "native-codex", label: "Native Codex" }] },
    ]);

    const configuredModel = options.find((option) => option.provider === "custom-relay");
    expect(configuredModel).toMatchObject({ executor: "mona", provider: "custom-relay", model: "custom-qwen" });
    expect(developmentModelRoute(configuredModel!)).toEqual({
      executor: "mona", model: "custom-qwen", provider: "custom-relay", effort: null,
    });
  });

  it("keeps an existing Codex task active while the default API model stays on Mona", () => {
    const current = {
      id: "session-1", projectId: "project-1", title: "Existing task", executor: "codex" as const,
      model: "custom-qwen", modelProvider: "custom-relay", readonly: false, parentSessionId: null,
      pinned: false, archived: false, revision: 1, updatedAt: "2026-09-30T00:00:00Z",
    };
    const options = developmentModels([
      { id: "mona", name: "Mona Coding", available: true, reason: "", models: [
        { id: "custom-qwen", model: "custom-qwen", label: "Qwen", provider: "custom-relay", preset: false, engine: "codex" },
      ] },
      { id: "codex", name: "Codex", available: true, reason: "", models: [{ id: "native-codex", label: "Native Codex" }] },
    ], current);
    const defaultApi = options.find((option) => option.executor === "mona" && option.provider === "custom-relay");
    const activeOldEngine = options.find((option) =>
      option.executor === "codex" && option.provider === "custom-relay" && option.model === "custom-qwen",
    );
    const nativeCodex = options.find((option) => option.provider === "native:codex");

    expect(defaultApi).toMatchObject({ executor: "mona", active: false, provider: "custom-relay" });
    expect(activeOldEngine).toMatchObject({ executor: "codex", active: true, provider: "custom-relay" });
    expect(nativeCodex).toMatchObject({ executor: "codex", active: false, model: "native-codex", provider: "native:codex" });
    expect(developmentModelRoute(activeOldEngine!)).toEqual({
      executor: "codex", model: "custom-qwen", provider: "custom-relay", effort: null,
    });
  });
});
