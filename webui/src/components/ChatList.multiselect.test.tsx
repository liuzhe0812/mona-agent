import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatList } from "./ChatList";
import { SessionListPanel } from "./shell/SessionListPanel";
import type { ChatSummary } from "@/lib/types";

const key = (id: string) => `websocket:${id}`;

function session(id: string, title: string, hour: number, workspace?: string): ChatSummary {
  const timestamp = `2026-10-01T${String(hour).padStart(2, "0")}:00:00Z`;
  return {
    key: key(id),
    channel: "websocket",
    chatId: id,
    title,
    preview: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    workspace,
  };
}

function callbacks() {
  return {
    onSelect: vi.fn(),
    onRequestDelete: vi.fn(),
    onTogglePin: vi.fn(),
    onRequestRename: vi.fn(),
    onToggleArchive: vi.fn(),
    onMarkAllRead: vi.fn(),
    onBatchPin: vi.fn(),
    onBatchArchive: vi.fn(),
    onRequestBatchDelete: vi.fn(),
  };
}

const sessions = [
  session("a", "Alpha", 12),
  session("b", "Beta", 11),
  session("c", "Charlie", 10),
  session("d", "Delta", 9),
];

function selectRange(first: string, last: string) {
  fireEvent.click(screen.getByTitle(first));
  fireEvent.click(screen.getByTitle(last), { shiftKey: true });
}

describe("ChatList multiple selection", () => {
  it.each([
    { name: "Pin", action: "pin" },
    { name: "Archive", action: "archive" },
    { name: "Delete", action: "delete" },
  ])("applies $name to the visible Shift-selected range", async ({ name, action }) => {
    const handlers = callbacks();
    render(<ChatList sessions={sessions} activeKey={null} {...handlers} />);

    selectRange("Alpha", "Charlie");

    expect(handlers.onSelect).toHaveBeenCalledOnce();
    expect(handlers.onSelect).toHaveBeenCalledWith(key("a"));
    for (const title of ["Alpha", "Beta", "Charlie"]) {
      expect(screen.getByTitle(title)).toHaveAttribute("aria-pressed", "true");
    }
    expect(screen.getByTitle("Delta")).not.toHaveAttribute("aria-pressed", "true");

    fireEvent.contextMenu(screen.getByTitle("Beta"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.trim())).toEqual(["Pin", "Archive", "Delete"]);
    fireEvent.click(screen.getByRole("menuitem", { name }));

    const selected = [key("a"), key("b"), key("c")];
    if (action === "pin") expect(handlers.onBatchPin).toHaveBeenCalledWith(selected, true);
    if (action === "archive") expect(handlers.onBatchArchive).toHaveBeenCalledWith(selected, true);
    if (action === "delete") {
      await waitFor(() => expect(handlers.onRequestBatchDelete).toHaveBeenCalledWith(selected));
    }
  });

  it("pins a mixed selection without toggling its already pinned sessions", async () => {
    const handlers = callbacks();
    const projectSessions = sessions.map((item) => ({ ...item, workspace: "D:\\work\\Project" }));
    render(
      <ChatList
        sessions={projectSessions}
        activeKey={null}
        pinnedKeys={[key("a")]}
        {...handlers}
      />,
    );

    selectRange("Alpha", "Charlie");
    fireEvent.contextMenu(screen.getByTitle("Beta"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));

    expect(handlers.onBatchPin).toHaveBeenCalledWith([key("a"), key("b"), key("c")], true);
    expect(handlers.onTogglePin).not.toHaveBeenCalled();
  });

  it("uses single-session actions when right-clicking outside the selection", async () => {
    const handlers = callbacks();
    render(<ChatList sessions={sessions} activeKey={null} {...handlers} />);

    selectRange("Alpha", "Charlie");
    fireEvent.contextMenu(screen.getByTitle("Delta"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));

    expect(handlers.onTogglePin).toHaveBeenCalledWith(key("d"));
    expect(handlers.onBatchPin).not.toHaveBeenCalled();
  });

  it("excludes sessions hidden by a collapsed project from a bulk action", async () => {
    const handlers = callbacks();
    const grouped = sessions.map((item, index) => index < 2
      ? { ...item, workspace: "D:\\work\\Project" }
      : item);
    render(<ChatList sessions={grouped} activeKey={null} {...handlers} />);

    selectRange("Alpha", "Delta");
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.queryByTitle("Alpha")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Beta")).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTitle("Charlie"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    expect(handlers.onBatchArchive).toHaveBeenCalledWith([key("c"), key("d")], true);
  });

  it("excludes sessions hidden by search from a bulk action", async () => {
    const handlers = callbacks();
    const searchable = [
      session("a", "Other Alpha", 12),
      session("b", "Other Beta", 11),
      session("c", "Keep Charlie", 10),
      session("d", "Keep Delta", 9),
    ];
    render(
      <SessionListPanel
        sessions={searchable}
        activeKey={null}
        loading={false}
        onToggleArchived={vi.fn()}
        onStartDirect={vi.fn()}
        onSelectAgent={vi.fn()}
        onOpenExpertLibrary={vi.fn()}
        onNewRoom={vi.fn()}
        {...handlers}
      />,
    );

    selectRange("Other Alpha", "Keep Delta");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Keep" } });
    expect(screen.queryByTitle("Other Alpha")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Other Beta")).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTitle("Keep Charlie"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    expect(handlers.onBatchArchive).toHaveBeenCalledWith([key("c"), key("d")], true);
  });
});
