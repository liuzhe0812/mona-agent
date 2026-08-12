import { useCallback, useEffect, useRef, useState } from "react";
import { listArtifacts, listProjectFiles } from "@/lib/api";
import type { DeliveredFile } from "@/lib/types";

interface UseArtifactsResult {
  files: DeliveredFile[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  /** Bump to re-run the scan. Also called automatically on ``refreshSignal`` changes. */
  refresh: () => void;
}

export interface ArtifactSource {
  /** ``shared`` scans ``<workspace>/output/``; ``project`` scans the
   *  session's bound workspace directory (all project files). */
  scope?: "shared" | "project";
  /** Required when ``scope === "project"``: the websocket session key whose
   *  ``metadata.workspace`` is the scan root. */
  sessionKey?: string | null;
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
  const { scope = "shared", sessionKey = null } = source;
  const [files, setFiles] = useState<DeliveredFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const controlRef = useRef({ running: false, pending: false });

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  useEffect(() => {
    if (!token) return;
    if (scope === "project" && !sessionKey) return;
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
            : await listArtifacts(token);
        if (cancelled) return;
        setFiles(result.files);
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
  }, [token, refreshTick, refreshSignal, scope, sessionKey]);

  return { files, loading, error, truncated, refresh };
}
