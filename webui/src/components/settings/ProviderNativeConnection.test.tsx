import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderNativeConnection } from "./ProviderNativeConnection";
import { developmentModels, developmentModelRoute } from "@/components/development/development-models";
import { modelKey, useModelPreferences } from "@/components/models/model-sources";
import { developmentApi, type DevExecutor } from "@/lib/development-api";

vi.mock("@/lib/development-api", async (load) => ({ ...(await load<typeof import("@/lib/development-api")>()),
  developmentApi: { loginStatus: vi.fn(), login: vi.fn(), probe: vi.fn(), logout: vi.fn() } }));
const buddy: DevExecutor = { id: "codebuddy", name: "CodeBuddy", available: true, executable: "test/codebuddy.exe",
  reason: "已定位", probe: { state: "detected", reason: "尚未确认账号", version: "1.2.3", authentication: "unknown", protocolVerified: true },
  models: [{ id: "", label: "执行者默认模型" }] };
const readyBuddy: DevExecutor = { ...buddy, probe: { ...buddy.probe!, state: "ready", reason: "账号与模型目录已就绪", authentication: "ready", protocolVerified: true, modelCatalogState: "ready" } };

beforeEach(() => {
  vi.resetAllMocks();
  useModelPreferences.setState({ hiddenNative: [], providerOrder: [] });
  vi.mocked(developmentApi.loginStatus).mockResolvedValue({ loginId: "completed-login", state: "succeeded", authUrl: "", reason: "授权完成" });
  vi.mocked(developmentApi.probe).mockResolvedValue(buddy.probe!);
});
afterEach(cleanup);

