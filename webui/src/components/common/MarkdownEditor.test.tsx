import { render } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it, vi } from "vitest";

type CommandChain = {
  focus: ReturnType<typeof vi.fn>;
  insertContent: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
};

type FakeEditor = {
  getMarkdown: () => string;
  getJSON: () => Record<string, never>;
  getText: () => string;
  chain: () => CommandChain;
  view: { dom: HTMLElement };
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
};

type UpdateHandler = (params: { editor: FakeEditor }) => void;
type CreateHandler = (params: { editor: FakeEditor }) => void;
type PasteHandler = (view: unknown, event: ClipboardEvent) => boolean;

const editorHarness = vi.hoisted(() => {
  let markdown = "# 已有内容";
  const commandChain = {
    focus: vi.fn(),
    insertContent: vi.fn(),
    run: vi.fn(() => true),
  };
  commandChain.focus.mockReturnValue(commandChain);
  commandChain.insertContent.mockReturnValue(commandChain);
  const editor: FakeEditor = {
    getMarkdown: () => markdown,
    getJSON: () => ({}),
    getText: () => "已有内容",
    chain: () => commandChain,
    view: { dom: document.createElement("div") },
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    editor,
    get markdown() { return markdown; },
    set markdown(value: string) { markdown = value; },
    commandChain,
    onCreate: null as CreateHandler | null,
    onUpdate: null as UpdateHandler | null,
    handlePaste: null as PasteHandler | null,
  };
});

vi.mock("@tiptap/react", async () => {
  const actual = await vi.importActual<typeof import("@tiptap/react")>("@tiptap/react");
  return {
    ...actual,
    useEditor: (options: {
      editorProps?: { handlePaste?: PasteHandler };
      onCreate?: CreateHandler;
      onUpdate?: UpdateHandler;
    }) => {
      editorHarness.handlePaste = options.editorProps?.handlePaste ?? null;
      editorHarness.onCreate = options.onCreate ?? null;
      editorHarness.onUpdate = options.onUpdate ?? null;
      return editorHarness.editor;
    },
    EditorContent: () => null,
  };
});

import { insertClipboardText, MarkdownEditor } from "./MarkdownEditor";

describe("MarkdownEditor", () => {
  it("does not report an update when the editor markdown is unchanged", async () => {
    const onContentChange = vi.fn();
    render(
      <MarkdownEditor
        content="# 已有内容"
        mode="markdown"
        showToolbar={false}
        onContentChange={onContentChange}
      />,
    );

    editorHarness.onCreate?.({ editor: editorHarness.editor });
    editorHarness.onUpdate?.({ editor: editorHarness.editor });
    await Promise.resolve();

    expect(onContentChange).not.toHaveBeenCalled();

    editorHarness.markdown = "# 用户修改后的内容";
    editorHarness.onUpdate?.({ editor: editorHarness.editor });
    await Promise.resolve();

    expect(onContentChange).toHaveBeenCalledOnce();
  });

  it("parses regular clipboard text as Markdown in visual mode", () => {
    render(
      <MarkdownEditor
        content="# 已有内容"
        mode="visual"
        showToolbar={false}
        onContentChange={vi.fn()}
      />,
    );
    const preventDefault = vi.fn();
    const clipboardData = {
      items: [],
      getData: vi.fn((type: string) => type === "text/plain" ? "# 新标题\n\n- 条目" : ""),
    };

    const handled = editorHarness.handlePaste?.(
      {},
      { clipboardData, preventDefault } as unknown as ClipboardEvent,
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(editorHarness.commandChain.insertContent).toHaveBeenCalledWith(
      "# 新标题\n\n- 条目",
      { contentType: "markdown" },
    );
  });

  it("leaves non-Markdown HTML clipboard content to the native rich-text paste", () => {
    render(
      <MarkdownEditor
        content="# 已有内容"
        mode="visual"
        showToolbar={false}
        onContentChange={vi.fn()}
      />,
    );
    const preventDefault = vi.fn();
    const clipboardData = {
      items: [],
      getData: vi.fn((type: string) => {
        if (type === "text/plain") return "带格式的正文";
        if (type === "text/html") return "<p><strong>带格式的正文</strong></p>";
        return "";
      }),
    };

    const handled = editorHarness.handlePaste?.(
      {},
      { clipboardData, preventDefault } as unknown as ClipboardEvent,
    );

    expect(handled).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("keeps Markdown and HTML syntax literal for plain-text paste", () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown],
      content: "",
      contentType: "markdown",
    });

    insertClipboardText(editor, "# 新标题\n<strong>正文</strong>", "plain");

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "# 新标题" },
        { type: "hardBreak" },
        { type: "text", text: "<strong>正文</strong>" },
      ],
    });
    editor.destroy();
  });

  it("creates heading and list nodes from pasted Markdown", () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown],
      content: "",
      contentType: "markdown",
    });

    insertClipboardText(editor, "# 新标题\n\n- 条目", "markdown");

    expect(editor.getJSON().content?.slice(0, 2).map((node) => node.type)).toEqual([
      "heading",
      "bulletList",
    ]);
    editor.destroy();
  });
});
