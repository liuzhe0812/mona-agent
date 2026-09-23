import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  updateComputerUseSettings: vi.fn(),
  updateJevSettings: vi.fn(),
}));
const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  checkForUpdates: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSettings: api.fetchSettings,
  updateComputerUseSettings: api.updateComputerUseSettings,
  updateJevSettings: api.updateJevSettings,
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: tauri.isTauri,
  checkForUpdates: tauri.checkForUpdates,
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClientOptional: () => ({ token: "tok" }),
}));

vi.mock("@/components/settings/ManagedRuntimeSettings", () => ({
  ManagedRuntimeSettings: () => <div data-testid="managed-runtime-settings">Advanced features</div>,
}));

import { SettingsView } from "./SettingsView";

const props = {
  theme: "light" as const,
  onToggleTheme: vi.fn(),
  onBackToChat: vi.fn(),
  onModelNameChange: vi.fn(),
};

describe("SettingsView advanced features section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.isTauri.mockReturnValue(false);
    tauri.checkForUpdates.mockReset();
    api.fetchSettings.mockRejectedValue(new Error("settings unavailable"));
  });

  it("keeps the provider layout visible and edits the decision model only in the shared settings dialog", async () => {
    const payload = {
      agent: { model: "", provider: "", model_preset: "default", timezone: "UTC", tool_hint_max_length: 40 },
      model_presets: [],
      providers: [],
      chat_providers: [],
      runtime: { workspace_path: "" },
      web_search: { provider: "anysearch", max_results: 5, timeout: 30 },
      image_generation: { enabled: false, provider: "", model: "", default_aspect_ratio: "1:1", default_image_size: "1K", max_images_per_turn: 4, model_parameters: {}, providers: [] },
      video_generation: { enabled: false, provider: "", model: "", default_aspect_ratio: "16:9", default_duration: 5, model_parameters: {}, providers: [] },
      tts: { provider: "edge", voice: "", api_base: null, model: null },
      jev: { configured: true, api_key_hint: "••••", api_base: "https://api.typesafe.ai/v1", model: "jev-latest", timeout_seconds: 15 },
      browser: { use_jev: false, jev_ready: true },
      restart_required_sections: [],
      requires_restart: false,
    };
    api.fetchSettings.mockResolvedValue(payload);
    api.updateJevSettings.mockResolvedValue({ ...payload, jev: { ...payload.jev, model: "jev-preview" } });
    render(<SettingsView {...props} initialSection="models_providers" />);

    const openJev = await screen.findByRole("button", { name: "决策模型" });
    expect(screen.getByRole("heading", { name: "模型供应商" })).toBeVisible();
    expect(screen.getByRole("button", { name: "添加供应商" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();

    fireEvent.click(openJev);
    const dialog = screen.getByRole("dialog", { name: "决策模型配置" });
    expect(within(dialog).getByLabelText("API Key")).toHaveValue("");
    expect(within(dialog).getByLabelText("API Key")).toHaveAttribute("type", "password");
    fireEvent.change(within(dialog).getByLabelText("模型"), { target: { value: "jev-preview" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存决策模型配置" }));
    await waitFor(() => expect(api.updateJevSettings).toHaveBeenCalledWith("tok", {
      apiKey: undefined, apiBase: "https://api.typesafe.ai/v1", model: "jev-preview", timeoutSeconds: 15,
    }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "模型供应商" })).toBeVisible();

    fireEvent.click(openJev);
    expect(screen.getByLabelText("模型")).toHaveValue("jev-preview");
  });

  it("opens the independent advanced features section from its initial section", async () => {
    render(<SettingsView {...props} initialSection="resources" />);

    await waitFor(() => expect(api.fetchSettings).toHaveBeenCalledWith("tok"));

    expect(screen.getByRole("button", { name: "Advanced features" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const usage = screen.getByRole("button", { name: "Usage" });
    const advancedFeatures = screen.getByRole("button", { name: "Advanced features" });
    expect(usage.compareDocumentPosition(advancedFeatures) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("managed-runtime-settings")).toBeInTheDocument();
  });

  it("keeps computer operation acceleration in advanced features", async () => {
    const payload = {
      agent: { model: "qwen3.7-plus", provider: "mona_managed", model_preset: "default", timezone: "UTC", tool_hint_max_length: 40 },
      model_presets: [],
      providers: [],
      chat_providers: [],
      runtime: { workspace_path: "" },
      web_search: { provider: "anysearch", max_results: 5, timeout: 30 },
      image_generation: { enabled: false, provider: "", model: "", default_aspect_ratio: "1:1", default_image_size: "1K", max_images_per_turn: 4, model_parameters: {}, providers: [] },
      video_generation: { enabled: false, provider: "", model: "", default_aspect_ratio: "16:9", default_duration: 5, model_parameters: {}, providers: [] },
      tts: { provider: "edge", voice: "", api_base: null, model: null },
      jev: { configured: true, api_key_hint: "••••", api_base: "https://api.typesafe.ai/v1", model: "jev-latest", timeout_seconds: 15 },
      browser: { use_jev: false, jev_ready: true },
      computer_use: {
        use_decision_model: false,
        vision_model_preset: null,
        max_steps: 20,
        max_duration_seconds: 120,
        decision_model_ready: true,
        vision_model_options: [{ value: "", label: "跟随当前模型" }],
      },
      restart_required_sections: [],
      requires_restart: false,
    };
    api.fetchSettings.mockResolvedValue(payload);
    api.updateComputerUseSettings.mockResolvedValue({
      ...payload,
      computer_use: { ...payload.computer_use, use_decision_model: true },
    });

    render(<SettingsView {...props} initialSection="resources" />);

    const toggle = await screen.findByRole("switch", { name: "使用决策模型加速电脑操作" });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.updateComputerUseSettings).toHaveBeenCalledWith("tok", {
      useDecisionModel: true,
    }));
    expect(screen.getByText("电脑操作")).toBeInTheDocument();
  });

  it("shows a retryable error instead of latest when update checking fails", async () => {
    tauri.isTauri.mockReturnValue(true);
    api.fetchSettings.mockResolvedValue({
      agent: {
        model: "",
        provider: "",
        resolved_provider: "",
        model_preset: "default",
        timezone: "UTC",
        tool_hint_max_length: 40,
      },
      model_presets: [],
      runtime: { workspace_path: "" },
      web_search: { provider: "anysearch", base_url: null, max_results: 5, timeout: 30 },
      image_generation: {
        enabled: false,
        provider: "",
        model: "",
        default_aspect_ratio: "1:1",
        default_image_size: "1K",
        max_images_per_turn: 4,
        model_parameters: {},
      },
      video_generation: {
        enabled: false,
        provider: "",
        model: "",
        default_aspect_ratio: "16:9",
        default_duration: 5,
        model_parameters: {},
      },
      tts: { provider: "edge", voice: "", api_base: null, model: null },
      restart_required_sections: [],
    });
    tauri.checkForUpdates.mockRejectedValue(new Error("update server unavailable"));

    render(<SettingsView {...props} initialSection="about" />);

    const checkButton = await screen.findByRole("button", { name: "立即检查" });
    fireEvent.click(checkButton);

    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("检查更新失败");
    expect(error).toHaveTextContent("update server unavailable");
    expect(screen.queryByText("已是最新版本")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "重试" })).toBeEnabled();
  });
});
