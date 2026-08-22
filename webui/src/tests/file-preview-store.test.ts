import { beforeEach, describe, expect, it } from "vitest";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";

describe("file preview owner state", () => {
  beforeEach(() => {
    useFilePreviewStore.setState({
      file: null,
      artifactBaseline: null,
      viewedArtifactPaths: new Set(),
      deletedArtifactPaths: new Set(),
      treeCollapsedByOwner: {},
      treeExpansionInitializedByOwner: {},
    });
  });

  it("keeps directory expansion per owner across preview unmounts", () => {
    const store = useFilePreviewStore.getState();
    store.toggleTreeDirectory("agent:mona:session:websocket:a", "reports");
    store.toggleTreeDirectory("agent:com.example.partner:session:websocket:b", "reports");

    const state = useFilePreviewStore.getState();
    expect(state.treeCollapsedByOwner["agent:mona:session:websocket:a"]).toEqual(["reports"]);
    expect(state.treeCollapsedByOwner["agent:com.example.partner:session:websocket:b"]).toEqual(["reports"]);
  });

  it("collapses newly discovered directories by default", () => {
    const store = useFilePreviewStore.getState();
    store.initializeTreeDirectories("owner", ["reports", "reports/raw"]);

    expect(useFilePreviewStore.getState().treeCollapsedByOwner.owner).toEqual([
      "reports",
      "reports/raw",
    ]);

    store.toggleTreeDirectory("owner", "reports");
    store.initializeTreeDirectories("owner", ["reports", "reports/raw", "exports"]);

    expect(useFilePreviewStore.getState().treeCollapsedByOwner.owner).toEqual([
      "reports/raw",
      "exports",
    ]);
  });

  it("resets transient inventory when context changes but keeps deletion tombstones", () => {
    const store = useFilePreviewStore.getState();
    store.observeArtifactInventory(["report.md"]);
    store.markArtifactDeleted("C:/workspace/agent-workspaces/mona/output/old.md");
    store.open({
      path: "new.md",
      absolute_path: "C:/workspace/agent-workspaces/mona/output/new.md",
      name: "new.md",
      size: 1,
      size_human: "1 B",
      mime: "text/markdown",
    });

    store.resetArtifactInventory();
    const state = useFilePreviewStore.getState();
    expect(state.artifactBaseline).toBeNull();
    expect(state.viewedArtifactPaths.size).toBe(0);
    expect(state.deletedArtifactPaths).toEqual(
      new Set(["C:/workspace/agent-workspaces/mona/output/old.md"]),
    );
  });
});
