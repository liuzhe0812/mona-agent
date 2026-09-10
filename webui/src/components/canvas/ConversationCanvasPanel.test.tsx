import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationCanvasTab } from "./useConversationCanvases";

const state = vi.hoisted(() => ({ editorRenders: 0 }));

vi.mock("@/components/notes/flowchart/FlowchartDocumentEditor", () => ({
  FlowchartDocumentEditor: () => {
    state.editorRenders += 1;
    return <div>flowchart editor</div>;
  },
}));

vi.mock("@/components/notes/mindmap/MindMapDocumentEditor", () => ({
  MindMapDocumentEditor: () => <div>mindmap editor</div>,
}));

import { ConversationCanvasPanel } from "./ConversationCanvasPanel";

const canvas = {
  id: "canvas:one",
  note: {
    id: "one",
    title: "画布",
    type: "flowchart",
    contentMarkdown: "# 画布",
  },
  generationStatus: "creating",
  saveStatus: "saved",
} as ConversationCanvasTab;

describe("ConversationCanvasPanel", () => {
  it("does not rebuild the editor when an unchanged parent receives stream updates", () => {
    state.editorRenders = 0;
    const onContentChange = vi.fn();
    function Host() {
      const [frames, setFrames] = useState(0);
      return <>
        <button onClick={() => setFrames((value) => value + 1)}>stream {frames}</button>
        <ConversationCanvasPanel canvas={canvas} onContentChange={onContentChange} />
      </>;
    }

    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "stream 0" }));
    fireEvent.click(screen.getByRole("button", { name: "stream 1" }));

    expect(state.editorRenders).toBe(1);
  });
});
