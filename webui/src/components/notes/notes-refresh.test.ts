import { describe, expect, it } from "vitest";
import type { OperationNote } from "./notes-data";
import { mergeNotesRefresh } from "./notes-refresh";

const note = (content = "原文", revision = "a".repeat(64)): OperationNote => ({
  id: "note-one", notebookId: "课程", title: "第一课", preview: content, contentMarkdown: content,
  createdAt: "2026-10-13", updatedAt: "2026-10-13", source: { kind: "manual", label: "手动记录" },
  appliedAgentMessageIds: [], contextLevel: "full", storageRevision: revision,
});
const saved = (notes: OperationNote[]) => JSON.stringify({ notes });

describe("notes refresh without losing typing", () => {
  it("accepts a remote update when the editor was unchanged", () => {
    const old = note(), next = note("远端更新", "b".repeat(64));
    expect(mergeNotesRefresh([old], [next], saved([old]))).toEqual([next]);
  });
  it("retains dirty typing and saves a concurrent remote edit as one named copy", () => {
    const old = note(), local = note("正在输入"), remote = note("远端更新", "b".repeat(64));
    const result = mergeNotesRefresh([local], [remote], saved([old]));
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ contentMarkdown: "正在输入", storageRevision: remote.storageRevision });
    expect(result[1]).toMatchObject({ contentMarkdown: "远端更新", title: "第一课 · 同步冲突", storageRevision: undefined });
    expect(mergeNotesRefresh(result, [remote], saved([old]))).toHaveLength(2);
  });
  it("does not make a conflict from changed frontmatter with unchanged remote content", () => {
    const old = note(), local = note("正在输入"), remote = note("原文", "b".repeat(64));
    const result = mergeNotesRefresh([local], [remote], saved([old]));
    expect(result).toHaveLength(1);
    expect(result[0].contentMarkdown).toBe("正在输入");
    expect(result[0].storageRevision).toBe(remote.storageRevision);
  });
  it("remote deletion removes only unchanged editor content", () => {
    expect(mergeNotesRefresh([note()], [], saved([note()]))).toEqual([]);
    expect(mergeNotesRefresh([note("本地新修改")], [], saved([note()]))).toEqual([
      { ...note("本地新修改"), storageRevision: undefined },
    ]);
  });
  it("does not restore a locally deleted note from a stale disk listing", () => {
    expect(mergeNotesRefresh([], [note()], saved([note()]))).toEqual([]);
  });
  it("keeps remote edits made concurrently with a local deletion", () => {
    const result = mergeNotesRefresh([], [note("远端修改", "b".repeat(64))], saved([note()]));
    expect(result).toHaveLength(1);
    expect(result[0].id).not.toBe("note-one");
    expect(result[0].title).toContain("同步冲突");
    expect(result[0].contentMarkdown).toBe("远端修改");
  });
  it("keeps a new local note not yet present on disk", () => {
    expect(mergeNotesRefresh([note("新笔记")], [], saved([]))[0]).toMatchObject({ contentMarkdown: "新笔记" });
  });
  it("keeps edits when the initial saved snapshot is unavailable", () => {
    expect(mergeNotesRefresh([note("未保存")], [], null)[0]).toMatchObject({ contentMarkdown: "未保存" });
    expect(mergeNotesRefresh([note("未保存")], [], "invalid")[0]).toMatchObject({ contentMarkdown: "未保存" });
  });
});
