import { beforeEach, describe, expect, it } from "vitest";
import { useBatchStore, type TransferSessionNode } from "./batchStore";
import type { BatchTransferProgress } from "../types/terminal";

const initial = useBatchStore.getInitialState();
function session(): TransferSessionNode {
  return {
    id: "host-one", host: "fixture", status: "waiting", expanded: true,
    files: ["a.txt", "b.txt"].map((filename) => ({ id: filename, filename, status: "waiting", speed: "-", eta: "-" })),
    progress: 0, completedCount: 0, totalCount: 2, totalBytes: 20, transferredBytes: 0, speed: "-", eta: "-",
  };
}
function progress(changes: Partial<BatchTransferProgress>): BatchTransferProgress {
  return { batchId: "batch-one", sessionId: "host-one", host: "fixture", status: "transferring", currentFile: "a.txt",
    filesCompleted: 0, filesTotal: 2, bytesTransferred: 0, bytesTotal: 20, speed: null, etaSeconds: null, error: null, ...changes };
}
beforeEach(() => {
  useBatchStore.setState({ ...initial, activeBatchId: "batch-one", transferSessions: [session()] }, true);
});

describe("batch upload progress", () => {
  it("keeps connecting nonterminal and moves file activity into transferring", () => {
    useBatchStore.getState().handleBatchProgress(progress({ status: "connecting", currentFile: null }));
    expect(useBatchStore.getState().transferSessions[0].files.map((file) => file.status)).toEqual(["waiting", "waiting"]);
    expect(useBatchStore.getState().activeBatchId).toBe("batch-one");
    useBatchStore.getState().handleBatchProgress(progress({}));
    expect(useBatchStore.getState().transferSessions[0].status).toBe("transferring");
  });

  it("preserves successful files when another file and the host fail", () => {
    useBatchStore.getState().handleBatchProgress(progress({ status: "completed", filesCompleted: 1, bytesTransferred: 10 }));
    useBatchStore.getState().handleBatchProgress(progress({ status: "error", currentFile: "b.txt", error: "fixture write failed", filesCompleted: 1, bytesTransferred: 10 }));
    useBatchStore.getState().handleBatchProgress(progress({ status: "error", currentFile: null, error: "fixture summary", filesCompleted: 1, bytesTransferred: 10 }));
    expect(useBatchStore.getState().transferSessions[0].files.map((file) => file.status)).toEqual(["completed", "error"]);
    expect(useBatchStore.getState().transferSessions[0].status).toBe("error");
    expect(useBatchStore.getState().activeBatchId).toBeNull();
  });

  it("ignores late events from another batch", () => {
    const before = useBatchStore.getState().transferSessions;
    useBatchStore.getState().handleBatchProgress(progress({ batchId: "old-batch", status: "completed", currentFile: null, filesCompleted: 2, bytesTransferred: 20 }));
    expect(useBatchStore.getState().transferSessions).toBe(before);
    expect(useBatchStore.getState().activeBatchId).toBe("batch-one");
  });

  it("keeps counters monotonic across out-of-order concurrent file events", () => {
    useBatchStore.getState().handleBatchProgress(progress({ currentFile: "b.txt", filesCompleted: 1, bytesTransferred: 17 }));
    useBatchStore.getState().handleBatchProgress(progress({ status: "completed", filesCompleted: 1, bytesTransferred: 10 }));
    useBatchStore.getState().handleBatchProgress(progress({ status: "error", currentFile: "b.txt", filesCompleted: 0, bytesTransferred: 0 }));
    const result = useBatchStore.getState().transferSessions[0];
    expect(result.completedCount).toBe(1);
    expect(result.transferredBytes).toBe(17);
    expect(result.progress).toBe(85);
    expect(result.files.map((file) => file.status)).toEqual(["completed", "error"]);
    expect(result.status).toBe("transferring");
  });

  it("keeps paused state on late progress and preserves completed files on cancellation", () => {
    const paused = session();
    paused.status = "paused";
    paused.files[0].status = "completed";
    paused.files[1].status = "paused";
    useBatchStore.setState({ transferSessions: [paused] });
    useBatchStore.getState().handleBatchProgress(progress({ currentFile: "b.txt" }));
    expect(useBatchStore.getState().transferSessions[0].status).toBe("paused");
    expect(useBatchStore.getState().transferSessions[0].files[1].status).toBe("paused");
    useBatchStore.getState().handleBatchProgress(progress({ status: "cancelled", currentFile: null, filesCompleted: 1, bytesTransferred: 10 }));
    expect(useBatchStore.getState().transferSessions[0].files.map((file) => file.status)).toEqual(["completed", "cancelled"]);
    expect(useBatchStore.getState().activeBatchId).toBeNull();
  });
});
