import { getHostedPlatform, invokeHostedPlatform } from "./hosted-platform";
import type { SavedWorkspaceCanvas } from "./tauri";

type VersionedCanvas = SavedWorkspaceCanvas & { sha256: string };
let scope: ReturnType<typeof getHostedPlatform> = null;
const versions = new Map<string, string>();
const writes = new Map<string, Promise<unknown>>();

export async function invokeHostedCanvas<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const current = getHostedPlatform();
  if (!current) throw new Error("工作台存储尚未连接。");
  if (scope !== current) {
    scope = current;
    versions.clear();
    writes.clear();
  }
  const capture = (value: VersionedCanvas) => {
    if (value?.canvas?.id && /^[a-f0-9]{64}$/.test(value.sha256)) {
      versions.set(value.canvas.id, value.sha256);
      if (typeof value.path === "string") versions.set(value.path, value.sha256);
    }
  };
  if (command === "move_to_trash") {
    const path = args.path;
    const expected = args.expectedSha256 ?? (typeof path === "string" ? versions.get(path) : undefined);
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error("尚未读取此文件的版本，请刷新文件列表后再删除。");
    }
    const result = await invokeHostedPlatform<T>(command, { ...args, expectedSha256: expected });
    if (typeof path === "string") versions.delete(path);
    return result;
  }
  if (command === "workspace_canvas_save" || command === "workspace_canvas_write_file") {
    const id = (args.canvas as { id?: string } | undefined)?.id;
    if (!id) throw new Error("画布标识无效。");
    const previous = writes.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      if (getHostedPlatform() !== current) throw new Error("账号已变化，请重新打开当前画布。");
      const result = await invokeHostedPlatform<VersionedCanvas>(command, { ...args, expectedSha256: versions.get(id) });
      capture(result);
      return result;
    });
    writes.set(id, operation);
    try { return await operation as T; }
    finally { if (writes.get(id) === operation) writes.delete(id); }
  }
  const result = await invokeHostedPlatform<VersionedCanvas | VersionedCanvas[]>(command, args);
  if (Array.isArray(result)) result.forEach(capture);
  else capture(result);
  return result as T;
}
