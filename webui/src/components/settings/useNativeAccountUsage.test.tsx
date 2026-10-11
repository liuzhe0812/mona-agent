import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { developmentApi, type NativeAccountUsage } from "@/lib/development-api";
import { useNativeAccountUsage } from "./useNativeAccountUsage";

vi.mock("@/lib/development-api", () => ({
  developmentApi: {
    accountUsage: vi.fn(),
    accountUsageChanges: vi.fn(),
  },
}));

interface UsageChange { revision: number; identityChanged: boolean }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function usage(revision: number, email: string): NativeAccountUsage {
  return {
    revision,
    connected: true,
    email,
    planType: "plus",
    limits: [{ limitId: "weekly", primary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 2000 } }],
    credits: { balance: "4.00", hasCredits: true, unlimited: false },
    availableResets: 2,
    fetchedAt: revision * 1000,
    error: null,
  };
}

let usageRequests: ReturnType<typeof deferred<NativeAccountUsage>>[];
let changeRequests: ReturnType<typeof deferred<UsageChange>>[];

beforeEach(() => {
  vi.resetAllMocks();
  usageRequests = [];
  changeRequests = [];
  vi.mocked(developmentApi.accountUsage).mockImplementation(() => {
    const request = deferred<NativeAccountUsage>();
    usageRequests.push(request);
    return request.promise;
  });
  vi.mocked(developmentApi.accountUsageChanges).mockImplementation(() => {
    const request = deferred<UsageChange>();
    changeRequests.push(request);
    return request.promise;
  });
});

afterEach(() => {
  cleanup();
  usageRequests.forEach(request => request.resolve(usage(1, "late@example.test")));
  changeRequests.forEach(request => request.resolve({ revision: 1, identityChanged: false }));
});

