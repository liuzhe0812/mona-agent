import { developmentApi, type ExecutorId } from "@/lib/development-api";

const AUTO_PROBE_EXECUTORS: ExecutorId[] = ["codex", "claude", "codebuddy"];

let pending: Promise<void> | null = null;

export function warmNativeProviderConnections(): Promise<void> {
  pending ??= probeConnections().finally(() => { pending = null; });
  return pending;
}

async function probeConnections(): Promise<void> {
  try {
    const { executors } = await developmentApi.providerExecutors();
    const available = executors.filter(
      (executor) => executor.available && AUTO_PROBE_EXECUTORS.includes(executor.id),
    );
    await Promise.allSettled(
      available.map((executor) => developmentApi.probe(undefined, executor.id)),
    );
  } catch {
    // Best-effort startup sync only. Never start login from here.
  }
}
