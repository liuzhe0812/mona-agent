import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownEditor } from "./MarkdownEditor";

async function renderEditor() {
  const { container } = render(
    <MarkdownEditor content="before target after" mode="visual" showToolbar={false} showStats={false} onContentChange={vi.fn()} />,
  );
  let editor: Editor | undefined;
  await waitFor(() => {
    const element = container.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
    editor = element?.editor;
    expect(editor).toBeDefined();
  });
  return editor!;
}

async function openLinkDialog(editor: Editor, entry: "direct" | "format") {
  act(() => {
    editor.chain().focus().setTextSelection({ from: 8, to: 14 }).run();
  });
  fireEvent.contextMenu(editor.view.dom, { button: 2, clientX: 30, clientY: 30 });
  if (entry === "format") {
    fireEvent.pointerMove(await screen.findByRole("menuitem", { name: "文本格式" }), { pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "添加链接" }));
  } else {
    fireEvent.click(await screen.findByRole("menuitem", { name: "新增外部链接" }));
  }
  return screen.findByRole("dialog", { name: "新增外部链接" });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarkdownEditor external link dialog", () => {
  it.each(["direct", "format"] as const)("adds a link to the original selection through the %s entry", async (entry) => {
    const nativePrompt = vi.spyOn(window, "prompt").mockImplementation(() => { throw new Error("native prompt is not allowed"); });
    const editor = await renderEditor();
    const dialog = await openLinkDialog(editor, entry);
    const input = within(dialog).getByRole("textbox", { name: "链接地址" });
    await waitFor(() => expect(input).toHaveFocus());

    // Focus can move into the dialog and change the editor's current selection.
    act(() => { editor.commands.setTextSelection(1); });
    fireEvent.change(input, { target: { value: "https://example.com/reference" } });
    if (entry === "direct") await userEvent.setup().keyboard("{Enter}");
    else fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新增外部链接" })).not.toBeInTheDocument());
    await waitFor(() => expect(editor.view.dom).toHaveFocus());
    const links = editor.view.dom.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent("target");
    expect(links[0]).toHaveAttribute("href", "https://example.com/reference");
    expect(editor.getText()).toBe("before target after");
    expect(nativePrompt).not.toHaveBeenCalled();
  });

  it("cancels without modifying the document and can be reopened", async () => {
    const nativePrompt = vi.spyOn(window, "prompt").mockImplementation(() => { throw new Error("native prompt is not allowed"); });
    const editor = await renderEditor();
    const before = editor.getJSON();
    const dialog = await openLinkDialog(editor, "direct");
    const input = within(dialog).getByRole("textbox", { name: "链接地址" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "https://example.com/ignored" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新增外部链接" })).not.toBeInTheDocument());
    await waitFor(() => expect(editor.view.dom).toHaveFocus());
    expect(editor.getJSON()).toEqual(before);

    const reopened = await openLinkDialog(editor, "direct");
    expect(within(reopened).getByRole("textbox", { name: "链接地址" })).toHaveValue("");
    fireEvent.click(within(reopened).getByRole("button", { name: "取消" }));
    expect(editor.getJSON()).toEqual(before);
    expect(nativePrompt).not.toHaveBeenCalled();
  });

  it("does not add a link to changed content while the dialog is open", async () => {
    const nativePrompt = vi.spyOn(window, "prompt").mockImplementation(() => { throw new Error("native prompt is not allowed"); });
    const editor = await renderEditor();
    const dialog = await openLinkDialog(editor, "direct");
    const input = within(dialog).getByRole("textbox", { name: "链接地址" });
    await waitFor(() => expect(input).toHaveFocus());

    act(() => { editor.commands.insertContentAt(1, "updated "); });
    const updated = editor.getJSON();
    fireEvent.change(input, { target: { value: "https://example.com/reference" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));

    expect(within(dialog).getByRole("alert")).toHaveTextContent("笔记内容已变化，请取消后重新选择文字。");
    expect(editor.getJSON()).toEqual(updated);
    expect(editor.view.dom.querySelector("a")).toBeNull();
    expect(nativePrompt).not.toHaveBeenCalled();
  });
});
