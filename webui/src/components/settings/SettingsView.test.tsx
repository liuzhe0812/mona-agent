import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchSettings: api.fetchSettings,
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: () => false,
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
});