describe("useNativeAccountUsage", () => {
  it("rechecks quota after a transport reconnect even when the server revision restarts", async () => {
    const hook = renderHook(() => useNativeAccountUsage(true, true, 0));
    await waitFor(() => expect(usageRequests).toHaveLength(1));
    await act(async () => usageRequests[0].resolve(usage(0, "first@example.test")));
    await waitFor(() => expect(changeRequests).toHaveLength(1));
    await act(async () => changeRequests[0].reject(new Error("server restarted")));
    await waitFor(() => expect(usageRequests).toHaveLength(2), { timeout: 1800 });
    await act(async () => usageRequests[1].resolve(usage(0, "new@example.test")));
    await waitFor(() => expect(hook.result.current.usage?.email).toBe("new@example.test"));
    hook.unmount();
  });

  it("reads initially, ignores unchanged revisions, and reads changed revisions", async () => {
    const hook = renderHook(() => useNativeAccountUsage(true, true, 0));
    await waitFor(() => expect(usageRequests).toHaveLength(1));
    await act(async () => usageRequests[0].resolve(usage(1, "first@example.test")));
    await waitFor(() => expect(changeRequests).toHaveLength(1));

    await act(async () => changeRequests[0].resolve({ revision: 1, identityChanged: false }));
    await waitFor(() => expect(changeRequests).toHaveLength(2));
    expect(usageRequests).toHaveLength(1);

    await act(async () => changeRequests[1].resolve({ revision: 2, identityChanged: false }));
    await waitFor(() => expect(usageRequests).toHaveLength(2));
    await act(async () => usageRequests[1].resolve(usage(2, "first@example.test")));
    await waitFor(() => expect(hook.result.current.usage?.revision).toBe(2));
    hook.unmount();
  });

  it("clears the prior identity before rereading, then clears immediately on disconnect", async () => {
    const hook = renderHook(
      ({ connected }) => useNativeAccountUsage(true, connected, 0),
      { initialProps: { connected: true } },
    );
    await waitFor(() => expect(usageRequests).toHaveLength(1));
    await act(async () => usageRequests[0].resolve(usage(1, "old@example.test")));
    await waitFor(() => expect(hook.result.current.usage?.email).toBe("old@example.test"));
    await waitFor(() => expect(changeRequests).toHaveLength(1));

    await act(async () => changeRequests[0].resolve({ revision: 2, identityChanged: true }));
    await waitFor(() => expect(usageRequests).toHaveLength(2));
    expect(hook.result.current.usage).toBeNull();
    await act(async () => usageRequests[1].resolve(usage(2, "new@example.test")));
    await waitFor(() => expect(hook.result.current.usage?.email).toBe("new@example.test"));

    hook.rerender({ connected: false });
    expect(hook.result.current.usage).toBeNull();
    hook.unmount();
  });

  it("ignores a late read after disconnect and does not start a hidden subscription", async () => {
    const hook = renderHook(
      ({ enabled, connected, refreshKey }) => useNativeAccountUsage(enabled, connected, refreshKey),
      { initialProps: { enabled: true, connected: true, refreshKey: 0 } },
    );
    await waitFor(() => expect(usageRequests).toHaveLength(1));
    hook.rerender({ enabled: true, connected: false, refreshKey: 0 });
    expect(hook.result.current.usage).toBeNull();
    await act(async () => usageRequests[0].resolve(usage(1, "stale@example.test")));
    expect(developmentApi.accountUsageChanges).not.toHaveBeenCalled();

    hook.rerender({ enabled: true, connected: true, refreshKey: 0 });
    await waitFor(() => expect(usageRequests).toHaveLength(2));
    await act(async () => usageRequests[1].resolve(usage(2, "current@example.test")));
    await waitFor(() => expect(hook.result.current.usage?.email).toBe("current@example.test"));
    await waitFor(() => expect(changeRequests).toHaveLength(1));

    hook.rerender({ enabled: false, connected: true, refreshKey: 1 });
    await act(async () => changeRequests[0].resolve({ revision: 3, identityChanged: false }));
    expect(developmentApi.accountUsage).toHaveBeenCalledTimes(2);
    expect(developmentApi.accountUsageChanges).toHaveBeenCalledTimes(1);

    hook.rerender({ enabled: true, connected: true, refreshKey: 1 });
    expect(hook.result.current.usage).toBeNull();
    await waitFor(() => expect(usageRequests).toHaveLength(3));
    expect(hook.result.current.usage).toBeNull();
    await act(async () => usageRequests[2].resolve(usage(4, "current@example.test")));
    await waitFor(() => expect(hook.result.current.usage?.revision).toBe(4));
    hook.unmount();
  });

  it("rereads when the explicit refresh key changes", async () => {
    const hook = renderHook(
      ({ refreshKey }) => useNativeAccountUsage(true, true, refreshKey),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(usageRequests).toHaveLength(1));
    await act(async () => usageRequests[0].resolve(usage(1, "account@example.test")));
    await waitFor(() => expect(changeRequests).toHaveLength(1));
    hook.rerender({ refreshKey: 1 });
    await waitFor(() => expect(usageRequests).toHaveLength(2));
    await act(async () => usageRequests[1].resolve(usage(2, "account@example.test")));
    await waitFor(() => expect(hook.result.current.usage?.revision).toBe(2));
    hook.unmount();
  });

  it("keeps the previous snapshot timestamp when a refresh fails", async () => {
    const hook = renderHook(
      ({ refreshKey }) => useNativeAccountUsage(true, true, refreshKey),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(usageRequests).toHaveLength(1));
    await act(async () => usageRequests[0].resolve(usage(1, "account@example.test")));
    await waitFor(() => expect(hook.result.current.usage?.fetchedAt).toBe(1000));

    hook.rerender({ refreshKey: 1 });
    await waitFor(() => expect(usageRequests).toHaveLength(2));
    await act(async () => usageRequests[1].reject(new Error("temporary network error")));
    await waitFor(() => expect(hook.result.current.error).toBe("temporary network error"));
    expect(hook.result.current.usage).toMatchObject({
      email: "account@example.test",
      fetchedAt: 1000,
      error: "temporary network error",
    });
    hook.unmount();
  });

  it("keeps quota only for the same identity when the API returns a successful error response", async () => {
    const hook = renderHook(
      ({ refreshKey }) => useNativeAccountUsage(true, true, refreshKey),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(usageRequests).toHaveLength(1));
    await act(async () => usageRequests[0].resolve(usage(1, "same@example.test")));
    await waitFor(() => expect(hook.result.current.usage?.fetchedAt).toBe(1000));

    hook.rerender({ refreshKey: 1 });
    await waitFor(() => expect(usageRequests).toHaveLength(2));
    await act(async () => usageRequests[1].resolve({
      ...usage(2, "same@example.test"),
      limits: [],
      credits: null,
      availableResets: null,
      fetchedAt: null,
      error: "quota unavailable",
    }));
    await waitFor(() => expect(hook.result.current.usage?.revision).toBe(2));
    expect(hook.result.current.usage).toMatchObject({
      email: "same@example.test",
      revision: 2,
      limits: [{ limitId: "weekly", primary: { usedPercent: 25 } }],
      credits: { balance: "4.00", hasCredits: true, unlimited: false },
      availableResets: 2,
      fetchedAt: 1000,
      error: "quota unavailable",
    });

    hook.rerender({ refreshKey: 2 });
    await waitFor(() => expect(usageRequests).toHaveLength(3));
    await act(async () => usageRequests[2].resolve({
      ...usage(3, "other@example.test"),
      limits: [],
      credits: null,
      availableResets: null,
      fetchedAt: null,
      error: "quota unavailable",
    }));
    await waitFor(() => expect(hook.result.current.usage?.email).toBe("other@example.test"));
    expect(hook.result.current.usage).toMatchObject({
      limits: [],
      credits: null,
      availableResets: null,
      fetchedAt: null,
      error: "quota unavailable",
    });
    hook.unmount();
  });
});
