import { getHostedPlatform } from "./hosted-platform";

type Listener = { scope: NonNullable<ReturnType<typeof getHostedPlatform>>; run: (payload: unknown) => unknown };
const listeners = new Map<string, Set<Listener>>();

export async function listen<T>(event: string, handler: (event: { event: string; id: number; payload: T }) => unknown) {
  const scope = getHostedPlatform();
  if (!scope) return (await import("@tauri-apps/api/event")).listen<T>(event, handler);
  const item: Listener = { scope, run: payload => handler({ event, id: 0, payload: payload as T }) };
  const bucket = listeners.get(event) ?? new Set<Listener>();
  listeners.set(event, bucket);
  bucket.add(item);
  return () => { bucket.delete(item); if (!bucket.size) listeners.delete(event); };
}

export async function emitHostedPlatformEvent(event: string, payload: unknown) {
  const scope = getHostedPlatform();
  await Promise.all([...(listeners.get(event) ?? [])].filter(item => item.scope === scope)
    .map(item => Promise.resolve(item.run(payload))));
}
