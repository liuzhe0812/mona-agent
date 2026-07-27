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
  const inFlight = useRef(false);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  useEffect(() => {
    if (!token) return;
    if (inFlight.current) return;
    let cancelled = false;
    inFlight.current = true;
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
        if (!cancelled) setLoading(false);
        inFlight.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, refreshTick, refreshSignal]);

  return { files, loading, error, truncated, refresh };
}
