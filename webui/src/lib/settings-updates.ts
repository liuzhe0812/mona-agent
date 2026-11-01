import type { SettingsPayload } from "@/lib/types";

type SettingsListener = (token: string, payload: SettingsPayload) => void;
const listeners = new Set<SettingsListener>();

export function publishSettingsUpdate(token: string, payload: SettingsPayload) {
  for (const listener of [...listeners]) listener(token, payload);
}

export function subscribeSettingsUpdates(token: string, apply: (payload: SettingsPayload) => void) {
  const listener: SettingsListener = (updatedToken, payload) => {
    if (updatedToken === token) apply(payload);
  };
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
