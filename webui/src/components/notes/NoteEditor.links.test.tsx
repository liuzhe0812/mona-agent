import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  emitTo: vi.fn(),
  listen: vi.fn(),
  show: vi.fn(),
  unminimize: vi.fn(),
  setFocus: vi.fn(),
  message: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tauri")>(),
  isTauri: () => true,
  getNotesVaultPath: async () => null,
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo, listen: mocks.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: mocks.message }));
vi.mock("@/components/common/SelectionAiToolbar", () => ({ SelectionAiToolbar: () => null }));

import { listenForBrowserUrls } from "@/lib/browser-ipc";
import { MarkdownEditor } from "@/components/common/MarkdownEditor";
import { NoteEditor } from "./NoteEditor";
import type { OperationNote } from "./notes-data";

async function renderNote(contentMarkdown: string, onOpenNoteByTitle = vi.fn()) {
  const note: OperationNote = {
    id: "note-1",
    notebookId: "notebook-1",
    title: "参考资料",
    preview: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    source: { kind: "manual", label: "手动" },
    contentMarkdown,
  };
  const onContentChange = vi.fn();
  const result = render(
    <NoteEditor note={note} mode="visual" onTitleChange={vi.fn()}
      onContentChange={onContentChange} onOpenNoteByTitle={onOpenNoteByTitle} />,
  );
  let editor: Editor | undefined;
  await waitFor(() => {
    const element = result.container.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
    editor = element?.editor;
    expect(editor).toBeDefined();
  });
  return { ...result, editor: editor!, onContentChange };
}

describe("note web links", () => {
  beforeEach(() => {
    for (const mock of [mocks.invoke, mocks.emitTo, mocks.show, mocks.unminimize, mocks.setFocus, mocks.message]) {
      mock.mockReset().mockResolvedValue(undefined);
    }
    mocks.listen.mockReset().mockResolvedValue(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens named and plain web links in new Mona browser tabs", async () => {
    const onOpen = vi.fn();
    await listenForBrowserUrls(onOpen);
    const [eventName, receive] = mocks.listen.mock.calls[0];
    mocks.emitTo.mockImplementation(async (_target, _event, payload) => receive({ payload }));
    const { editor, onContentChange } = await renderNote(
      "[**Blizzard 怪物家族设计**](https://news.blizzard.com/en-us/article/23308274)\n\nhttps://www.leagueoflegends.com/en-us/news/dev/clarity-in-league/",
    );
    const links = editor.view.dom.querySelectorAll("a");
    expect(links).toHaveLength(2);
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 });

    const namedLinkText = links[0].querySelector("strong")!;
    fireEvent.mouseDown(namedLinkText, { clientX: 30, button: 0 });
    fireEvent.mouseUp(namedLinkText, { clientX: 30, button: 0 });
    expect(fireEvent.click(namedLinkText)).toBe(false);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(links[1], { clientX: 30, button: 0 });
    fireEvent.mouseUp(links[1], { clientX: 30, button: 0 });
    expect(fireEvent.click(links[1])).toBe(false);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));

    expect(mocks.emitTo.mock.calls).toEqual([
      ["main", eventName, { url: "https://news.blizzard.com/en-us/article/23308274" }],
      ["main", eventName, { url: "https://www.leagueoflegends.com/en-us/news/dev/clarity-in-league/" }],
    ]);
    expect(mocks.invoke.mock.calls.map(([, args]) => args)).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^tab-/), url: "https://news.blizzard.com/en-us/article/23308274" }),
      expect.objectContaining({ id: expect.stringMatching(/^tab-/), url: "https://www.leagueoflegends.com/en-us/news/dev/clarity-in-league/" }),
    ]);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onContentChange).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("does not navigate to relative or unsafe links and reports the failure", async () => {
    const { editor } = await renderNote("[相对链接](private.md)\n\n[不安全链接](javascript:alert%281%29)");
    const links = editor.view.dom.querySelectorAll("a");
    expect(links).toHaveLength(2);
    for (const [index, link] of Array.from(links).entries()) {
      expect(fireEvent.click(link)).toBe(false);
      await waitFor(() => expect(mocks.message).toHaveBeenCalledTimes(index + 1));
    }
    expect(mocks.emitTo).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.message).toHaveBeenCalledWith("链接未能打开，请检查地址后重试。", {
      title: "打开链接失败", kind: "error",
    });
  });

  it("keeps link text selection from opening a tab", async () => {
    const { editor } = await renderNote("[选择链接文字](https://example.com)");
    const link = editor.view.dom.querySelector("a")!;
    const range = document.createRange();
    range.setStart(link.firstChild!, 0);
    range.setEnd(link.firstChild!, 4);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    expect(fireEvent.click(link)).toBe(false);
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });

  it("opens a link after a previous selection is collapsed by the click", async () => {
    const { editor } = await renderNote("[选择链接文字](https://example.com)");
    const link = editor.view.dom.querySelector("a")!;
    act(() => { editor.commands.setTextSelection({ from: 1, to: 5 }); });
    document.getSelection()!.collapse(link.firstChild!, 0);
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(mocks.emitTo).toHaveBeenCalledWith("main", "browser-open-url", { url: "https://example.com/" }));
  });

  it("keeps wiki links routed to the target note", async () => {
    const openNote = vi.fn();
    const { editor } = await renderNote("[[关联笔记]]", openNote);
    const wikiLink = editor.view.dom.querySelector("[data-wiki-link]");
    expect(wikiLink).not.toBeNull();
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 1, inside: 1 });
    fireEvent.mouseDown(wikiLink!, { clientX: 30, button: 0 });
    fireEvent.mouseUp(wikiLink!, { clientX: 30, button: 0 });
    fireEvent.click(wikiLink!, { clientX: 30 });
    expect(openNote).toHaveBeenCalledWith("关联笔记");
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });

  it("reports failure to send a browser request", async () => {
    mocks.emitTo.mockRejectedValueOnce(new Error("internal error"));
    const { editor } = await renderNote("[参考](https://example.com/reference)");
    expect(fireEvent.click(editor.view.dom.querySelector("a")!)).toBe(false);
    await waitFor(() => expect(mocks.message).toHaveBeenCalledWith("链接未能打开，请检查地址后重试。", {
      title: "打开链接失败", kind: "error",
    }));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("retains the shared editor's existing link behavior outside notes", async () => {
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = render(<MarkdownEditor content="[参考](https://example.com)" mode="visual"
      showToolbar={false} showStats={false} onContentChange={vi.fn()} />);
    let editor: Editor | undefined;
    await waitFor(() => {
      const element = container.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
      editor = element?.editor;
      expect(editor).toBeDefined();
    });
    vi.spyOn(editor!.view, "posAtCoords").mockReturnValue({ pos: 1, inside: -1 });
    const link = editor!.view.dom.querySelector("a")!;
    fireEvent.mouseDown(link, { clientX: 30, button: 0 });
    fireEvent.mouseUp(link, { clientX: 30, button: 0 });
    expect(openWindow).toHaveBeenCalledWith("https://example.com/", "_blank");
    expect(mocks.emitTo).not.toHaveBeenCalled();
  });
});
