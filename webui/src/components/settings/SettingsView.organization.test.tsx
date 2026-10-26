import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(), updateSettings: vi.fn(),
  updateWebSearchSettings: vi.fn(), updateBrowserSettings: vi.fn(),
}));
const desktop = vi.hoisted(() => ({
  getDesktopSettings: vi.fn(), updateDesktopSettings: vi.fn(), getAgentSearchScope: vi.fn(),
}));
const picker = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()), ...api,
}));
vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("@/lib/tauri")>()), ...desktop, isTauri: () => true,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: picker.open }));
vi.mock("@/providers/ClientProvider", () => ({ useClientOptional: () => ({ token: "tok" }) }));
vi.mock("@/components/settings/ManagedRuntimeSettings", () => ({ ManagedRuntimeSettings: () => null }));

import { SettingsView } from "./SettingsView";

function settings() {
  return {
    agent: { model: "", provider: "", model_preset: "default", timezone: "UTC", tool_hint_max_length: 179 },
    model_presets: [], providers: [], chat_providers: [], runtime: { workspace_path: "D:/Mona Work" },
    web_search: {
      provider: "anysearch", api_key_hint: null, base_url: null, max_results: 9, timeout: 91,
      providers: [
        { name: "anysearch", label: "AnySearch", credential: "none" },
        { name: "duckduckgo", label: "DuckDuckGo", credential: "none" },
        { name: "tavily", label: "Tavily", credential: "api_key" },
        { name: "searxng", label: "SearXNG", credential: "base_url" },
      ],
    },
    image_generation: { enabled: false, provider: "", model: "", default_aspect_ratio: "1:1", default_image_size: "1K", max_images_per_turn: 4, model_parameters: {}, providers: [] },
    video_generation: { enabled: false, provider: "", model: "", default_aspect_ratio: "16:9", default_duration: 5, model_parameters: {}, providers: [] },
    tts: { provider: "edge", voice: "", api_base: null, model: null },
    jev: { configured: false, api_key_hint: null, api_base: "", model: "", timeout_seconds: 15 },
    browser: { use_jev: false, jev_ready: false },
    computer_use: { use_decision_model: false, vision_model_preset: null, decision_model_ready: false, vision_model_options: [] },
    restart_required_sections: [], requires_restart: false,
  };
}

const props = { theme: "light" as const, onToggleTheme: vi.fn(), onBackToChat: vi.fn(), onModelNameChange: vi.fn() };

function webSection() {
  return within(screen.getByRole("heading", { name: "Web search" }).closest("section")!);
}

