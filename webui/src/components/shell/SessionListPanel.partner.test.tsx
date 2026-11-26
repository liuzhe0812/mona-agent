import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionListPanel } from "./SessionListPanel";

vi.mock("@/providers/ClientProvider", () => ({
  useClientContextOrNull: () => null,
}));
vi.mock("@/components/room/useAgents", () => ({
  invalidateAgents: vi.fn(),
  useAgents: () => new Map([
    ["mona", { id: "mona", displayName: "Mona", enabled: true }],
    ["partner.cindy", { id: "partner.cindy", displayName: "Cindy", enabled: true }],
    ["partner.test", { id: "partner.test", displayName: "Test", enabled: true }],
    ["partner.disabled", { id: "partner.disabled", displayName: "Disabled", enabled: false }],
  ]),
}));

const sessions = [
  {
    key: "websocket:task", channel: "websocket", chatId: "task",
    createdAt: null, updatedAt: null, title: "Mona task", preview: "Task result",
  },
  {
    key: "websocket:partner", channel: "websocket", chatId: "partner",
    createdAt: null, updatedAt: null, title: "Cindy", preview: "Latest partner reply",
    conversation: { type: "direct" as const, title: "Cindy", agentIds: ["partner.cindy"], directAgentId: "partner.cindy", partnerConversation: true },
  },
  {
    key: "websocket:legacy", channel: "websocket", chatId: "legacy",
    createdAt: null, updatedAt: null, title: "Older partner task", preview: "Previous result",
    conversation: { type: "direct" as const, title: "Cindy", agentIds: ["partner.cindy"], directAgentId: "partner.cindy" },
  },
  {
    key: "websocket:restored", channel: "websocket", chatId: "restored",
    createdAt: null, updatedAt: null, title: "Restored partner history", preview: "Recovered result",
    conversation: { type: "direct" as const, title: "Cindy", agentIds: ["partner.cindy"], directAgentId: "partner.cindy", partnerConversation: true },
  },
  {
    key: "websocket:disabled", channel: "websocket", chatId: "disabled",
    createdAt: null, updatedAt: null, title: "Disabled partner history", preview: "Saved result",
    conversation: { type: "direct" as const, title: "Disabled", agentIds: ["partner.disabled"], directAgentId: "partner.disabled", partnerConversation: true },
  },
];

function renderPanel(overrides: Partial<Parameters<typeof SessionListPanel>[0]> = {}) {
  const onStartDirect = vi.fn();
  const onNewTask = vi.fn();
  const result = render(<SessionListPanel
    sessions={sessions}
    activeKey="websocket:partner"
    loading={false}
    onSelect={vi.fn()}
    onRequestDelete={vi.fn()}
    onTogglePin={vi.fn()}
    onRequestRename={vi.fn()}
    onToggleArchive={vi.fn()}
    onMarkAllRead={vi.fn()}
    onToggleArchived={vi.fn()}
    onStartDirect={onStartDirect}
    onNewTask={onNewTask}
    onOpenExpertLibrary={vi.fn()}
    onNewRoom={vi.fn()}
    {...overrides}
  />);
  return { ...result, onStartDirect, onNewTask };
}

