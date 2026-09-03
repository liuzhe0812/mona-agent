import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ManagedRuntimeSettings } from "./ManagedRuntimeSettings";

const api = vi.hoisted(() => ({
  fetchManagedRuntimeStatus: vi.fn(),
  startManagedRuntimeInstall: vi.fn(),
  fetchManagedRuntimeInstallJob: vi.fn(),
  cancelManagedRuntimeInstall: vi.fn(),
  updateManagedRuntimeSettings: vi.fn(),
  cleanupManagedRuntimes: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

describe("ManagedRuntimeSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchManagedRuntimeStatus.mockResolvedValue({
      schemaVersion: 1,
      autoDownload: true,
      installEnabled: true,
      components: [
        {
          component: "python",
          available: true,
          packRef: "python-base@3.13.15",
          version: "3.13.15",
          downloadBytes: 20_000_000,
          installed: false,
          installedVersion: null,
          updateAvailable: false,
        },
      ],
      jobs: [],
    });
    api.startManagedRuntimeInstall.mockResolvedValue({
      ok: true,
      job: {
        schemaVersion: 1,
        jobId: "runtime-job",
        component: "python",
        packRef: "python-base@3.13.15",
        state: "completed",
        stage: "ready",
        downloadedBytes: 20_000_000,
        totalBytes: 20_000_000,
        createdAt: 1,
        updatedAt: 2,
      },
    });
    api.updateManagedRuntimeSettings.mockResolvedValue({ ok: true, autoDownload: false });
    api.cleanupManagedRuntimes.mockResolvedValue({
      ok: true,
      removedDownloads: 1,
      removedVersions: 0,
      freedBytes: 1024,
      removedLegacyBytes: 0,
    });
  });

  it("installs a runtime only after the user requests it", async () => {
    render(<ManagedRuntimeSettings token="tok" />);

    expect(api.startManagedRuntimeInstall).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(api.startManagedRuntimeInstall).toHaveBeenCalledWith("tok", "python", false);
    });
  });

  it("repairs an installed runtime by forcing redeployment", async () => {
    api.fetchManagedRuntimeStatus.mockResolvedValue({
      schemaVersion: 1,
      autoDownload: true,
      installEnabled: true,
      components: [{
        component: "python",
        available: true,
        packRef: "python-base@3.13.15",
        version: "3.13.15",
        downloadBytes: 20_000_000,
        installed: true,
        installedVersion: "3.13.15",
        updateAvailable: false,
      }],
      jobs: [],
    });

    render(<ManagedRuntimeSettings token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "Repair" }));

    await waitFor(() => {
      expect(api.startManagedRuntimeInstall).toHaveBeenCalledWith("tok", "python", true);
    });
  });

  it("persists the automatic download switch", async () => {
    render(<ManagedRuntimeSettings token="tok" />);
    const toggle = await screen.findByRole("switch", { name: "Download when needed" });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(api.updateManagedRuntimeSettings).toHaveBeenCalledWith("tok", false);
    });
  });

  it("cleans up managed resources from the settings page", async () => {
    render(<ManagedRuntimeSettings token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "Clear cache" }));

    await waitFor(() => {
      expect(api.cleanupManagedRuntimes).toHaveBeenCalledWith("tok");
      expect(api.fetchManagedRuntimeStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("shows when migrated resources can be cleaned up", async () => {
    api.fetchManagedRuntimeStatus.mockResolvedValueOnce({
      schemaVersion: 1,
      autoDownload: true,
      installEnabled: true,
      components: [],
      jobs: [],
      migration: {
        state: "completed",
        migratedComponents: ["python"],
        repairComponents: [],
        errors: [],
        legacyBytes: 2 * 1024 * 1024,
        cleanupAvailable: true,
        updatedAt: "2026-09-03T00:00:00Z",
      },
    });

    render(<ManagedRuntimeSettings token="tok" />);

    expect(await screen.findByText("Old resources have been organized. You can clear about 2 MB.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear old resources" })).toBeInTheDocument();
  });

  it("shows partial migration and repair notices without exposing component details", async () => {
    api.fetchManagedRuntimeStatus.mockResolvedValueOnce({
      schemaVersion: 1,
      autoDownload: true,
      installEnabled: true,
      components: [],
      jobs: [],
      migration: {
        state: "partial",
        migratedComponents: [],
        repairComponents: ["private-component-id"],
        errors: ["private-component-id: invalid receipt"],
        legacyBytes: 1,
        cleanupAvailable: false,
        updatedAt: "2026-09-03T00:00:00Z",
      },
    });

    render(<ManagedRuntimeSettings token="tok" />);

    expect(await screen.findByText("Some old resources are still in use. Organization will continue next time Mona starts.")).toBeInTheDocument();
    expect(screen.getByText("Some feature resources need repair.")).toBeInTheDocument();
    expect(screen.queryByText("private-component-id")).not.toBeInTheDocument();
  });

  it("resumes a failed download with the existing install action", async () => {
    api.fetchManagedRuntimeStatus.mockResolvedValue({
      schemaVersion: 1,
      autoDownload: true,
      installEnabled: true,
      components: [{
        component: "python",
        available: true,
        packRef: "python-base@3.13.15",
        version: "3.13.15",
        downloadBytes: 20_000_000,
        installed: false,
        installedVersion: null,
        updateAvailable: false,
      }],
      jobs: [{
        schemaVersion: 1,
        jobId: "failed-runtime-job",
        component: "python",
        packRef: "python-base@3.13.15",
        state: "failed",
        stage: "failed",
        downloadedBytes: 1_000,
        totalBytes: 20_000_000,
        error: "network unavailable",
        createdAt: 1,
        updatedAt: 2,
      }],
    });

    render(<ManagedRuntimeSettings token="tok" />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(api.startManagedRuntimeInstall).toHaveBeenCalledWith("tok", "python", false);
    });
  });
});