async function selectSearchProvider(name: string) {
  const user = userEvent.setup();
  await user.click(webSection().getByRole("button", { name: /AnySearch/ }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

describe("Settings organization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchSettings.mockResolvedValue(settings());
    api.updateSettings.mockReset().mockResolvedValue(settings());
    desktop.getDesktopSettings.mockResolvedValue({ run_in_background: true, auto_start_gateway: false });
    desktop.updateDesktopSettings.mockImplementation(async (value) => value);
    picker.open.mockReset().mockResolvedValue(null);
  });

  it("keeps only timezone, workspace and background behavior in General", async () => {
    render(<SettingsView {...props} />);
    await screen.findByLabelText("Timezone");
    expect(screen.getByRole("heading", { name: "Date & time" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Files & storage" })).toBeInTheDocument();
    expect(screen.getByText("D:/Mona Work", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /restart/i })).not.toBeInTheDocument();
    expect(await screen.findByText("后台运行")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save", exact: true })).not.toBeInTheDocument();
    for (const removed of ["Web search", "Runtime parameters", "工具提示长度", "自动启动网关", "Agent 搜索范围", "浏览器"]) {
      expect(screen.queryByText(removed, { exact: true })).not.toBeInTheDocument();
    }
    expect(desktop.getAgentSearchScope).not.toHaveBeenCalled();
    expect(desktop.updateDesktopSettings).not.toHaveBeenCalled();
  });

  it("saves a timezone immediately as one field and disables the selector while saving", async () => {
    const response = settings();
    response.agent.timezone = "Asia/Shanghai";
    let finishSave: ((value: ReturnType<typeof settings>) => void) | undefined;
    api.updateSettings.mockImplementation(() => new Promise<ReturnType<typeof settings>>((resolve) => {
      finishSave = resolve;
    }));
    render(<SettingsView {...props} />);
    const user = userEvent.setup();
    const timezone = await screen.findByRole("button", { name: "Timezone" });
    await user.click(timezone);
    await user.click(await screen.findByRole("menuitem", { name: /Asia\/Shanghai/ }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith("tok", { timezone: "Asia/Shanghai" }));
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(timezone).toBeDisabled();
    finishSave?.(response);
    await waitFor(() => expect(timezone).toBeEnabled());
    expect(timezone).toHaveTextContent("Asia/Shanghai");
    expect(screen.queryByText(/图片生成/)).not.toBeInTheDocument();
  });

  it("saves only a newly selected workspace and ignores cancelled or unchanged selections", async () => {
    const response = settings();
    response.runtime.workspace_path = "D:/New Mona Work";
    response.restart_required_sections = ["runtime"];
    response.requires_restart = true;
    api.updateSettings.mockResolvedValue(response);
    picker.open
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("D:/Mona Work")
      .mockResolvedValueOnce("D:/New Mona Work");
    render(<SettingsView {...props} onRestart={vi.fn()} />);
    const user = userEvent.setup();
    const chooseWorkspace = await screen.findByRole("button", { name: "Choose workspace" });
    const pickerOptions = { directory: true, multiple: false };

    await user.click(chooseWorkspace);
    await waitFor(() => expect(picker.open).toHaveBeenNthCalledWith(1, pickerOptions));
    expect(api.updateSettings).not.toHaveBeenCalled();

    await user.click(chooseWorkspace);
    await waitFor(() => expect(picker.open).toHaveBeenNthCalledWith(2, pickerOptions));
    expect(api.updateSettings).not.toHaveBeenCalled();

    await user.click(chooseWorkspace);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith("tok", { workspace: "D:/New Mona Work" }));
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("D:/New Mona Work", { exact: true })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /restart/i })).toBeInTheDocument();
    expect(screen.getByText(/restart when ready/i)).toBeInTheDocument();
  });

  it("keeps the previous workspace after save failure without exposing internal errors", async () => {
    picker.open.mockResolvedValue("D:/New Mona Work");
    api.updateSettings.mockRejectedValue(new Error("internal failure SECRET"));
    render(<SettingsView {...props} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Choose workspace" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith("tok", { workspace: "D:/New Mona Work" }));

    const feedback = await screen.findByRole("dialog", { name: "Could not update settings" });
    expect(within(feedback).getByText(
      "Saving could not be confirmed. The last confirmed settings are still shown. Please retry.",
    )).toBeInTheDocument();
    expect(screen.getByText("D:/Mona Work", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/internal failure|SECRET/)).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Could not update settings" })).not.toBeInTheDocument());
  });

  it("moves search settings to advanced and preserves hidden custom values on provider changes", async () => {
    const response = settings();
    response.web_search.provider = "duckduckgo";
    api.updateWebSearchSettings.mockResolvedValue(response);
    render(<SettingsView {...props} initialSection="web" />);
    await screen.findByRole("heading", { name: "Web search" });
    expect(screen.getByRole("button", { name: "Advanced features", exact: true })).toHaveAttribute("aria-current", "page");
    expect(webSection().queryByText("Max results")).not.toBeInTheDocument();
    expect(webSection().queryByText("Timeout")).not.toBeInTheDocument();
    await selectSearchProvider("DuckDuckGo");
    fireEvent.click(webSection().getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(api.updateWebSearchSettings).toHaveBeenCalledWith("tok", { provider: "duckduckgo" }));
  });

  it.each(["Tavily", "SearXNG"])("keeps conditional credentials editable after moving %s", async (provider) => {
    api.updateWebSearchSettings.mockResolvedValue(settings());
    render(<SettingsView {...props} initialSection="resources" />);
    await screen.findByRole("heading", { name: "Web search" });
    await selectSearchProvider(provider);
    const input = webSection().getByRole("button", { name: "Save", exact: true });
    expect(input).toBeDisabled();
    const value = provider === "Tavily" ? crypto.randomUUID() : "https://search.example.invalid";
    fireEvent.change(webSection().getByPlaceholderText(provider === "Tavily" ? "Enter API key" : "https://search.example.com"), { target: { value } });
    fireEvent.click(input);
    await waitFor(() => expect(api.updateWebSearchSettings).toHaveBeenCalledWith("tok", {
      provider: provider.toLowerCase(), ...(provider === "Tavily" ? { apiKey: value } : { baseUrl: value }),
    }));
  });

  it("keeps the browser prerequisite next to the disabled acceleration switch in advanced", async () => {
    render(<SettingsView {...props} initialSection="resources" />);
    const toggle = await screen.findByRole("switch", { name: "使用决策模型加速浏览器操作" });
    expect(toggle).toBeDisabled();
    const browser = screen.getByRole("heading", { name: "浏览器", exact: true }).closest("section")!;
    expect(within(browser).getByText("请先在模型设置中配置决策模型，再开启浏览器加速。")).toBeInTheDocument();
    expect(within(browser).queryByText("状态", { exact: true })).not.toBeInTheDocument();
  });
});
