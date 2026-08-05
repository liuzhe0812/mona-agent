import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThreeReviewPanel } from "./ThreeReviewPanel";
import type { ThreeCandidateDiff } from "./threeState";

const { fetchCandidateDiffMock, applyCandidateMock, discardCandidateMock } = vi.hoisted(() => ({
  fetchCandidateDiffMock: vi.fn(),
  applyCandidateMock: vi.fn(),
  discardCandidateMock: vi.fn(),
}));

vi.mock("./threeState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./threeState")>();
  return {
    ...actual,
    fetchCandidateDiff: fetchCandidateDiffMock,
    applyCandidate: applyCandidateMock,
    discardCandidate: discardCandidateMock,
  };
});

const noop = () => {};

function renderPanel(overrides: Partial<Parameters<typeof ThreeReviewPanel>[0]> = {}) {
  return render(
    <ThreeReviewPanel
      projectName="demo"
      components={[]}
      specPresent={true}
      candidatePresent={false}
      onCandidateResolved={noop}
      {...overrides}
    />,
  );
}

const DIFF: ThreeCandidateDiff = {
  specHash: "a".repeat(64),
  candidateBaseHash: "a".repeat(64),
  stale: false,
  truncated: false,
  changes: [
    { path: "componentTree[0].primitive", kind: "changed", before: "box", after: "cylinder" },
    { path: "materials", kind: "added", before: null, after: [{ id: "steel" }] },
  ],
};

describe("ThreeReviewPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchCandidateDiffMock.mockResolvedValue(DIFF);
    applyCandidateMock.mockResolvedValue(undefined);
    discardCandidateMock.mockResolvedValue(undefined);
  });

  it("renders the component tree with display names", () => {
    renderPanel({
      components: [
        { id: "body", name: "主体", role: "core", primitive: "box" },
        { id: "handle", name: "把手", role: "handle", primitive: "cylinder" },
      ],
    });
    expect(screen.getByText("主体")).toBeTruthy();
    expect(screen.getByText(/body · core · box/)).toBeTruthy();
    expect(screen.getByText("把手")).toBeTruthy();
  });

  it("shows an empty hint when the spec has no components", () => {
    renderPanel({ specPresent: false });
    expect(screen.getByText(/暂无组件/)).toBeTruthy();
  });

  it("loads and displays candidate field differences", async () => {
    renderPanel({ candidatePresent: true });
    expect(await screen.findByText("componentTree[0].primitive")).toBeTruthy();
    expect(screen.getByText("materials")).toBeTruthy();
    expect(screen.getByText(/box → cylinder/)).toBeTruthy();
    expect(fetchCandidateDiffMock).toHaveBeenCalledWith("demo");
  });

  it("applies the candidate and refreshes state", async () => {
    const onResolved = vi.fn();
    renderPanel({ candidatePresent: true, onCandidateResolved: onResolved });
    const applyButton = await screen.findByRole("button", { name: "应用" });
    await userEvent.click(applyButton);
    await waitFor(() => expect(applyCandidateMock).toHaveBeenCalledWith("demo"));
    expect(onResolved).toHaveBeenCalled();
  });

  it("discards the candidate and refreshes state", async () => {
    const onResolved = vi.fn();
    renderPanel({ candidatePresent: true, onCandidateResolved: onResolved });
    const discardButton = await screen.findByRole("button", { name: "放弃" });
    await userEvent.click(discardButton);
    await waitFor(() => expect(discardCandidateMock).toHaveBeenCalledWith("demo"));
    expect(onResolved).toHaveBeenCalled();
  });

  it("blocks apply when the candidate is stale", async () => {
    fetchCandidateDiffMock.mockResolvedValue({ ...DIFF, stale: true, changes: [] });
    renderPanel({ candidatePresent: true });
    expect(await screen.findByText(/候选已过期/)).toBeTruthy();
    const applyButton = screen.getByRole("button", { name: "应用" });
    expect(applyButton).toHaveProperty("disabled", true);
  });
});
