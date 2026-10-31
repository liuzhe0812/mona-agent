import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ status: vi.fn(), history: vi.fn() }));
vi.mock("@/lib/cloud-sync", () => ({ cloudSyncApi: api }));
import { SessionListPanel } from "./shell/SessionListPanel";

beforeEach(() => {
  api.status.mockReset().mockResolvedValue({ available: true, conversations: [
    { key: "websocket:first", resource_id: "a".repeat(32), version: 1 },
    { key: "websocket:second", resource_id: "b".repeat(32), version: 2 },
  ] });
  api.history.mockReset().mockResolvedValue({ items: [], has_more: false, next_before: 1 });
});

it("opens the selected Work conversation history outside the row menu", async () => {
  render(<SessionListPanel
    sessions={[
      { key: "websocket:first", channel: "websocket", chatId: "first", createdAt: null, updatedAt: null, title: "First", preview: "" },
      { key: "websocket:second", channel: "websocket", chatId: "second", createdAt: null, updatedAt: null, title: "Second", preview: "" },
      { key: "development:code", channel: "development", chatId: "code", createdAt: null, updatedAt: null, title: "Code", preview: "" },
    ]}
    activeKey={null} loading={false} onSelect={vi.fn()} onRequestDelete={vi.fn()} onTogglePin={vi.fn()}
    onRequestRename={vi.fn()} onToggleArchive={vi.fn()} onMarkAllRead={vi.fn()} onToggleArchived={vi.fn()}
    onStartDirect={vi.fn()} onSelectAgent={vi.fn()} onOpenExpertLibrary={vi.fn()} onNewRoom={vi.fn()}
  />);
  expect(api.status).not.toHaveBeenCalled();
  fireEvent.contextMenu(screen.getByTitle("Second"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Version history" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("Second");
  expect(api.status).toHaveBeenCalledOnce();
  expect(await screen.findByText("暂无历史版本")).toBeInTheDocument();
  expect(api.history).toHaveBeenCalledWith("b".repeat(32), undefined, expect.any(AbortSignal));
  fireEvent.click(screen.getByRole("button", { name: "关闭", exact: true }));
  fireEvent.contextMenu(screen.getByTitle("Code"));
  expect(screen.queryByRole("menuitem", { name: "Version history" })).not.toBeInTheDocument();
  expect(api.status).toHaveBeenCalledOnce();
});
