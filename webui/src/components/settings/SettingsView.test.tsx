import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
}));
const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  checkForUpdates: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSettings: api.fetchSettings,
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
