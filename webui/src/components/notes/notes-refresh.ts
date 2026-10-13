import type { OperationNote } from "./notes-data";

function content(note: OperationNote | undefined): string {
  if (!note) return "";
  return JSON.stringify([note.notebookId, note.title, note.contentMarkdown, note.type ?? "note",
    note.aliases ?? [], note.favorite ?? false, note.contextLevel ?? "full", note.agentChatId ?? null,
    note.originChatId ?? null, note.appliedAgentMessageIds ?? []]);
}

/** Keep typing in the current note; concurrent remote edits survive as an explicit copy. */
export function mergeNotesRefresh(current: OperationNote[], incoming: OperationNote[], savedSnapshot: string | null): OperationNote[] {
  let baseline: OperationNote[] = [];
  try {
    const parsed = savedSnapshot ? JSON.parse(savedSnapshot) : null;
    if (Array.isArray(parsed?.notes)) baseline = parsed.notes;
  } catch { /* No saved snapshot yet; preserve any local edits. */ }
  const previous = new Map(baseline.map((note) => [note.id, note]));
  const remote = new Map(incoming.map((note) => [note.id, note]));
  const merged: OperationNote[] = [];
  for (const note of current) {
    const next = remote.get(note.id);
    remote.delete(note.id);
    const dirty = content(note) !== content(previous.get(note.id));
    if (!next) {
      if (dirty) merged.push({ ...note, storageRevision: undefined });
      continue;
    }
    if (!dirty || content(note) === content(next)) { merged.push(next); continue; }
    if (note.storageRevision === next.storageRevision || content(next) === content(previous.get(note.id))) {
      merged.push({ ...note, storageRevision: next.storageRevision }); continue;
    }
    merged.push({ ...note, storageRevision: next.storageRevision });
    const id = `note-conflict-${next.storageRevision ?? crypto.randomUUID()}`;
    if (!current.some((value) => value.id === id) && !incoming.some((value) => value.id === id)) {
      merged.push({ ...next, id, title: `${next.title} · 同步冲突`, storageRevision: undefined });
    }
  }
  for (const next of remote.values()) {
    const before = previous.get(next.id);
    if (!before) merged.push(next);
    else if (content(next) !== content(before)) {
      // A local delete must not discard a concurrent remote edit, or resurrect
      // an unchanged copy that has merely not finished deleting on disk yet.
      merged.push({ ...next, id: `note-conflict-${next.storageRevision ?? crypto.randomUUID()}`,
        title: `${next.title} · 同步冲突`, storageRevision: undefined });
    }
  }
  return merged;
}
