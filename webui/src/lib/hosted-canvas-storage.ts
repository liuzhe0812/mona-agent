import { getHostedPlatform, HostedPlatformError, invokeHostedPlatform } from "./hosted-platform";
import type { SavedWorkspaceCanvas } from "./tauri";

type VersionedCanvas = SavedWorkspaceCanvas & { sha256: string };
let scope: ReturnType<typeof getHostedPlatform> = null;
const versions = new Map<string, { sha256: string; revision: number }>();
const writes = new Map<string, Promise<unknown>>();
let revision = 0;

export async function invokeHostedCanvas<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const current = getHostedPlatform();
  if (!current) throw new Error("工作台存储尚未连接。");
  if (scope !== current) {
    scope = current;
    versions.clear();
    writes.clear();
  }
  const requireCurrentAccount = () => {
    if (getHostedPlatform() !== current || scope !== current) throw new Error("账号已变化，请重新打开当前画布。");
  };
  const capture = (value: VersionedCanvas, observed: number) => {
    requireCurrentAccount();
    if (value?.canvas?.id && /^[a-f0-9]{64}$/.test(value.sha256)) {
      const keys = [value.canvas.id, ...(typeof value.path === "string" ? [value.path] : [])];
      if (keys.some(key => (versions.get(key)?.revision ?? 0) > observed && versions.get(key)?.sha256 !== value.sha256)) {
        throw new HostedPlatformError("画布在读取期间已变化，请重新打开当前画布。", 409, "canvas_changed");
      }
      for (const key of keys) {
        if ((versions.get(key)?.revision ?? 0) <= observed) versions.set(key, { sha256: value.sha256, revision: observed });
      }
    }
  };
  if (command === "move_to_trash") {
    const path = args.path;
    const expected = args.expectedSha256 ?? (typeof path === "string" ? versions.get(path)?.sha256 : undefined);
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error("尚未读取此文件的版本，请刷新文件列表后再删除。");
    }
    const result = await invokeHostedPlatform<T>(command, { ...args, expectedSha256: expected });
    requireCurrentAccount();
    if (typeof path === "string") versions.delete(path);
    return result;
  }
  if (command === "workspace_canvas_save" || command === "workspace_canvas_write_file") {
    const id = (args.canvas as { id?: string } | undefined)?.id;
    if (!id) throw new Error("画布标识无效。");
    const previous = writes.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      requireCurrentAccount();
      const result = await invokeHostedPlatform<VersionedCanvas>(command, { ...args, expectedSha256: versions.get(id)?.sha256 });
      capture(result, ++revision);
      return result;
    });
    writes.set(id, operation);
    try { return await operation as T; }
    finally { if (writes.get(id) === operation) writes.delete(id); }
  }
  await Promise.allSettled([...writes.values()]);
  requireCurrentAccount();
  const started = ++revision;
  const result = await invokeHostedPlatform<VersionedCanvas | VersionedCanvas[]>(command, args);
  requireCurrentAccount();
  if (Array.isArray(result)) result.forEach(value => capture(value, started));
  else capture(result, started);
  return result as T;
}