describe("partner conversations in SessionListPanel", () => {
  beforeEach(() => {
    localStorage.removeItem("mona-webui.sidebar.partner-view");
    localStorage.removeItem("mona-webui.sidebar.conversations-collapsed");
  });

  it("shows one persistent row per enabled partner and preserves older tasks", () => {
    const { onStartDirect, onNewTask } = renderPanel();
    const cindy = screen.getByRole("button", { name: /Cindy.*Latest partner reply/ });
    expect(cindy).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /Test.*Start a conversation/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Older partner task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restored partner history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disabled partner history" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cindy", exact: true })).not.toBeInTheDocument();
    const task = screen.getByRole("button", { name: "Mona task" });
    expect(task).toHaveClass("h-8");
    expect(task.querySelector("img, svg")).toBeNull();
    expect(within(task).queryByText("Task result")).not.toBeInTheDocument();

    fireEvent.click(cindy);
    expect(onStartDirect).toHaveBeenCalledWith("partner.cindy");
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(onNewTask).toHaveBeenCalledOnce();
  });

  it("searches partner previews and tasks independently", () => {
    renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Latest partner" } });
    expect(screen.getByRole("button", { name: /Cindy.*Latest partner reply/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Older partner task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "Older partner task" } });
    expect(screen.getByRole("button", { name: "Older partner task" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cindy.*Latest partner reply/ })).not.toBeInTheDocument();
  });

  it("shows unread and opening status on the partner row", () => {
    renderPanel({ unreadKeys: ["websocket:partner", "websocket:task"], openingPartnerId: "partner.cindy", runningChatIds: ["task"] });
    const cindy = screen.getByRole("button", { name: /Cindy.*Latest partner reply/ });
    expect(within(cindy).getByLabelText("Unread")).toBeInTheDocument();
    expect(within(cindy).getByLabelText("Opening conversation")).toBeInTheDocument();
    const task = screen.getByRole("button", { name: "Mona task" });
    expect(within(task).getByLabelText("Unread")).toBeInTheDocument();
    expect(within(task).getByRole("img", { name: "Agent running" })).toBeInTheDocument();
  });

  it("shows the partner menu and moves hidden partners to rows with show and delete actions", async () => {
    const onTogglePartnerPin = vi.fn();
    const onTogglePartnerHidden = vi.fn();
    const onRequestDeletePartner = vi.fn();
    renderPanel({
      partnerPinnedKeys: ["partner.test"],
      partnerHiddenKeys: ["partner.cindy"],
      onTogglePartnerPin,
      onTogglePartnerHidden,
      onRequestDeletePartner,
    });
    const test = screen.getByRole("button", { name: /Test.*Start a conversation/ });
    const show = screen.getByRole("button", { name: "Show Cindy" });
    expect(screen.getByText("Hidden (1)")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Cindy.*Latest partner reply/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Older partner task" })).toBeVisible();

    fireEvent.keyDown(test, { key: "F10", shiftKey: true });
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Unpin", "Hide", "Duplicate partner", "Delete permanently",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(onTogglePartnerPin).toHaveBeenCalledWith("partner.test");
    fireEvent.contextMenu(test);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide" }));
    expect(onTogglePartnerHidden).toHaveBeenCalledWith("partner.test");
    fireEvent.click(show);
    expect(onTogglePartnerHidden).toHaveBeenCalledWith("partner.cindy");
    fireEvent.click(screen.getByRole("button", { name: "Permanently delete Cindy" }));
    expect(onRequestDeletePartner).toHaveBeenCalledWith("partner.cindy", "Cindy", undefined);
  });

  it("folds only the hidden partners and remembers the choice", () => {
    const props = { partnerHiddenKeys: ["partner.cindy"] };
    const panel = renderPanel(props);
    const heading = screen.getByRole("button", { name: "Hidden (1)", expanded: true });
    const show = screen.getByRole("button", { name: "Show Cindy" });

    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(show).not.toBeVisible();
    expect(screen.getByRole("button", { name: /Test.*Start a conversation/ })).toBeVisible();

    panel.unmount();
    renderPanel(props);
    fireEvent.click(screen.getByRole("button", { name: "Hidden (1)", expanded: false }));
    expect(screen.getByRole("button", { name: "Show Cindy" })).toBeVisible();
  });

  it("collapses only the conversation list, remembers it, and opens a new chat from its header", () => {
    const panel = renderPanel();
    const heading = screen.getByRole("button", { name: "Conversations", expanded: true });
    const task = screen.getByRole("button", { name: "Mona task" });
    expect(document.getElementById(heading.getAttribute("aria-controls")!)).toContainElement(task);
    expect(heading.closest(".session-list-scrollbar")).toBeNull();

    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(task).not.toBeVisible();
    expect(screen.getByRole("button", { name: /Cindy.*Latest partner reply/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(panel.onNewTask).toHaveBeenCalledOnce();
    expect(task).not.toBeVisible();

    panel.unmount();
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Conversations", expanded: false }));
    expect(screen.getByRole("button", { name: "Mona task" })).toBeVisible();
  });

  it("keeps partners above the task viewport, folds them and remembers the icon layout", async () => {
    const panel = renderPanel();
    const heading = screen.getByRole("button", { name: "Partners", expanded: true });
    const partnerList = document.getElementById(heading.getAttribute("aria-controls")!)!;
    const scrollArea = screen.getByRole("button", { name: "Mona task" }).closest(".session-list-scrollbar");
    expect(scrollArea).not.toContainElement(partnerList);
    expect(partnerList).toHaveClass("overflow-y-auto");
    expect(partnerList.parentElement).toHaveClass("max-h-[40%]");
    expect(scrollArea?.parentElement?.querySelector(".session-list-scrollbar-thumb")).toHaveClass("right-1");

    fireEvent.click(heading);
    expect(partnerList).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Mona task" })).toBeVisible();
    fireEvent.click(heading);

    const display = screen.getByRole("button", { name: "Partner display" });
    fireEvent.keyDown(display, { key: "Enter" });
    expect(await screen.findByRole("menuitemradio", { name: "List", checked: true })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Icons" }));
    expect(screen.queryByText("Latest partner reply")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cindy" }));
    expect(panel.onStartDirect).toHaveBeenCalledWith("partner.cindy");

    fireEvent.click(heading);
    panel.unmount();
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Partners", expanded: false }));
    expect(screen.getByRole("button", { name: "Cindy" })).toBeVisible();
  });
});
