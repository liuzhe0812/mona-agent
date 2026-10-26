import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const api = vi.hoisted(() => ({ create: vi.fn(), compare: vi.fn(), request: vi.fn(), operation: vi.fn(), onError: vi.fn() }));
vi.mock("../lib/api", () => ({ api: { createAlphaBench: api.create, createAlphaCompare: api.compare } }));
vi.mock("@/lib/stock-vibe-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-api")>(), getStockVibeRequest: api.request, getStockVibeOperation: api.operation }));
import { NativeErrorProvider } from "../lib/toast";
import { useAlphaJob } from "./useAlphaJob";
import type { AlphaBenchResult } from "../lib/api";
function wrapper({ children }: { children: ReactNode }) { return <NativeErrorProvider onError={api.onError}>{children}</NativeErrorProvider>; }
const body = { zoo: "alpha101", universe: "csi300", period: "2020-2025", top: 20 };
const output = { alive: 12, reversed: 3, dead: 8, skipped: 2, n_alphas_tested: 23, top5_by_ir: [], dead_examples: [], by_theme: {} };
function receipt(id: string) { return { request_id: id, method: "POST", path: "/mona/operations", status: "completed", receipt_sha256: "b".repeat(64), receipt: { status_code: 201, body: { operation_id: "alpha-operation" } } }; }
beforeEach(() => { localStorage.clear(); Object.values(api).forEach((mock) => mock.mockReset()); api.create.mockImplementation(async (request: { request_id: string }) => receipt(request.request_id)); api.request.mockResolvedValue({ status: "unknown" }); api.operation.mockResolvedValue({ native: { operation_id: "alpha-operation", operation: "alpha_bench", status: "completed", tool_result: output } }); });
describe("durable native factor jobs", () => {
  it("dispatches once and reads the original completed result without inventing counters", async () => {
    const hook = renderHook(() => useAlphaJob<AlphaBenchResult>("bench", "source-result"), { wrapper });
    await act(async () => { await hook.result.current.submit(body); });
    await waitFor(() => expect(hook.result.current.status).toBe("done"));
    expect(api.create).toHaveBeenCalledOnce(); expect(api.operation).toHaveBeenCalledWith("alpha-operation"); expect(hook.result.current.result).toEqual(output); expect(hook.result.current.progress).toBeNull(); expect(api.onError).not.toHaveBeenCalled();
  });
  it("recovers a lost POST through GET receipts on remount and never repeats the write", async () => {
    api.create.mockRejectedValue(new Error("lost response"));
    const first = renderHook(() => useAlphaJob<AlphaBenchResult>("bench", "unknown"), { wrapper });
    await act(async () => { await first.result.current.submit(body); }); const requestId = api.create.mock.calls[0][0].request_id;
    expect(first.result.current.busy).toBe(true); first.unmount();
    api.request.mockImplementation(async () => receipt(requestId));
    const second = renderHook(() => useAlphaJob<AlphaBenchResult>("bench", "unknown"), { wrapper });
    await waitFor(() => expect(second.result.current.status).toBe("done")); expect(api.request).toHaveBeenCalledWith(requestId); expect(api.create).toHaveBeenCalledOnce(); expect(second.result.current.result).toEqual(output);
  });
  it("refuses a mismatched operation result and leaves recovery read-only", async () => {
    localStorage.setItem("mona.stock-vibe.native-alpha-job.v1:bench:identity", JSON.stringify({ jobId: "alpha-operation", request: body, pendingRequest: null }));
    api.operation.mockResolvedValue({ native: { operation_id: "other", operation: "alpha_compare", status: "completed", tool_result: output } });
    const hook = renderHook(() => useAlphaJob<AlphaBenchResult>("bench", "identity"), { wrapper }); await waitFor(() => expect(hook.result.current.status).toBe("disconnected"));
    expect(hook.result.current.result).toBeNull(); expect(api.create).not.toHaveBeenCalled(); expect(api.compare).not.toHaveBeenCalled();
  });
});
