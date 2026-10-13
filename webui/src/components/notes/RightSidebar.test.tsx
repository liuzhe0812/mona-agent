import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { OperationNote } from "./notes-data";
import { RightSidebar, type RightTab } from "./RightSidebar";

vi.mock("@/lib/tauri", () => ({
  getNoteBacklinks: vi.fn().mockResolvedValue([]),
  getNoteMentions: vi.fn().mockResolvedValue([]),
}));

const note: OperationNote = {
  id: "note",
  notebookId: "root",
  title: "当前笔记",
  preview: "",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  source: { kind: "manual", label: "手动" },
  contentMarkdown: "## 章节标题\n\n[[目标笔记]]",
};

const linkedNote: OperationNote = {
  ...note,
  id: "target",
  title: "目标笔记",
  contentMarkdown: "",
};

function StatefulAiPanel() {
  const [count, setCount] = useState(0);
  return (
    <aside>
      <span data-testid="ai-count">{count}</span>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        增加 AI 计数
      </button>
    </aside>
  );
}

function RightSidebarHarness({ onSelectNote }: { onSelectNote?: (noteId: string) => void }) {
  const [open, setOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<RightTab>("ai");

  return (
    <>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {open ? "关闭右侧栏" : "打开右侧栏"}
      </button>
      <RightSidebar
        open={open}
        note={note}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        aiPanel={<StatefulAiPanel />}
        aiStreaming
        onSelectNote={onSelectNote}
        allNotes={[note, linkedNote]}
        width={320}
      />
    </>
  );
}

describe("RightSidebar", () => {
  it("shows AI assistant, outline, and links tabs in order", async () => {
    const user = userEvent.setup();
    render(<RightSidebarHarness />);

    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "AI助手",
      "大纲",
      "链接",
    ]);
    expect(
      screen.getByRole("tab", { name: "AI助手" }).querySelector(".mona-agent-logo"),
    ).toHaveClass("mona-agent-logo--working");
    expect(screen.getByRole("tab", { name: "AI助手" })).toHaveAttribute("data-state", "active");
    expect(screen.getByText("AI助手", { selector: "span" })).toBeVisible();
    await user.hover(screen.getByRole("tab", { name: "AI助手" }));
    expect(await screen.findByRole("tooltip", { name: "AI助手" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI助手" })).toHaveAttribute("data-state", "active");
  });

  it("keeps the AI panel mounted while switching tabs and closing the sidebar", async () => {
    const user = userEvent.setup();
    const onSelectNote = vi.fn();
    render(<RightSidebarHarness onSelectNote={onSelectNote} />);

    fireEvent.click(screen.getByRole("button", { name: "增加 AI 计数" }));
    await user.click(screen.getByRole("tab", { name: "大纲" }));
    expect(screen.getByRole("tab", { name: "大纲" })).toHaveAttribute("data-state", "active");
    expect(screen.getByRole("button", { name: "章节标题" })).toBeVisible();
    expect(screen.getByTestId("ai-count")).toHaveTextContent("1");
    expect(screen.getByTestId("ai-count")).not.toBeVisible();

    await user.click(screen.getByRole("tab", { name: "链接" }));
    const outgoingLink = await screen.findByRole("button", { name: "目标笔记" });
    fireEvent.click(outgoingLink);
    expect(onSelectNote).toHaveBeenCalledWith("target");

    fireEvent.click(screen.getByRole("button", { name: "关闭右侧栏" }));
    expect(screen.queryByRole("tab", { name: "AI助手" })).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-count")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "打开右侧栏" }));
    await user.click(screen.getByRole("tab", { name: "AI助手" }));

    expect(screen.getByTestId("ai-count")).toHaveTextContent("1");
    expect(screen.getByTestId("ai-count")).toBeVisible();
  });
});
