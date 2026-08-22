import { useEffect, useMemo, useState } from "react";

import { listAgents } from "@/lib/api";
import type { AgentSummary } from "@/lib/types";

/** Module-level cache so every consumer (chat list, thread, room panel)
 *  shares a single ``GET /api/agents`` round-trip per app run. The registry
 *  is static while the gateway runs; a restart reloads the page anyway. */
let cachedAgents: AgentSummary[] | null = null;
let inflight: Promise<AgentSummary[]> | null = null;
const invalidationListeners = new Set<() => void>();

/** Clear the shared registry cache after a management change. */
export function invalidateAgents(): void {
  cachedAgents = null;
  for (const listener of invalidationListeners) listener();
}

function loadAgents(token: string): Promise<AgentSummary[]> {
  if (cachedAgents) return Promise.resolve(cachedAgents);
  if (!inflight) {
    inflight = listAgents(token)
      .then((agents) => {
        cachedAgents = agents;
        return agents;
      })
      .catch(() => [])
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Fetch the enabled agent registry once and expose it as an id → agent map.
 *  Failures degrade to an empty map (callers fall back to derived names). */
export function useAgents(token: string | null): ReadonlyMap<string, AgentSummary> {
  const [agents, setAgents] = useState<AgentSummary[]>(cachedAgents ?? []);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void loadAgents(token).then((rows) => {
      if (!cancelled) setAgents(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);
  useEffect(() => {
    const reload = () => {
      if (!token) return;
      void loadAgents(token).then(setAgents);
    };
    invalidationListeners.add(reload);
    return () => {
      invalidationListeners.delete(reload);
    };
  }, [token]);
  return useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
}
