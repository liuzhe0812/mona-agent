import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDocument } from "@/lib/development-api";
import { DevelopmentFiles } from "./DevelopmentFiles";
import { fileKey, useDevelopmentStore } from "./store";

const api = vi.hoisted(() => ({ directory: vi.fn(), file: vi.fn(), saveFile: vi.fn() }));
const native = vi.hoisted(() => ({ isTauri: vi.fn(), revealItemInDir: vi.fn(), openPath: vi.fn(), invoke: vi.fn() }));
vi.mock("@/lib/development-api", () => ({ developmentApi: api }));
vi.mock("@/lib/tauri", async (original) => ({ ...await original<typeof import("@/lib/tauri")>(), isTauri: native.isTauri }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: native.revealItemInDir, openPath: native.openPath }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: native.invoke }));
const project = { id: "project_files", displayName: "Files", rootPath: "D:/files", lastOpenedAt: "" };
const file = (path: string, content = "original"): FileDocument => ({ path, content, sha256: "initial", bom: false });
let clipboardDescriptor: PropertyDescriptor | undefined;
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const show = (sessionId = "dev_files") => render(<DevelopmentFiles project={project} sessionId={sessionId} />);
async function openEntryMenu(path: string) {
  fireEvent.contextMenu(await screen.findByTitle(path), { button: 2, clientX: 40, clientY: 30 });
  await screen.findByRole("menuitem", { name: "打开", exact: true });
}
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  native.isTauri.mockReturnValue(false);
  native.revealItemInDir.mockResolvedValue(undefined);
  native.openPath.mockResolvedValue(undefined);
  native.invoke.mockResolvedValue(true);
  api.directory.mockResolvedValue({ entries: ["a.ts", "b.ts"].map((name) => ({ path: name, name, kind: "file" })), nextOffset: null });
  api.file.mockImplementation(async (_id: string, path: string) => file(path));
});
afterEach(() => {
  cleanup();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("development file view request ownership", () => {
  it("omits the root directory heading and returns to the parent from the first list row", async () => {
    api.directory.mockImplementation(async (_id: string, path: string) => ({ entries: path
      ? [{ path: "src/a.ts", name: "a.ts", kind: "file" }]
      : [{ path: "src", name: "src", kind: "directory" }], nextOffset: null }));
    show();
    await screen.findByRole("button", { name: "src", exact: true });
    expect(screen.queryByText(project.displayName)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上一级目录" })).not.toBeInTheDocument();
    await openEntryMenu("src");
    expect(screen.queryByRole("menuitem", { name: "引用到当前会话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "使用系统应用打开" })).not.toBeInTheDocument();
    expect(api.file).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "打开", exact: true }));
    await screen.findByRole("button", { name: "a.ts", exact: true });
    const list = screen.getByRole("region", { name: "项目文件列表" });
    const parent = within(list).getByRole("button", { name: "上一级目录" });
    expect(within(list).getAllByRole("button")[0]).toBe(parent);
    expect(parent).toHaveTextContent("返回上一级");
    fireEvent.click(parent);
    await screen.findByRole("button", { name: "src", exact: true });
    expect(api.directory).toHaveBeenLastCalledWith(project.id, "", 0);
    expect(api.file).not.toHaveBeenCalled();
  });

  it("references and opens the right-clicked file without implicitly reading it", async () => {
    show();
    await openEntryMenu("b.ts");
    expect(screen.getByRole("menuitem", { name: "在资源管理器中显示" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "使用系统应用打开" })).toHaveAttribute("data-disabled");
    expect(api.file).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "引用到当前会话" }));
    expect(useDevelopmentStore.getState().drafts.dev_files).toContain("b.ts");
    expect(api.file).not.toHaveBeenCalled();
    await openEntryMenu("b.ts");
    fireEvent.click(screen.getByRole("menuitem", { name: "打开", exact: true }));
    expect(await screen.findByRole("textbox", { name: "项目文件编辑器" })).toHaveValue("original");
    expect(api.file).toHaveBeenCalledWith(project.id, "b.ts");
  });

  it("copies the chosen entry's relative and Windows full paths and reports clipboard failure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    api.directory.mockImplementation(async (_id: string, path: string) => ({ entries: path
      ? ["a.ts", "b.ts"].map((name) => ({ path: `src/${name}`, name, kind: "file" }))
      : [{ path: "src", name: "src", kind: "directory" }], nextOffset: null }));
    render(<DevelopmentFiles project={{ ...project, rootPath: "D:\\repo\\work" }} sessionId="dev_files" />);
    await openEntryMenu("src");
    fireEvent.click(screen.getByRole("menuitem", { name: "复制完整路径" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("D:\\repo\\work\\src"));
    fireEvent.click(await screen.findByRole("button", { name: "src", exact: true }));
    await openEntryMenu("src/b.ts");
    fireEvent.click(screen.getByRole("menuitem", { name: "复制相对路径" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("src/b.ts"));
    await openEntryMenu("src/a.ts");
    fireEvent.click(screen.getByRole("menuitem", { name: "复制完整路径" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("D:\\repo\\work\\src\\a.ts"));
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await openEntryMenu("src/b.ts");
    fireEvent.click(screen.getByRole("menuitem", { name: "复制相对路径" }));
    expect(await screen.findByRole("dialog", { name: "操作未完成" })).toHaveTextContent("路径复制失败");
    expect(api.file).not.toHaveBeenCalled();
  });

  it("opens the right-clicked file with its system association without changing its cached draft", async () => {
    native.isTauri.mockReturnValue(true);
    api.directory.mockResolvedValue({ entries: [{ path: "src/index.html", name: "index.html", kind: "file" }], nextOffset: null });
    useDevelopmentStore.setState({ files: { [fileKey("dev_files", "src/index.html")]: {
      file: file("src/index.html"), draft: "unsaved content",
    } } });
    render(<DevelopmentFiles project={{ ...project, rootPath: "D:\\repo with spaces\\项目" }} sessionId="dev_files" />);
    await openEntryMenu("src/index.html");
    expect(screen.getAllByRole("menuitem").slice(0, 3).map((item) => item.textContent)).toEqual(["打开", "使用系统应用打开", "引用到当前会话"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "使用系统应用打开" }));
    await waitFor(() => expect(native.openPath).toHaveBeenCalledWith("D:\\repo with spaces\\项目\\src\\index.html"));
    expect(native.invoke).not.toHaveBeenCalled();
    expect(api.file).not.toHaveBeenCalled(); expect(api.saveFile).not.toHaveBeenCalled();
    expect(useDevelopmentStore.getState().selectedFiles.dev_files).toBeUndefined();
    expect(useDevelopmentStore.getState().files[fileKey("dev_files", "src/index.html")].draft).toBe("unsaved content");
  });

  it("uses the existing desktop fallback outside opener scope and reports a failed system open", async () => {
    native.isTauri.mockReturnValue(true);
    native.openPath.mockRejectedValue(new Error("path outside opener scope"));
    show(); await openEntryMenu("b.ts");
    fireEvent.click(screen.getByRole("menuitem", { name: "使用系统应用打开" }));
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("system_open_in_explorer", { path: "D:/files/b.ts" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    native.invoke.mockRejectedValueOnce(new Error("native failure"));
    await openEntryMenu("a.ts");
    fireEvent.click(screen.getByRole("menuitem", { name: "使用系统应用打开" }));
    const dialog = await screen.findByRole("dialog", { name: "操作未完成" });
    expect(dialog).toHaveTextContent("无法使用系统应用打开该文件");
    expect(dialog).not.toHaveTextContent("native failure");
    expect(api.file).not.toHaveBeenCalled(); expect(api.saveFile).not.toHaveBeenCalled();
  });

  it("reveals the chosen file or directory on desktop and reports a failed reveal", async () => {
    native.isTauri.mockReturnValue(true);
    api.directory.mockResolvedValue({ entries: [
      { path: "src/a.ts", name: "a.ts", kind: "file" }, { path: "src", name: "src", kind: "directory" },
    ], nextOffset: null });
    render(<DevelopmentFiles project={{ ...project, rootPath: "D:\\repo\\work" }} sessionId="dev_files" />);
    await openEntryMenu("src/a.ts");
    fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中显示" }));
    await waitFor(() => expect(native.revealItemInDir).toHaveBeenCalledWith("D:\\repo\\work\\src\\a.ts"));
    await openEntryMenu("src");
    fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中显示" }));
    await waitFor(() => expect(native.revealItemInDir).toHaveBeenCalledWith("D:\\repo\\work\\src"));
    native.revealItemInDir.mockRejectedValueOnce(new Error("native failure"));
    await openEntryMenu("src/a.ts");
    fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中显示" }));
    expect(await screen.findByRole("dialog", { name: "操作未完成" })).toHaveTextContent("无法在资源管理器中显示");
    expect(api.file).not.toHaveBeenCalled();
  });

  it("allows link path copying while disabling link opening and revealing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    native.isTauri.mockReturnValue(true);
    api.directory.mockResolvedValue({ entries: [{ path: "shortcut", name: "shortcut", kind: "link" }], nextOffset: null });
    show();
    const link = await screen.findByTitle("shortcut");
    expect(link).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(link);
    expect(api.file).not.toHaveBeenCalled();
    await openEntryMenu("shortcut");
    expect(screen.getByRole("menuitem", { name: "打开", exact: true })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "在资源管理器中显示" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "复制相对路径" })).not.toHaveAttribute("data-disabled");
    expect(screen.queryByRole("menuitem", { name: "引用到当前会话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "使用系统应用打开" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "复制相对路径" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("shortcut"));
    expect(native.revealItemInDir).not.toHaveBeenCalled();
  });

  it("switches from the file list to the editor and back instead of stacking them", async () => {
    show();
    expect(await screen.findByRole("region", { name: "项目文件列表" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新文件目录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "项目文件编辑器" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "a.ts", exact: true }));
    await screen.findByRole("textbox", { name: "项目文件编辑器" });
    expect(screen.queryByRole("region", { name: "项目文件列表" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上一级目录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新读取文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存", exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回文件列表" }));
    expect(screen.getByRole("region", { name: "项目文件列表" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "项目文件编辑器" })).not.toBeInTheDocument();
  });
  it("returns to the same directory and scroll position while preserving unsaved file drafts", async () => {
    api.directory.mockImplementation(async (_id: string, path: string) => ({ entries: path
      ? [{ path: "src/a.ts", name: "a.ts", kind: "file" }]
      : [{ path: "src", name: "src", kind: "directory" }], nextOffset: null }));
    show(); fireEvent.click(await screen.findByRole("button", { name: "src", exact: true }));
    const entry = await screen.findByRole("button", { name: "a.ts", exact: true });
    const list = screen.getByRole("region", { name: "项目文件列表" });
    list.scrollTop = 120; fireEvent.scroll(list);
    fireEvent.click(entry);
    const editor = await screen.findByRole("textbox", { name: "项目文件编辑器" });
    fireEvent.change(editor, { target: { value: "unsaved draft" } });
    fireEvent.click(screen.getByRole("button", { name: "返回文件列表" }));
    expect(screen.getByRole("button", { name: "a.ts", exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "src", exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "项目文件列表" }).scrollTop).toBe(120);
    fireEvent.click(screen.getByRole("button", { name: "a.ts", exact: true }));
    expect(await screen.findByRole("textbox", { name: "项目文件编辑器" })).toHaveValue("unsaved draft");
    expect(api.file).toHaveBeenCalledOnce();
    expect(api.saveFile).not.toHaveBeenCalled();
  });
  it("keeps directory navigation in control when an earlier file read finishes late", async () => {
    api.directory.mockImplementation(async (_id: string, path: string) => ({ entries: path ? [] : [
      { path: "a.ts", name: "a.ts", kind: "file" }, { path: "src", name: "src", kind: "directory" },
    ], nextOffset: null }));
    const pending = deferred<FileDocument>(); api.file.mockReturnValueOnce(pending.promise);
    show(); fireEvent.click(await screen.findByRole("button", { name: "a.ts", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "src", exact: true }));
    await screen.findByText("此目录为空");
    await act(async () => pending.resolve(file("a.ts", "late file")));
    expect(screen.getByRole("region", { name: "项目文件列表" })).toHaveTextContent("此目录为空");
    expect(screen.queryByRole("textbox", { name: "项目文件编辑器" })).not.toBeInTheDocument();
  });
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
    fireEvent.keyDown(editor, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(api.saveFile).toHaveBeenCalledOnce());
    fireEvent.change(editor, { target: { value: "newer unsaved" } });
    await act(async () => pending.resolve({ ...file("a.ts", "sent"), sha256: "saved" }));
    expect(useDevelopmentStore.getState().files[fileKey("dev_files", "a.ts")]).toEqual({
      file: { ...file("a.ts", "sent"), sha256: "saved" }, draft: "newer unsaved",
    });
  });
  it("confirms a lost save reply by reading without repeating the write or discarding newer typing", async () => {
    const confirmed = deferred<FileDocument>();
    api.saveFile.mockRejectedValue(new Error("response lost"));
    show(); fireEvent.click(await screen.findByRole("button", { name: "a.ts", exact: true }));
    const editor = await screen.findByRole("textbox", { name: "项目文件编辑器" });
    api.file.mockReturnValueOnce(confirmed.promise);
    fireEvent.change(editor, { target: { value: "sent" } });
    fireEvent.keyDown(editor, { key: "s", code: "KeyS", metaKey: true });
    await waitFor(() => expect(api.file).toHaveBeenCalledTimes(2));
    fireEvent.change(editor, { target: { value: "newer unsaved" } });
    await act(async () => confirmed.resolve({ ...file("a.ts", "sent"), sha256: "confirmed" }));
    expect(useDevelopmentStore.getState().files[fileKey("dev_files", "a.ts")]).toEqual({
      file: { ...file("a.ts", "sent"), sha256: "confirmed" }, draft: "newer unsaved",
    });
    expect(api.saveFile).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("keeps the original version and draft when readback finds a different file", async () => {
    api.saveFile.mockRejectedValue(new Error("文件版本冲突"));
    show(); fireEvent.click(await screen.findByRole("button", { name: "a.ts", exact: true }));
    const editor = await screen.findByRole("textbox", { name: "项目文件编辑器" });
    api.file.mockResolvedValue(file("a.ts", "external changes"));
    fireEvent.change(editor, { target: { value: "my draft" } });
    fireEvent.keyDown(editor, { key: "s", code: "KeyS", ctrlKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("文件版本冲突");
    expect(useDevelopmentStore.getState().files[fileKey("dev_files", "a.ts")]).toEqual({
      file: file("a.ts"), draft: "my draft",
    });
    expect(api.saveFile).toHaveBeenCalledOnce();
  });
  it("reports an unconfirmed save and retains the draft when readback also fails", async () => {
    api.saveFile.mockRejectedValue(new Error("response lost"));
    show(); fireEvent.click(await screen.findByRole("button", { name: "a.ts", exact: true }));
    const editor = await screen.findByRole("textbox", { name: "项目文件编辑器" });
    api.file.mockRejectedValue(new Error("read unavailable"));
    fireEvent.change(editor, { target: { value: "my draft" } });
    fireEvent.keyDown(editor, { key: "s", code: "KeyS", ctrlKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("保存结果暂未确认，编辑草稿仍保留");
    expect(editor).toHaveValue("my draft");
    expect(api.saveFile).toHaveBeenCalledOnce();
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
