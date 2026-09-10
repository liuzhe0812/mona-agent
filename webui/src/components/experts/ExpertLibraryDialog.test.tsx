import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExpertLibraryDialog } from "./ExpertLibraryDialog";

const api = vi.hoisted(() => ({
  fetchExpertCatalog: vi.fn(),
  startExpertInstall: vi.fn(),
  fetchExpertInstallJob: vi.fn(),
  cancelExpertInstall: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/components/room/useAgents", () => ({ invalidateAgents: vi.fn() }));

const expert = {
  id: "com.mona.academic-researcher",
  displayName: "科研专家",
  description: "检索与分析科研文献",
  version: "1.0.0",
  downloadBytes: 1024,
  runtimePacks: ["python-base@3.12"],
  requiredTools: [],
  installed: false,
  installedVersion: null,
  updateAvailable: false,
  compatible: true,
  unavailableReason: null,
};

const completedJob = {
  schemaVersion: 1,
  jobId: "job-1",
  expertId: expert.id,
  version: expert.version,
  state: "completed" as const,
  stage: "ready",
  downloadedBytes: 1024,
  totalBytes: 1024,
  detail: "",
  installedVersion: expert.version,
  createdAt: 1,
  updatedAt: 2,
};

describe("ExpertLibraryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchExpertCatalog
      .mockResolvedValueOnce({
        schemaVersion: 1,
        generatedAt: "2026-08-29T00:00:00Z",
        source: "remote",
        stale: false,
        installEnabled: true,
        experts: [expert],
      })
      .mockResolvedValue({
        schemaVersion: 1,
        generatedAt: "2026-08-29T00:00:00Z",
        source: "remote",
        stale: false,
        installEnabled: true,
        experts: [{ ...expert, installed: true, installedVersion: expert.version }],
      });
    api.startExpertInstall.mockResolvedValue({ ok: true, job: completedJob });
  });

  it("creates no conversation until installation has completed", async () => {
    const onStartDirect = vi.fn();
    render(
      <ExpertLibraryDialog
        open
        token="tok"
        onOpenChange={vi.fn()}
        onStartDirect={onStartDirect}
      />,
    );

    const expertTitle = await screen.findByText("科研专家");
    expect(
      document.querySelector('img[src="/brand/agents/academic-researcher.png"]'),
    ).toBeInTheDocument();
    expect(
      expertTitle.compareDocumentPosition(screen.getByText("Custom expert"))
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Download and use" }));
    expect(onStartDirect).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start chat" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    expect(onStartDirect).toHaveBeenCalledWith(expert.id, expert.displayName);
  });

  it("shows an unavailable state instead of a request error", async () => {
    api.fetchExpertCatalog.mockReset().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: null,
      source: "unavailable",
      stale: false,
      installEnabled: false,
      installUnavailableReason: "official_catalog_unavailable",
      experts: [],
    });

    render(
      <ExpertLibraryDialog
        open
        token="tok"
        onOpenChange={vi.fn()}
        onStartDirect={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("No official experts are currently available"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/503/)).not.toBeInTheDocument();
  });

  it("keeps the custom expert action available when the official catalog is unavailable", async () => {
    api.fetchExpertCatalog.mockReset().mockResolvedValue({
      schemaVersion: 1,
      generatedAt: null,
      source: "unavailable",
      stale: false,
      installEnabled: false,
      installUnavailableReason: "official_catalog_unavailable",
      experts: [],
    });
    const onOpenChange = vi.fn();
    const onCreateCustom = vi.fn();

    render(
      <ExpertLibraryDialog
        open
        token="tok"
        onOpenChange={onOpenChange}
        onStartDirect={vi.fn()}
        onCreateCustom={onCreateCustom}
      />,
    );

    const customAction = await screen.findByRole("button", { name: "New" });
    expect(customAction).toBeEnabled();
    expect(screen.getByText("No official experts are currently available")).toBeInTheDocument();

    fireEvent.click(customAction);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreateCustom).toHaveBeenCalledOnce();
  });
});
