import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommitDetail, GitGraphCommit } from "./git-actions-api";
import { DevelopmentGitGraph } from "./DevelopmentGitGraph";

const api = vi.hoisted(() => ({ graph: vi.fn(), commitDetail: vi.fn() }));
vi.mock("./git-actions-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./git-actions-api")>()), gitActionsApi: { graph: api.graph, commitDetail: api.commitDetail } }));

const session = { id: "dev_graph" };
const first: GitGraphCommit = { hash: "a1234567890", parents: ["b1234567890"], refs: [{ name: "main", kind: "head" }], subject: "Fix branch handling", authorName: "Mona", authoredAtMs: 1_760_000_000_000 };
const second: GitGraphCommit = { hash: "b1234567890", parents: [], refs: [], subject: "Initial commit", authorName: "Mona", authoredAtMs: 1_759_000_000_000 };
const detail: GitCommitDetail = { commit: first, body: "Keep branch changes safe.", files: [{ path: "src/branch.ts", status: "M", additions: 2, deletions: 1 }], diff: "" };

beforeEach(() => {
  vi.clearAllMocks();
  api.graph.mockImplementation(async (_session: string, skip: number) => skip === 0 ? { commits: [first], hasMore: true } : { commits: [second], hasMore: false });
  api.commitDetail.mockImplementation(async (_session: string, _hash: string, path?: string) => path ? { ...detail, diff: "diff --git a/src/branch.ts b/src/branch.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line" } : detail);
});
afterEach(cleanup);

describe("DevelopmentGitGraph", () => {
  it("loads pages and opens real commit metadata, changed files, and a file diff", async () => {
    render(<DevelopmentGitGraph session={session} open onOpenChange={vi.fn()} />);
    expect(await screen.findByText("Fix branch handling")).toBeInTheDocument();
    expect(api.graph).toHaveBeenCalledWith(session.id, 0);

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("Initial commit")).toBeInTheDocument();
    expect(api.graph).toHaveBeenCalledWith(session.id, 1);

    fireEvent.click(screen.getByRole("button", { name: /Fix branch handling/ }));
    expect(await screen.findByText("Keep branch changes safe.")).toBeInTheDocument();
    expect(api.commitDetail).toHaveBeenCalledWith(session.id, first.hash);

    fireEvent.click(screen.getByRole("button", { name: /src\/branch.ts/ }));
    await waitFor(() => expect(api.commitDetail).toHaveBeenCalledWith(session.id, first.hash, "src/branch.ts"));
    expect(await screen.findByText("+new")).toBeInTheDocument();
  });
});
