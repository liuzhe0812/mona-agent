import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchAutomationStatus: vi.fn(),
  updateBrowserAutomation: vi.fn(),
  updateComputerUse: vi.fn(),
  cancelComputerUse: vi.fn(),
  grantComputerUsePermissions: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import { AutomationSettings } from "./AutomationSettings";

const computerStatus = {
  enabled: false,
  state: "disabled" as const,
  supported: true,
  version: "0.23.2",
  downloadBytes: 27_635_699,
  installed: false,
  degraded: false,
  error: null,
  job: null,
};

const baseStatus = {
  browserAutomationEnabled: true,
  computerUse: computerStatus,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchAutomationStatus.mockResolvedValue(baseStatus);
  api.updateBrowserAutomation.mockResolvedValue({
    browserAutomationEnabled: false,
  });
  api.updateComputerUse.mockResolvedValue({
    ...computerStatus,
    enabled: true,
    state: "downloading",
    job: {
      jobId: "cua-job",
      state: "running",
      stage: "downloading",
      downloadedBytes: 8_290_710,
      totalBytes: 27_635_699,
    },
  });
  api.cancelComputerUse.mockResolvedValue(computerStatus);
  api.grantComputerUsePermissions.mockResolvedValue({
    ...computerStatus,
    enabled: true,
    state: "available",
    installed: true,
  });
});

describe("AutomationSettings", () => {
  it("loads browser enabled and computer automation disabled by default", async () => {
    render(<AutomationSettings token="tok" />);

    expect(await screen.findByText("Browser automation")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Browser automation" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Computer automation" })).toHaveAttribute("aria-checked", "false");
    expect(api.fetchAutomationStatus).toHaveBeenCalledWith("tok");
  });

  it("persists the browser automation switch", async () => {
    render(<AutomationSettings token="tok" />);
    fireEvent.click(
      await screen.findByRole("switch", { name: "Browser automation" }),
    );

    await waitFor(() => {
      expect(api.updateBrowserAutomation).toHaveBeenCalledWith("tok", false);
    });
  });

  it("shows driver size and download progress after enabling computer automation", async () => {
    render(<AutomationSettings token="tok" />);
    fireEvent.click(
      await screen.findByRole("switch", { name: "Computer automation" }),
    );

    await waitFor(() => {
      expect(api.updateComputerUse).toHaveBeenCalledWith("tok", true);
    });
    expect(await screen.findByText("30%")).toBeInTheDocument();
    expect(screen.getByText("26.4 MB")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel download" }),
    ).toBeInTheDocument();
  });

  it("supports cancelling a driver download", async () => {
    render(<AutomationSettings token="tok" />);
    fireEvent.click(
      await screen.findByRole("switch", { name: "Computer automation" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel download" }),
    );

    await waitFor(() => {
      expect(api.cancelComputerUse).toHaveBeenCalledWith("tok");
    });
  });

  it("supports authorization and retry actions", async () => {
    api.fetchAutomationStatus.mockResolvedValueOnce({
      ...baseStatus,
      computerUse: {
        ...computerStatus,
        enabled: true,
        state: "pending_authorization",
      },
    });
    render(<AutomationSettings token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));

    await waitFor(() => {
      expect(api.grantComputerUsePermissions).toHaveBeenCalledWith("tok");
    });

    api.fetchAutomationStatus.mockResolvedValue({
      ...baseStatus,
      computerUse: {
        ...computerStatus,
        enabled: true,
        state: "error",
        error: "driver unavailable",
      },
    });
    render(<AutomationSettings token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(api.updateComputerUse).toHaveBeenCalledWith("tok", true);
    });
  });

  it("shows a localized notice when computer automation uses fallback controls", async () => {
    api.fetchAutomationStatus.mockResolvedValueOnce({
      ...baseStatus,
      computerUse: {
        ...computerStatus,
        enabled: true,
        state: "available",
        installed: true,
        degraded: true,
      },
    });

    render(<AutomationSettings token="tok" />);

    expect(
      await screen.findByText("Some controls are limited"),
    ).toBeInTheDocument();
  });
});
