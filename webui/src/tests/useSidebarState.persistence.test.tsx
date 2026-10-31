import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { markSessionRead, useSidebarState } from "@/hooks/useSidebarState";
import { ClientProvider } from "@/providers/ClientProvider";
import type { ChatSummary } from "@/lib/types";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchSidebarState: vi.fn(),
    updateSidebarState: vi.fn(),
  };
});

import { fetchSidebarState, updateSidebarState } from "@/lib/api";

const mockedFetch = vi.mocked(fetchSidebarState);
const mockedUpdate = vi.mocked(updateSidebarState);

const SERVER_STATE = {
  schema_version: 5 as const,
  pinned_keys: [],
  last_read_at_by_key: {
    "websocket:a": "2026-09-11T09:00:00",
    "websocket:b": "2026-09-11T08:00:00",
  },
};

function session(key: string, previewAt: string): ChatSummary {
  return {
    key,
    channel: "websocket",
    chatId: key.replace("websocket:", ""),
    createdAt: null,
    updatedAt: previewAt,
    title: key,
    preview: "p",
    previewAt,
    previewAuthorType: "agent",
  };
}

const SESSIONS: ChatSummary[] = [
  session("websocket:a", "2026-09-11T09:00:00"),
  session("websocket:b", "2026-09-11T08:00:00"),
];

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ClientProvider client={null} token="tok" runtimeStatus="ready">
      {children}
    </ClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSidebarState persistence guards (unread markers survive restarts)", () => {
  it("retries a transient load failure instead of latching an empty baseline", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("HTTP 502"));
    mockedFetch.mockResolvedValueOnce(SERVER_STATE);

    const { result } = renderHook(() => useSidebarState(SESSIONS, true), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state.last_read_at_by_key).toEqual(
      SERVER_STATE.last_read_at_by_key,
    );
  });

  it("never persists while the baseline is unverified (failed load)", async () => {
    mockedFetch.mockRejectedValue(new Error("HTTP 502"));

    const { result } = renderHook(() => useSidebarState(SESSIONS, true), { wrapper });

    // The initial burst (1 + 3 retries) failed: the baseline stays unknown.
    await waitFor(
      () => expect(mockedFetch.mock.calls.length).toBeGreaterThanOrEqual(4),
      { timeout: 6_000 },
    );
    mockedUpdate.mockClear();

    // The user opens a session; App marks it read via update().
    await act(async () => {
      await result.current.update((current) =>
        markSessionRead(current, "websocket:a", "2026-09-11T09:00:00"),
      );
    });

    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("does not prune markers while the session list is empty", async () => {
    mockedFetch.mockResolvedValue(SERVER_STATE);
    mockedUpdate.mockImplementation(async (_token, state) => state);

    const { result } = renderHook(() => useSidebarState([], true), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Give the prune effect a chance to run.
    await act(async () => {});

    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(result.current.state.last_read_at_by_key).toEqual(
      SERVER_STATE.last_read_at_by_key,
    );
  });

  it("does not write when read markers belong to sessions outside the visible list", async () => {
    const markers = {
      ...SERVER_STATE.last_read_at_by_key,
      "websocket:another-window": "2026-09-11T07:00:00",
      "websocket:temporarily-hidden": "2026-09-11T06:00:00",
    };
    mockedFetch.mockResolvedValue({ ...SERVER_STATE, last_read_at_by_key: markers });
    mockedUpdate.mockImplementation(async (_token, state) => state);

    const { result } = renderHook(() => useSidebarState(SESSIONS, true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });

    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(result.current.state.last_read_at_by_key).toEqual(markers);
  });

  it("prunes obsolete sidebar entries once while retaining server-merged read markers", async () => {
    const markers = {
      ...SERVER_STATE.last_read_at_by_key,
      "websocket:another-window": "2026-09-11T07:00:00",
      "websocket:temporarily-hidden": "2026-09-11T06:00:00",
    };
    mockedFetch.mockResolvedValue({
      ...SERVER_STATE,
      pinned_keys: ["websocket:a", "websocket:obsolete"],
      title_overrides: { "websocket:obsolete": "obsolete" },
      last_read_at_by_key: markers,
    });
    let responses = 0;
    mockedUpdate.mockImplementation(async (_token, state) => {
      responses += 1;
      if (responses > 6) return new Promise<typeof state>(() => {});
      return { ...state, last_read_at_by_key: { ...markers, ...state.last_read_at_by_key } };
    });

    const { result } = renderHook(() => useSidebarState(SESSIONS, true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });

    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(result.current.state.pinned_keys).toEqual(["websocket:a"]);
    expect(result.current.state.title_overrides).toEqual({});
    expect(result.current.state.last_read_at_by_key).toEqual(markers);
  });

  it("restores a batch action when saving it fails", async () => {
    mockedFetch.mockResolvedValue(SERVER_STATE);
    mockedUpdate.mockRejectedValue(new Error("unavailable"));
    const { result } = renderHook(() => useSidebarState(SESSIONS, true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let saved = true;
    await act(async () => {
      saved = await result.current.update(
        (state) => ({ ...state, pinned_keys: ["websocket:a", "websocket:b"] }),
        { rollbackOnFailure: true },
      );
    });

    expect(saved).toBe(false);
    expect(result.current.state.pinned_keys).toEqual([]);
  });

  it("persists successive updates in order so an earlier snapshot cannot overwrite a batch", async () => {
    mockedFetch.mockResolvedValue(SERVER_STATE);
    let finishFirst: (() => void) | undefined;
    mockedUpdate.mockImplementationOnce((_token, state) => new Promise((resolve) => {
      finishFirst = () => resolve(state);
    }));
    mockedUpdate.mockImplementation(async (_token, state) => state);
    const { result } = renderHook(() => useSidebarState(SESSIONS, true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let first: Promise<boolean>;
    let second: Promise<boolean>;
    act(() => {
      first = result.current.update((state) => ({ ...state, pinned_keys: ["websocket:a"] }));
      second = result.current.update((state) => ({ ...state, archived_keys: ["websocket:b"] }));
    });
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(1));
    await act(async () => {
      finishFirst?.();
      await Promise.all([first!, second!]);
    });

    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedUpdate.mock.calls[1][1].pinned_keys).toEqual(["websocket:a"]);
    expect(mockedUpdate.mock.calls[1][1].archived_keys).toEqual(["websocket:b"]);
  });
});