describe("native catalog presentation", () => {
  it("preserves the empty-ID default choice and shares its visibility with the developer selector", () => {
    render(<ProviderNativeConnection executor={readyBuddy} onChanged={vi.fn()} />);
    const toggle = screen.getByRole("switch", { name: "WorkBuddy 默认模型 在选择器中显示" });
    const option = developmentModels([readyBuddy])[0];
    expect(developmentModelRoute(option)).toEqual({ executor: "codebuddy", model: null, provider: null, effort: null });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(useModelPreferences.getState().hiddenNative).toContain(modelKey(option));
    const hiddenSection = screen.getByRole("button", { name: "未显示 1" });
    expect(hiddenSection).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(hiddenSection);
    const hiddenToggle = screen.getByRole("switch", { name: "WorkBuddy 默认模型 在选择器中显示" });
    expect(hiddenToggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(hiddenToggle);
    expect(useModelPreferences.getState().hiddenNative).not.toContain(modelKey(option));
    expect(screen.getByRole("switch", { name: "WorkBuddy 默认模型 在选择器中显示" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("已连接")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "断开连接" })).not.toBeInTheDocument();
    expect(developmentApi.login).not.toHaveBeenCalled();
    expect(developmentApi.logout).not.toHaveBeenCalled();
  });

  it("keeps unconfirmed WorkBuddy authorization visible without claiming connection", async () => {
    render(<ProviderNativeConnection executor={buddy} onChanged={vi.fn()} />);
    await screen.findByText("已授权");
    expect(screen.getByText("未连接")).toBeInTheDocument();
    expect(screen.queryByText("尚未确认账号")).not.toBeInTheDocument();
    expect(screen.queryByText("已连接")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "断开连接" })).not.toBeInTheDocument();
    expect(developmentApi.logout).not.toHaveBeenCalled();
  });

  it("keeps model visibility preferences while disconnected, then restores them on reconnect", async () => {
    const models = [{ id: "fixture-one", label: "目录模型一" }, { id: "fixture-two", label: "目录模型二" }];
    const firstKey = modelKey({ provider: "native:codebuddy", model: "fixture-one", executor: "codebuddy" });
    const secondKey = modelKey({ provider: "native:codebuddy", model: "fixture-two", executor: "codebuddy" });
    useModelPreferences.setState({ hiddenNative: [secondKey], providerOrder: [] });
    const { rerender } = render(<ProviderNativeConnection executor={{ ...buddy, models }} onChanged={vi.fn()} />);
    await screen.findByText("已授权");
    const first = screen.getByRole("switch", { name: "WorkBuddy 目录模型一 在选择器中显示" });
    const hiddenSection = screen.getByRole("button", { name: "未显示 1" });
    expect(hiddenSection).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(hiddenSection);
    const second = screen.getByRole("switch", { name: "WorkBuddy 目录模型二 在选择器中显示" });
    expect(first).toHaveAttribute("aria-checked", "false");
    expect(first).toBeDisabled();
    expect(second).toHaveAttribute("aria-checked", "false");
    expect(second).toBeDisabled();
    expect(useModelPreferences.getState().hiddenNative).toEqual([secondKey]);
    expect(screen.getByRole("button", { name: "WorkBuddy 全部显示" })).toBeDisabled();

    rerender(<ProviderNativeConnection executor={{ ...readyBuddy, models }} onChanged={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "WorkBuddy 目录模型一 在选择器中显示" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "WorkBuddy 目录模型二 在选择器中显示" })).toHaveAttribute("aria-checked", "false");
    expect(useModelPreferences.getState().hiddenNative).toEqual([secondKey]);
    expect(useModelPreferences.getState().hiddenNative).not.toContain(firstKey);
  });

  it("does not invent a default model when the API supplies no choices", () => {
    render(<ProviderNativeConnection executor={{ ...readyBuddy, models: [] }} onChanged={vi.fn()} />);
    expect(screen.getByText("暂未获取模型信息")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("renders all named models and preserves their native route", () => {
    const executor = { ...readyBuddy, models: [...readyBuddy.models, { id: "fixture-one", label: "目录模型一" }, { id: "fixture-two", label: "目录模型二" }] };
    render(<ProviderNativeConnection executor={executor} onChanged={vi.fn()} />);
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    const option = developmentModels([executor])[1];
    fireEvent.click(screen.getByRole("switch", { name: "WorkBuddy 目录模型一 在选择器中显示" }));
    expect(useModelPreferences.getState().hiddenNative).toEqual([modelKey(option)]);
    expect(developmentModelRoute(option).model).toBe("fixture-one");
  });

  it("keeps descriptions and context size in the model row title", () => {
    const executor = { ...readyBuddy, models: [{ id: "gpt-6-astra", label: "GPT-6-Astra", description: "擅长复杂推理", contextWindow: 200_000 }] };
    const { container } = render(<ProviderNativeConnection executor={executor} onChanged={vi.fn()} showControls={false} />);
    expect(screen.getByText("GPT-6-Astra")).toBeInTheDocument();
    expect(screen.queryByText("擅长复杂推理")).not.toBeInTheDocument();
    expect(screen.queryByText("200K")).not.toBeInTheDocument();
    expect(container.querySelector('[title="擅长复杂推理\n上下文窗口：200K"]')).toBeInTheDocument();
  });

  it("moves model refresh into the connection operations menu", async () => {
    const changed = vi.fn();
    const user = userEvent.setup();
    render(<ProviderNativeConnection executor={readyBuddy} onChanged={changed} showModels={false} />);
    await user.click(screen.getByRole("button", { name: "更多连接操作" }));
    await user.click(await screen.findByRole("menuitem", { name: "刷新连接与模型" }));
    await waitFor(() => expect(developmentApi.probe).toHaveBeenCalledWith(undefined, "codebuddy"));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("检测到本机 WorkBuddy")).not.toBeInTheDocument();
  });

  it("does not add a connection details dialog", () => {
    render(<ProviderNativeConnection executor={buddy} onChanged={vi.fn()} />);
    expect(screen.queryByText("连接详情")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not expose unsupported WorkBuddy logout when connected", () => {
    render(<ProviderNativeConnection executor={readyBuddy} onChanged={vi.fn()} />);
    expect(screen.getByText("已连接")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "断开连接" })).not.toBeInTheDocument();
  });

  it("disconnects the Claude account binding without logging out the local CLI", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const changed = vi.fn();
    vi.mocked(developmentApi.logout).mockResolvedValue({ ok: true });
    try {
      render(<ProviderNativeConnection executor={{ ...buddy, id: "claude", name: "Claude Code", models: [],
        probe: { state: "ready", reason: "账号已就绪", authentication: "ready" } }} onChanged={changed} />);
      expect(screen.getByText("已连接")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "断开连接" }));
      await waitFor(() => expect(developmentApi.logout).toHaveBeenCalledWith("claude"));
      expect(developmentApi.logout).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledWith("断开 Claude Code 连接？");
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { confirm.mockRestore(); }
  });

  it("keeps the existing supported Codex logout after explicit confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const changed = vi.fn();
    vi.mocked(developmentApi.logout).mockResolvedValue({ ok: true });
    try {
      render(<ProviderNativeConnection executor={{ ...buddy, id: "codex", name: "Codex", probe: { state: "ready", reason: "已连接", authMode: "chatgpt" } }} onChanged={changed} />);
      fireEvent.click(screen.getByRole("button", { name: "断开连接" }));
      await waitFor(() => expect(developmentApi.logout).toHaveBeenCalledWith("codex"));
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { confirm.mockRestore(); }
  });
});
