import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ save: vi.fn(), load: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true, loadDesktopNotesState: native.load,
  saveDesktopNotesState: native.save, deleteDesktopNotes: native.remove }));
import { createBlankNote, deleteNotesState, saveNotesState, type NotesStorageState } from "./notes-storage";

const vault = "a".repeat(64), rev = "1".repeat(64), updated = "2".repeat(64);
function state(id: string): NotesStorageState {
  return { vaultToken: vault, notebooks: [{ id: "课程", name: "课程" }], activeNotebookId: "课程",
    activeNoteId: id, transformations: [], notes: [{ ...createBlankNote("课程"), id, contentMarkdown: "原文", storageRevision: rev }] };
}
beforeEach(() => { native.save.mockReset(); native.load.mockReset(); native.remove.mockReset(); });
describe("serialized revision-aware Notes saves", () => {
  it("requires the loaded vault identity before sending a write", async () => {
    await expect(saveNotesState({ ...state("missing"), vaultToken: undefined })).rejects.toThrow("重新打开");
    expect(native.save).not.toHaveBeenCalled();
  });
  it("updates a queued own save with its prior confirmed revision", async () => {
    const first = state("serial");
    let resolve!: (value: Record<string, string>) => void;
    native.save.mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValueOnce({ serial: "3".repeat(64) });
    const one = saveNotesState(first);
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledOnce());
    const second = structuredClone(first); second.notes[0].contentMarkdown = "接着输入";
    const two = saveNotesState(second);
    expect(native.save).toHaveBeenCalledOnce();
    resolve({ serial: updated }); await one; await two;
    expect(native.save.mock.calls[1][0].notes[0]).toMatchObject({ storageRevision: updated, contentMarkdown: "接着输入" });
  });
  it("does not substitute a prior revision across vaults", async () => {
    native.save.mockResolvedValueOnce({ shared: updated }).mockResolvedValueOnce({ shared: "3".repeat(64) });
    await saveNotesState(state("shared"));
    await saveNotesState({ ...state("shared"), vaultToken: "b".repeat(64) });
    expect(native.save.mock.calls[1][0].notes[0].storageRevision).toBe(rev);
  });
  it("never replaces a newly read remote revision with an old own-write token", async () => {
    native.save.mockResolvedValueOnce({ remote: updated }).mockResolvedValueOnce({ remote: "4".repeat(64) });
    await saveNotesState(state("remote"));
    const changed = state("remote"); changed.notes[0].storageRevision = "3".repeat(64);
    await saveNotesState(changed);
    expect(native.save.mock.calls[1][0].notes[0].storageRevision).toBe("3".repeat(64));
  });
  it("snapshots values before waiting in the save queue", async () => {
    const original = state("immutable"); native.save.mockResolvedValue({ immutable: updated });
    const pending = saveNotesState(original); original.notes[0].contentMarkdown = "later change";
    await pending;
    expect(native.save.mock.calls[0][0].notes[0].contentMarkdown).toBe("原文");
  });
  it("a failed save does not poison the next explicit save or fabricate a revision", async () => {
    native.save.mockRejectedValueOnce(new Error("磁盘错误")).mockResolvedValueOnce({ retry: updated });
    await expect(saveNotesState(state("retry"))).rejects.toThrow("磁盘错误");
    await expect(saveNotesState(state("retry"))).resolves.toEqual({ retry: updated });
    expect(native.save.mock.calls[1][0].notes[0].storageRevision).toBe(rev);
  });
  it("serializes deletion after own save and sends its confirmed revision", async () => {
    const first = state("delete-after-save");
    let resolve!: (value: Record<string, string>) => void;
    native.save.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const saving = saveNotesState(first);
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledOnce());
    const deleting = deleteNotesState(first.notes, vault);
    expect(native.remove).not.toHaveBeenCalled();
    resolve({ "delete-after-save": updated });
    await saving; await deleting;
    expect(native.remove).toHaveBeenCalledWith(["delete-after-save"], vault, { "delete-after-save": updated });
  });
  it("a stale delete never reloads and substitutes the other device's revision", async () => {
    const selected = state("stale-delete");
    native.remove.mockRejectedValueOnce(new Error("其他设备已更新"));
    await expect(deleteNotesState(selected.notes, vault)).rejects.toThrow("其他设备已更新");
    expect(native.remove).toHaveBeenCalledWith(["stale-delete"], vault, { "stale-delete": rev });
    expect(native.load).not.toHaveBeenCalled();
    expect(native.save).not.toHaveBeenCalled();
  });
  it("binds deletion to the original vault and preserves an unpersisted identity", async () => {
    await expect(deleteNotesState(state("no-vault").notes, undefined)).rejects.toThrow("重新打开");
    expect(native.remove).not.toHaveBeenCalled();
    const selected = state("unsaved-delete");
    selected.notes[0].storageRevision = undefined;
    await deleteNotesState(selected.notes, vault);
    expect(native.remove).toHaveBeenCalledWith(["unsaved-delete"], vault, { "unsaved-delete": null });
  });
  it("requires a real returned revision for every written note", async () => {
    native.save.mockResolvedValue({});
    await expect(saveNotesState(state("unconfirmed"))).rejects.toThrow("尚未确认");
  });
});
