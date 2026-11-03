import { getHostedPlatform, invokeHostedPlatform } from "./hosted-platform";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (getHostedPlatform()) return invokeHostedPlatform<T>(command, args);
  return nativeInvoke<T>(command, args);
}
