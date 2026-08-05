import { useCallback, useEffect, useRef, useState } from "react";
import { listArtifacts } from "@/lib/api";
import type { DeliveredFile } from "@/lib/types";

interface UseArtifactsResult {
  files: DeliveredFile[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  /** Bump to re-run the scan. Also called automatically on ``refreshSignal`` changes. */
  refresh: () => void;
}

/** Stream the shared-output artifact list from ``GET /api/artifacts``.
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
): UseArtifactsResult {
  const [files, setFiles] = useState<DeliveredFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const controlRef = useRef({ running: false, pending: false });

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  useEffect(() => {
    if (!token) return;
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
        const result = await listArtifacts(token);
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
  }, [token, refreshTick, refreshSignal]);

  return { files, loading, error, truncated, refresh };
}
