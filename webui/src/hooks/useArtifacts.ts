import { useCallback, useEffect, useRef, useState } from "react";
import { listArtifacts, listProjectFiles } from "@/lib/api";
import type { DeliveredFile } from "@/lib/types";

interface UseArtifactsResult {
  files: DeliveredFile[];
  sessionFiles: DeliveredFile[];
  taskFiles: DeliveredFile[];
  taskId: string | null;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  /** Bump to re-run the scan. Also called automatically on ``refreshSignal`` changes. */
  refresh: () => void;
}

export interface ArtifactSource {
  /** ``shared`` scans the active Agent output; ``project`` scans the
   *  session's bound workspace directory (all project files); ``room``
   *  returns the room's flat explicit-reference projection. */
  scope?: "shared" | "project" | "room";
  /** Required for shared/project scopes: the websocket session key used to
   *  resolve the Agent-owned workspace (or project root). */
  sessionKey?: string | null;
  /** Required when ``scope === "room"``: the room id. */
  room?: string | null;
  /** Current user-controlled task within a shared session. */
  taskId?: string | null;
  /** Stable conversation identity used to keep artifact projections isolated
   *  when a transport session key is reused. */
  sourceKey?: string | null;
}

/** Stream the artifact list from the server (``GET /api/artifacts`` for
 *  shared scope, ``GET /api/project-files`` for project scope).
 *
 *  - No polling, no file watcher.
 *  - Re-fetches when ``token`` changes, when the caller bumps ``refreshSignal``
 *    (e.g. on ``turn_end`` or after settings/restart), or when the user
 *    clicks the manual refresh button.
 *  - A refresh that arrives mid-flight is never dropped: it is recorded as
 *    pending and coalesced into exactly one trailing run once the current
 *    request settles (shared ``controlRef`` survives effect re-runs).
 *  - Mid-turn ``deliver_file`` / ``file_edit`` events are merged by the
 *    caller (ThreadShell); this hook only owns the authoritative on-disk
 *    snapshot.
 */
export function useArtifacts(
  token: string | null,
  refreshSignal?: unknown,
  source: ArtifactSource = {},
): UseArtifactsResult {
  const { scope = "shared", sessionKey = null, room = null, taskId = null, sourceKey = null } = source;
  const [files, setFiles] = useState<DeliveredFile[]>([]);
  const [sessionFiles, setSessionFiles] = useState<DeliveredFile[]>([]);
  const [taskFiles, setTaskFiles] = useState<DeliveredFile[]>([]);
  const [resolvedTaskId, setResolvedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const controlRef = useRef({ running: false, pending: false });
  const sourceId = scope === "room"
    ? `room:${room ?? ""}:source:${sourceKey ?? ""}`
    : `${scope}:${sessionKey ?? ""}:source:${sourceKey ?? ""}:task:${taskId ?? "current"}`;
  const loadedSourceRef = useRef<string | null>(null);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  useEffect(() => {
    if (!token) return;
    if (scope !== "room" && !sessionKey) return;
    if (scope === "room" && !room) return;
    const control = controlRef.current;
    if (control.running) {
      control.pending = true;
      return;
    }
    let cancelled = false;
    control.running = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const result =
          scope === "project"
            ? await listProjectFiles(token, sessionKey!)
            : scope === "room"
              ? await listArtifacts(token, undefined, room!)
              : await listArtifacts(token, undefined, undefined, sessionKey!, taskId ?? undefined);
        if (cancelled) return;
        loadedSourceRef.current = sourceId;
        setFiles(result.files);
        setSessionFiles(result.session_files ?? []);
        setTaskFiles(result.task_files ?? []);
        setResolvedTaskId(result.task_id ?? taskId);
        setTruncated(result.truncated);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        control.running = false;
        if (!cancelled) setLoading(false);
        if (control.pending) {
          control.pending = false;
          setRefreshTick((t) => t + 1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, refreshTick, refreshSignal, scope, sessionKey, room, taskId, sourceId]);

  const sourceIsCurrent = loadedSourceRef.current === sourceId;
  return {
    files: sourceIsCurrent ? files : [],
    sessionFiles: sourceIsCurrent ? sessionFiles : [],
    taskFiles: sourceIsCurrent ? taskFiles : [],
    taskId: sourceIsCurrent ? resolvedTaskId : taskId,
    loading,
    error: sourceIsCurrent ? error : null,
    truncated: sourceIsCurrent ? truncated : false,
    refresh,
  };
}
