import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type FakeEditor = {
  getMarkdown: () => string;
  getJSON: () => Record<string, never>;
  getText: () => string;
  view: { dom: HTMLElement };
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
};

type UpdateHandler = (params: { editor: FakeEditor }) => void;
type CreateHandler = (params: { editor: FakeEditor }) => void;

const editorHarness = vi.hoisted(() => {
  let markdown = "# 已有内容";
  const editor: FakeEditor = {
    getMarkdown: () => markdown,
    getJSON: () => ({}),
    getText: () => "已有内容",
    view: { dom: document.createElement("div") },
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    editor,
    get markdown() { return markdown; },
    set markdown(value: string) { markdown = value; },
    onCreate: null as CreateHandler | null,
    onUpdate: null as UpdateHandler | null,
  };
});

vi.mock("@tiptap/react", async () => {
  const actual = await vi.importActual<typeof import("@tiptap/react")>("@tiptap/react");
  return {
    ...actual,
    useEditor: (options: { onCreate?: CreateHandler; onUpdate?: UpdateHandler }) => {
      editorHarness.onCreate = options.onCreate ?? null;
      editorHarness.onUpdate = options.onUpdate ?? null;
      return editorHarness.editor;
    },
    EditorContent: () => null,
  };
});

import { MarkdownEditor } from "./MarkdownEditor";

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
});
