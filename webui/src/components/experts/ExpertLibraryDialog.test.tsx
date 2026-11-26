import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExpertLibraryDialog } from "./ExpertLibraryDialog";
import { ClientProvider } from "@/providers/ClientProvider";
import type { MonaClient } from "@/lib/mona-client";

const api = vi.hoisted(() => ({
  fetchExpertCatalog: vi.fn(),
  startExpertInstall: vi.fn(),
  fetchExpertInstallJob: vi.fn(),
  listExpertInstallJobs: vi.fn(),
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
    api.fetchExpertCatalog.mockReset()
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
    api.startExpertInstall.mockReset().mockResolvedValue({ ok: true, job: completedJob });
    api.fetchExpertInstallJob.mockReset();
    api.listExpertInstallJobs.mockReset();
    api.cancelExpertInstall.mockReset();
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
      expertTitle.compareDocumentPosition(screen.getByText("Custom partner"))
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Download and use" }));
    expect(onStartDirect).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start chat" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    expect(onStartDirect).toHaveBeenCalledWith(expert.id, expert.displayName);
  });

  it("uses the refreshed catalog after a previously completed install is deleted", async () => {
    const onOpenChange = vi.fn();
    const dialog = (open: boolean) => (
      <ExpertLibraryDialog open={open} token="tok" onOpenChange={onOpenChange} onStartDirect={vi.fn()} />
    );
    const { rerender } = render(dialog(true));

    fireEvent.click(await screen.findByRole("button", { name: "Download and use" }));
    expect(await screen.findByRole("button", { name: "Start chat" })).toBeInTheDocument();

    api.fetchExpertCatalog.mockReset().mockResolvedValue({
      schemaVersion: 1,
      source: "remote",
      stale: false,
      installEnabled: true,
      experts: [expert],
    });
    rerender(dialog(false));
    rerender(dialog(true));

    expect(await screen.findByRole("button", { name: "Download and use" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start chat" })).not.toBeInTheDocument();
    expect(screen.queryByText("Installed")).not.toBeInTheDocument();
  });

  it("does not keep an installed result when a reopened catalog cannot be refreshed", async () => {
    api.fetchExpertCatalog.mockReset()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        source: "remote",
        stale: false,
        installEnabled: true,
        experts: [expert],
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        source: "remote",
        stale: false,
        installEnabled: true,
        experts: [{ ...expert, installed: true, installedVersion: expert.version }],
      })
      .mockRejectedValue(new Error("service unavailable"));
    const dialog = (open: boolean) => (
      <ExpertLibraryDialog open={open} token="tok" onOpenChange={vi.fn()} onStartDirect={vi.fn()} />
    );
    const { rerender } = render(dialog(true));

    fireEvent.click(await screen.findByRole("button", { name: "Download and use" }));
    expect(await screen.findByRole("button", { name: "Start chat" })).toBeInTheDocument();
    rerender(dialog(false));
    rerender(dialog(true));

    expect(await screen.findByText("Could not load the partner list")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start chat" })).not.toBeInTheDocument();
    expect(screen.queryByText("Installed")).not.toBeInTheDocument();
    expect(screen.queryByText("No matching partners")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("refreshes installation state when an agent is changed while the dialog is open", async () => {
    const handlers = new Set<(agentId: string, event: "agents_updated") => void>();
    const client = {
      onAgentsUpdated: (handler: (agentId: string, event: "agents_updated") => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    } as unknown as MonaClient;
    api.fetchExpertCatalog.mockReset()
      .mockResolvedValueOnce({
        schemaVersion: 1,
        source: "remote",
        stale: false,
        installEnabled: true,
        experts: [expert],
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        source: "remote",
        stale: false,
        installEnabled: true,
        experts: [{ ...expert, installed: true, installedVersion: expert.version }],
      })
      .mockResolvedValue({
        schemaVersion: 1,
        source: "remote",
        stale: false,
        installEnabled: true,
        experts: [expert],
      });
    render(
      <ClientProvider client={client} token="tok" runtimeStatus="ready">
        <ExpertLibraryDialog open token="tok" onOpenChange={vi.fn()} onStartDirect={vi.fn()} />
      </ClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Download and use" }));
    expect(await screen.findByRole("button", { name: "Start chat" })).toBeInTheDocument();
    act(() => { for (const handler of handlers) handler(expert.id, "agents_updated"); });

    expect(await screen.findByRole("button", { name: "Download and use" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start chat" })).not.toBeInTheDocument();
  });

  it("does not let an earlier catalog response overwrite an agent update", async () => {
    const handlers = new Set<(agentId: string, event: "agents_updated") => void>();
    const client = {
      onAgentsUpdated: (handler: (agentId: string, event: "agents_updated") => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    } as unknown as MonaClient;
    let resolveOld!: (value: unknown) => void;
    const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
    const current = {
      schemaVersion: 1,
      source: "remote",
      stale: false,
      installEnabled: true,
      experts: [expert],
    };
    api.fetchExpertCatalog.mockReset().mockReturnValueOnce(oldResponse).mockResolvedValue(current);
    render(
      <ClientProvider client={client} token="tok" runtimeStatus="ready">
        <ExpertLibraryDialog open token="tok" onOpenChange={vi.fn()} onStartDirect={vi.fn()} />
      </ClientProvider>,
    );

    act(() => { for (const handler of handlers) handler(expert.id, "agents_updated"); });
    expect(await screen.findByRole("button", { name: "Download and use" })).toBeEnabled();
    await act(async () => {
      resolveOld({ ...current, experts: [{ ...expert, installed: true, installedVersion: expert.version }] });
      await oldResponse;
    });
    expect(screen.getByRole("button", { name: "Download and use" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start chat" })).not.toBeInTheDocument();
  });

  it("keeps an installed partner available when its update is incompatible", async () => {
    const onStartDirect = vi.fn();
    api.fetchExpertCatalog.mockReset().mockResolvedValue({
      schemaVersion: 1,
      source: "cache",
      stale: true,
      installEnabled: true,
      experts: [{ ...expert, installed: true, installedVersion: "0.9.0", updateAvailable: true,
        compatible: false, unavailableReason: "Update unavailable" }],
    });
    render(<ExpertLibraryDialog open token="tok" onOpenChange={vi.fn()} onStartDirect={onStartDirect} />);

    const start = await screen.findByRole("button", { name: "Start chat" });
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
    expect(screen.getByText("Installed v0.9.0")).toBeVisible();
    expect(screen.getByText("Update unavailable")).toBeVisible();
    expect(screen.getByText("Showing the previously loaded partner list.")).toBeVisible();
    fireEvent.click(start);
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
      await screen.findByText("No official partners are currently available"),
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

    const customAction = await screen.findByRole("button", { name: "Custom partner" });
    expect(customAction).toBeEnabled();
    expect(customAction).toHaveClass("hover:bg-accent", "focus-visible:ring-1");
    expect(customAction.parentElement).toHaveClass("justify-end");
    expect(screen.queryByRole("button", { name: "New" })).not.toBeInTheDocument();
    expect(screen.getByText("No official partners are currently available")).toBeInTheDocument();

    fireEvent.click(customAction);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreateCustom).toHaveBeenCalledOnce();
  });

  it("keeps the catalog and offers retry for a confirmed installation failure", async () => {
    api.startExpertInstall.mockResolvedValueOnce({
      ok: true,
      job: { ...completedJob, state: "failed", stage: "failed", error: "internal transport error" },
    });
    render(<ExpertLibraryDialog open token="tok" onOpenChange={vi.fn()} onStartDirect={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Download and use" }));
    expect(await screen.findByText("Installation did not complete. Please try again.")).toBeVisible();
    expect(screen.getByText(expert.displayName)).toBeVisible();
    expect(screen.queryByText("internal transport error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(api.startExpertInstall).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("button", { name: "Start chat" })).toBeVisible();
  });

  it("checks an unconfirmed running job without starting another installation", async () => {
    const runningJob = { ...completedJob, state: "running", stage: "downloading" };
    api.startExpertInstall.mockResolvedValueOnce({ ok: true, job: runningJob });
    api.fetchExpertInstallJob
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce({ job: completedJob });
    const catalog = { schemaVersion: 1, source: "remote", stale: false, installEnabled: true, experts: [expert] };
    api.fetchExpertCatalog.mockReset()
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(catalog)
      .mockResolvedValue({ ...catalog, experts: [{ ...expert, installed: true, installedVersion: expert.version }] });
    const dialog = (open: boolean) => (
      <ExpertLibraryDialog open={open} token="tok" onOpenChange={vi.fn()} onStartDirect={vi.fn()} />
    );
    const { rerender } = render(dialog(true));

    fireEvent.click(await screen.findByRole("button", { name: "Download and use" }));
    await screen.findByRole("button", { name: "Check status" }, { timeout: 2500 });
    expect(screen.getByText("The installation status could not be confirmed. Check the status before continuing.")).toBeVisible();
    expect(screen.getByText(expert.displayName)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Download and use" })).not.toBeInTheDocument();
    rerender(dialog(false));
    rerender(dialog(true));
    fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
    expect(await screen.findByRole("button", { name: "Start chat" }, { timeout: 2500 })).toBeVisible();
    expect(api.startExpertInstall).toHaveBeenCalledOnce();
    expect(api.fetchExpertInstallJob).toHaveBeenCalledTimes(2);
  });

  it("checks an unconfirmed start without treating an old job as its result", async () => {
    const runningJob = { ...completedJob, jobId: "active", version: "0.9.0", state: "running", stage: "downloading" };
    api.startExpertInstall.mockRejectedValueOnce(new Error("request timeout"));
    api.listExpertInstallJobs
      .mockResolvedValueOnce({ jobs: [completedJob] })
      .mockResolvedValueOnce({ jobs: [runningJob] });
    api.fetchExpertInstallJob.mockResolvedValue({ job: { ...completedJob, jobId: runningJob.jobId } });
    const catalog = { schemaVersion: 1, source: "remote", stale: false, installEnabled: true, experts: [expert] };
    api.fetchExpertCatalog.mockReset()
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(catalog)
      .mockResolvedValue({ ...catalog, experts: [{ ...expert, installed: true, installedVersion: expert.version }] });
    const dialog = (open: boolean) => (
      <ExpertLibraryDialog open={open} token="tok" onOpenChange={vi.fn()} onStartDirect={vi.fn()} />
    );
    const { rerender } = render(dialog(true));

    fireEvent.click(await screen.findByRole("button", { name: "Download and use" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
    expect(await screen.findByText("No matching installation record was found. Retry or check again shortly.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(api.startExpertInstall).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Download and use" })).not.toBeInTheDocument();
    rerender(dialog(false));
    rerender(dialog(true));
    fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
    expect(await screen.findByRole("button", { name: "Start chat" }, { timeout: 2500 })).toBeVisible();
    expect(api.startExpertInstall).toHaveBeenCalledOnce();
    expect(api.fetchExpertInstallJob).toHaveBeenCalledWith("tok", runningJob.jobId);
  });

  it("retries an unconfirmed start only after a successful empty job check and user action", async () => {
    api.startExpertInstall.mockRejectedValueOnce(new Error("request timeout"));
    api.listExpertInstallJobs.mockResolvedValue({ jobs: [] });
    render(<ExpertLibraryDialog open token="tok" onOpenChange={vi.fn()} onStartDirect={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Download and use" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(api.startExpertInstall).toHaveBeenCalledOnce();
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Start chat" })).toBeVisible();
    expect(api.startExpertInstall).toHaveBeenCalledTimes(2);
  });

  it("refreshes an obsolete catalog version and waits for explicit retry", async () => {
    const oldCatalog = {
      schemaVersion: 1, source: "cache", stale: true, installEnabled: true, experts: [expert],
    };
    const updatedExpert = { ...expert, version: "2.0.0" };
    const updatedCatalog = { ...oldCatalog, source: "remote", stale: false, experts: [updatedExpert] };
    api.fetchExpertCatalog.mockReset()
      .mockResolvedValueOnce(oldCatalog)
      .mockResolvedValueOnce(oldCatalog)
      .mockResolvedValueOnce(updatedCatalog)
      .mockResolvedValue({
        ...updatedCatalog,
        experts: [{ ...updatedExpert, installed: true, installedVersion: updatedExpert.version }],
      });
    api.startExpertInstall
      .mockResolvedValueOnce({
        ok: true,
        job: { ...completedJob, state: "failed", stage: "failed", errorCode: "catalog_version_unavailable" },
      })
      .mockResolvedValueOnce({ ok: true, job: { ...completedJob, version: updatedExpert.version } });
    render(<ExpertLibraryDialog open token="tok" onOpenChange={vi.fn()} onStartDirect={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Download and use" }));
    expect(await screen.findByText("The partner version has changed. Check the current version before trying again.")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh list" }));
    expect(await screen.findByText("v2.0.0")).toBeVisible();
    expect(api.startExpertInstall).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(api.startExpertInstall).toHaveBeenLastCalledWith("tok", expert.id, updatedExpert.version);
    expect(await screen.findByRole("button", { name: "Start chat" })).toBeVisible();
  });
});
