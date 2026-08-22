import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useArtifacts } from "@/hooks/useArtifacts";
import { listArtifacts, listProjectFiles } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  listArtifacts: vi.fn(),
  listProjectFiles: vi.fn(),
}));

const mockedList = vi.mocked(listArtifacts);
const mockedListProject = vi.mocked(listProjectFiles);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const emptyResult = { files: [], truncated: false };

describe("useArtifacts", () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedListProject.mockReset();
  });

  it("does not fetch without a token", () => {
    renderHook(() => useArtifacts(null));
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("fetches the artifact list on mount", async () => {
    mockedList.mockResolvedValue({
      files: [
        {
          path: "report.md",
          absolute_path: "/out/report.md",
          name: "report.md",
          size: 3,
          size_human: "3 B",
          mime: "text/markdown",
        },
      ],
      truncated: false,
    });
    const { result } = renderHook(() =>
      useArtifacts("tok", undefined, {
        scope: "shared",
        sessionKey: "session-1",
      }),
    );
    await waitFor(() => expect(result.current.files).toHaveLength(1));
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it("runs a trailing refetch when a refresh arrives mid-flight", async () => {
    const first = deferred<typeof emptyResult>();
    mockedList.mockReturnValueOnce(first.promise).mockResolvedValue(emptyResult);

    const { result } = renderHook(() =>
      useArtifacts("tok", undefined, {
        scope: "shared",
        sessionKey: "session-1",
      }),
    );
    expect(mockedList).toHaveBeenCalledTimes(1);

    // Refresh while the first request is still in flight.
    act(() => result.current.refresh());
    act(() => result.current.refresh());

    await act(async () => first.resolve(emptyResult));

    // The mid-flight refreshes must not be dropped: exactly one trailing
    // run is coalesced after the in-flight request settles.
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
  });

  it("re-fetches when the refreshSignal changes", async () => {
    mockedList.mockResolvedValue(emptyResult);
    const { rerender } = renderHook(
      ({ signal }) =>
        useArtifacts("tok", signal, {
          scope: "shared",
          sessionKey: "session-1",
        }),
      { initialProps: { signal: 0 } },
    );
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(1));

    rerender({ signal: 1 });
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
  });

  it("lists the project directory instead of shared output for project scope", async () => {
    mockedListProject.mockResolvedValue({
      files: [
        {
          path: "src/main.py",
          absolute_path: "/proj/src/main.py",
          name: "main.py",
          size: 3,
          size_human: "3 B",
          mime: "text/x-python",
        },
      ],
      truncated: false,
    });

    const { result } = renderHook(() =>
      useArtifacts("tok", undefined, {
        scope: "project",
        sessionKey: "websocket:proj",
      }),
    );

    await waitFor(() => expect(result.current.files).toHaveLength(1));
    expect(mockedListProject).toHaveBeenCalledTimes(1);
    expect(mockedListProject).toHaveBeenCalledWith("tok", "websocket:proj");
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("does not fetch for project scope without a session key", () => {
    renderHook(() =>
      useArtifacts("tok", undefined, { scope: "project", sessionKey: null }),
    );
    expect(mockedListProject).not.toHaveBeenCalled();
    expect(mockedList).not.toHaveBeenCalled();
  });
});
