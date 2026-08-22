import { createElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatList, overlayScrollbarGeometry } from "./ChatList";

describe("overlayScrollbarGeometry", () => {
  it("tracks a proportional overlay thumb and hides it without overflow", () => {
    expect(overlayScrollbarGeometry(400, 1_000, 300)).toEqual({
      height: 160,
      offset: 120,
    });
    expect(overlayScrollbarGeometry(400, 400, 0)).toBeNull();
  });
});

describe("ChatList context menu", () => {
  it("marks every conversation read from a row context menu", async () => {
    const onMarkAllRead = vi.fn();
    render(createElement(ChatList, {
      sessions: [{
        key: "websocket:a",
        channel: "websocket",
        chatId: "a",
        createdAt: "2026-08-18T10:00:00Z",
        updatedAt: "2026-08-18T10:00:00Z",
        preview: "Agent reply",
        previewAt: "2026-08-18T10:00:00Z",
        previewAuthorType: "agent",
      }],
      activeKey: null,
      onSelect: vi.fn(),
      onRequestDelete: vi.fn(),
      onTogglePin: vi.fn(),
      onRequestRename: vi.fn(),
      onToggleArchive: vi.fn(),
      onMarkAllRead,
      unreadKeys: ["websocket:a"],
      searchMode: true,
    }));

    fireEvent.contextMenu(screen.getByTitle("Agent reply"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark all as read" }));

    expect(onMarkAllRead).toHaveBeenCalledOnce();
  });

  it("groups every workspace session under Projects", () => {
    const onCreateTask = vi.fn();
    render(createElement(ChatList, {
      sessions: [
        {
          key: "websocket:project",
          channel: "websocket",
          chatId: "project",
          createdAt: "2026-08-18T10:00:00Z",
          updatedAt: "2026-08-18T10:00:00Z",
          preview: "Project task",
          workspace: "D:\\work\\AlphaProject",
        },
        {
          key: "websocket:project-2",
          channel: "websocket",
          chatId: "project-2",
          createdAt: "2026-08-18T09:30:00Z",
          updatedAt: "2026-08-18T09:30:00Z",
          preview: "Second project task",
          workspace: "D:\\work\\AlphaProject",
        },
        {
          key: "websocket:regular",
          channel: "websocket",
          chatId: "regular",
          createdAt: "2026-08-18T09:00:00Z",
          updatedAt: "2026-08-18T09:00:00Z",
          preview: "Regular task",
        },
      ],
      activeKey: null,
      onSelect: vi.fn(),
      onRequestDelete: vi.fn(),
      onTogglePin: vi.fn(),
      onRequestRename: vi.fn(),
      onToggleArchive: vi.fn(),
      onCreateTask,
      pinnedKeys: ["websocket:project"],
      searchMode: true,
    }));

    const projects = screen.getByRole("region", { name: "AlphaProject" });
    expect(within(projects).getByTitle("Project task")).toBeInTheDocument();
    expect(within(projects).getByTitle("Second project task")).toBeInTheDocument();
    expect(within(projects).queryByTitle("Regular task")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Mona" })).getByTitle("Regular task")).toBeInTheDocument();

    fireEvent.click(within(projects).getByRole("button", { name: "New chat in project" }));
    expect(onCreateTask).toHaveBeenCalledWith("D:\\work\\AlphaProject");

    fireEvent.click(within(projects).getByRole("button", { name: "AlphaProject" }));
    expect(within(projects).queryByTitle("Project task")).not.toBeInTheDocument();
  });
});
