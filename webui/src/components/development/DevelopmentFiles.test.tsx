import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDocument } from "@/lib/development-api";
import { DevelopmentFiles } from "./DevelopmentFiles";
import { fileKey, useDevelopmentStore } from "./store";

const api = vi.hoisted(() => ({ directory: vi.fn(), file: vi.fn(), saveFile: vi.fn() }));
vi.mock("@/lib/development-api", () => ({ developmentApi: api }));
const project = { id: "project_files", displayName: "Files", rootPath: "D:/files", lastOpenedAt: "" };
const file = (path: string, content = "original"): FileDocument => ({ path, content, sha256: "initial", bom: false });
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const show = (sessionId = "dev_files") => render(<DevelopmentFiles project={project} sessionId={sessionId} />);
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  api.directory.mockResolvedValue({ entries: ["a.ts", "b.ts"].map((name) => ({ path: name, name, kind: "file" })), nextOffset: null });
  api.file.mockImplementation(async (_id: string, path: string) => file(path));
});
afterEach(cleanup);

describe("development file view request ownership", () => {
  it("shows a compact hint only for other active tasks involving this file", async () => {
    api.file.mockResolvedValue({ ...file("a.ts"), fileActivity: { available: true, checkedAt: "2026-10-07", partial: false,
      tasks: [{ sessionId: "dev_files", title: "Current" }, { sessionId: "dev_other", title: "Parallel writer" }] } });
    show(); fireEvent.click(await screen.findByRole("button", { name: "a.ts", exact: true }));
    const hint = await screen.findByRole("img", { name: "此文件有并行修改活动" });
    expect(hint).toHaveAttribute("title", expect.stringContaining("Parallel writer"));
    expect(hint.getAttribute("title")).not.toContain("Current");
    expect(screen.getByRole("textbox", { name: "项目文件编辑器" })).toHaveValue("original");
  });

  it("does not let a response from a closed file tab replace the new selection", async () => {
    const pending = deferred<FileDocument>(); api.file.mockReturnValueOnce(pending.promise);
    const first = show(); fireEvent.click(await screen.findByRole("button", { name: "a.ts", exact: true }));
    first.unmount(); show(); fireEvent.click(await screen.findByRole("button", { name: "b.ts", exact: true }));
    await screen.findByRole("textbox", { name: "项目文件编辑器" });
    await act(async () => pending.resolve(file("a.ts", "late")));
    expect(useDevelopmentStore.getState().selectedFiles.dev_files).toBe("b.ts");
    expect(screen.getByRole("textbox", { name: "项目文件编辑器" })).toHaveValue("original");
  });
  it("retains typing made while a real save request is in flight", async () => {
    const pending = deferred<FileDocument>(); api.saveFile.mockReturnValueOnce(pending.promise);
    show(); fireEvent.click(await screen.findByRole("button", { name: "a.ts", exact: true }));
    const editor = await screen.findByRole("textbox", { name: "项目文件编辑器" });
    fireEvent.change(editor, { target: { value: "sent" } });
    fireEvent.click(screen.getByRole("button", { name: "保存", exact: true }));
    await waitFor(() => expect(api.saveFile).toHaveBeenCalledOnce());
    fireEvent.change(editor, { target: { value: "newer unsaved" } });
    await act(async () => pending.resolve({ ...file("a.ts", "sent"), sha256: "saved" }));
    expect(useDevelopmentStore.getState().files[fileKey("dev_files", "a.ts")]).toEqual({
      file: { ...file("a.ts", "sent"), sha256: "saved" }, draft: "newer unsaved",
    });
  });
  it("ignores a late read after the component changes development session", async () => {
    const pending = deferred<FileDocument>(); api.file.mockReturnValueOnce(pending.promise);
    const view = show(); fireEvent.click(await screen.findByRole("button", { name: "a.ts", exact: true }));
    view.rerender(<DevelopmentFiles project={project} sessionId="dev_other" />);
    await act(async () => pending.resolve(file("a.ts", "late")));
    expect(useDevelopmentStore.getState().selectedFiles.dev_files).toBeUndefined();
    expect(useDevelopmentStore.getState().selectedFiles.dev_other).toBeUndefined();
  });
});
