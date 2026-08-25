import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OperationNote } from "./notes-data";
import { NoteTabBar } from "./NoteTabBar";

const note = (id: string, title: string): OperationNote => ({
  id,
  notebookId: "root",
  title,
  preview: "",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  source: { kind: "manual", label: "手动" },
  contentMarkdown: "",
});

describe("NoteTabBar visual states", () => {
  it("uses a red bottom signal for the active note and neutral hover classes", () => {
    render(
      <NoteTabBar
        tabs={[note("active", "当前笔记"), note("other", "另一篇")]} activeNoteId="active"
        onSelect={vi.fn()} onClose={vi.fn()} onCloseOthers={vi.fn()} onCloseAll={vi.fn()}
      />,
    );

    const active = screen.getByText("当前笔记").closest("button");
    const other = screen.getByText("另一篇").closest("button");
    expect(active).toHaveClass("bg-transparent");
    expect(active?.querySelector('[aria-hidden="true"]')).toHaveClass(
      "bg-[hsl(var(--brand-red))]",
    );
    expect(active).not.toHaveClass("bg-background", "bg-info");
    expect(other).toHaveClass("bg-transparent", "hover:bg-foreground/[0.06]");

    const close = active?.querySelector('[role="button"]');
    expect(close).toBeTruthy();
    fireEvent.click(close!);
  });
});
