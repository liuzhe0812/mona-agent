import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDesktopSettings: vi.fn(),
  updateDesktopSettings: vi.fn(),
}));

const baseSettings = {
  run_in_background: true,
  auto_start_gateway: true,
  gateway_port: 17173,
  quick_ask_shortcut: "Ctrl+Alt+M",
  quick_ask_mode: "compact",
  send_message_shortcut: "enter" as const,
  sidebar_shortcuts: {
    mona: "Alt+1",
    note: "Alt+2",
    ssh: "Alt+3",
    email: "Alt+4",
    schedule: "Alt+5",
    db: "Alt+6",
  },
  default_view: "chat",
  sidebar_modules: [],
  config_path: null,
};

vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  getDesktopSettings: mocks.getDesktopSettings,
  updateDesktopSettings: mocks.updateDesktopSettings,
  checkForUpdates: vi.fn(),
  performUpdate: vi.fn(),
  getAgentSearchScope: vi.fn(),
  setAgentSearchScope: vi.fn(),
  loadDesktopNotesState: vi.fn(),
  showNotification: vi.fn(),
  httpFetch: vi.fn(),
  SEND_MESSAGE_SHORTCUT_EVENT: "mona:send-message-shortcut",
}));

import { ShortcutsSettings } from "./SettingsView";

describe("ShortcutsSettings", () => {
  beforeEach(() => {
    mocks.getDesktopSettings.mockReset();
    mocks.updateDesktopSettings.mockReset();
    mocks.getDesktopSettings.mockResolvedValue(baseSettings);
    mocks.updateDesktopSettings.mockImplementation(async (settings) => settings);
  });

  it("persists Ctrl+Enter send and notifies open composers", async () => {
    const changed = vi.fn();
    window.addEventListener("mona:send-message-shortcut", changed);
    render(<ShortcutsSettings />);

    expect(await screen.findByText("Message input")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ctrl + Enter" }));

    await waitFor(() =>
      expect(mocks.updateDesktopSettings).toHaveBeenCalledWith({
        ...baseSettings,
        send_message_shortcut: "ctrl_enter",
      }),
    );
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener("mona:send-message-shortcut", changed);
  });
});
