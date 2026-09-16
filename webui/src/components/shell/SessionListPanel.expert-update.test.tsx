import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchCatalog: vi.fn(),
  fetchJob: vi.fn(),
  startInstall: vi.fn(),
  invalidateAgents: vi.fn(),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClientContextOrNull: () => ({ token: "tok" }),
}));

vi.mock("@/components/room/useAgents", () => ({
  invalidateAgents: mocks.invalidateAgents,
  useAgents: () => new Map([
    ["mona", { id: "mona", displayName: "Mona", enabled: true }],
    ["com.mona.musician", {
      id: "com.mona.musician",
      displayName: "Musician",
      enabled: true,
      packageVersion: "1.0.3",
    }],
  ]),
}));

vi.mock("@/lib/api", () => ({
  fetchExpertCatalog: mocks.fetchCatalog,
  fetchExpertInstallJob: mocks.fetchJob,
  startExpertInstall: mocks.startInstall,
}));

import { SessionListPanel } from "./SessionListPanel";

const update = {
  id: "com.mona.musician",
  displayName: "Musician",
  description: "Music",
  version: "1.2.0",
  downloadBytes: 10,
  runtimePacks: [],
  requiredTools: ["guitar_tab"],
  installed: true,
  installedVersion: "1.0.3",
  updateAvailable: true,
  compatible: true,
};

describe("SessionListPanel expert updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchCatalog
      .mockResolvedValueOnce({
        schemaVersion: 1,
        generatedAt: null,
        source: "remote",
        stale: false,
        installEnabled: true,
        experts: [update],
      })
      .mockResolvedValue({
        schemaVersion: 1,
        generatedAt: null,
        source: "remote",
        stale: false,
        installEnabled: true,
        experts: [{ ...update, updateAvailable: false, installedVersion: "1.2.0" }],
      });
    mocks.startInstall.mockResolvedValue({
      ok: true,
      job: {
        schemaVersion: 1,
        jobId: "job-1",
        expertId: update.id,
        version: update.version,
        state: "completed",
        stage: "ready",
        downloadedBytes: 10,
        totalBytes: 10,
        detail: "",
        installedVersion: update.version,
        createdAt: 1,
        updatedAt: 2,
        finishedAt: 2,
      },
    });
  });

  it("shows and runs an available update beside the matching Agent", async () => {
    render(
      <SessionListPanel
        sessions={[]}
        activeKey={null}
        loading={false}
        onSelect={vi.fn()}
        onRequestDelete={vi.fn()}
        onTogglePin={vi.fn()}
        onRequestRename={vi.fn()}
        onToggleArchive={vi.fn()}
        onMarkAllRead={vi.fn()}
        onToggleArchived={vi.fn()}
        onStartDirect={vi.fn()}
        onSelectAgent={vi.fn()}
        onOpenExpertLibrary={vi.fn()}
        onNewRoom={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Create conversation" }), { key: "Enter" });
    const updateButton = await screen.findByRole("button", { name: "Update Musician" });
    expect(updateButton).toHaveClass("h-7", "w-7");
    expect(updateButton).not.toHaveTextContent("Update");
    expect(updateButton.querySelector("svg")).not.toBeNull();
    fireEvent.click(updateButton);

    await waitFor(() => expect(mocks.invalidateAgents).toHaveBeenCalledOnce());
    expect(mocks.startInstall).toHaveBeenCalledWith("tok", update.id, update.version);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Update Musician" })).not.toBeInTheDocument());
  });
});
