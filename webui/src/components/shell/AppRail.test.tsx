import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_MODULE_DEFS = vi.hoisted(() => [
  { key: "note", label: "笔记", icon: null },
  { key: "stock", label: "股票", icon: null },
]);
const mockLicense = vi.hoisted(() => ({
  loggedIn: false,
  licenseInfo: null as { account: string | null; email: string | null } | null,
}));
const isTauriMock = vi.hoisted(() => vi.fn(() => false));
const popup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const close = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const menuNew = vi.hoisted(() => vi.fn().mockResolvedValue({ popup, close }));
vi.mock("@/components/Sidebar", () => ({
  MODULE_DEFS: MOCK_MODULE_DEFS,
  mergeSidebarModules: (
    user?: Array<{ key: string; visible: boolean; order: number }> | null,
  ) =>
    MOCK_MODULE_DEFS.map((d, i) => {
      const u = user?.find((m) => m.key === d.key);
      return u
        ? { key: d.key, visible: u.visible, order: u.order }
        : { key: d.key, visible: true, order: i };
    }).sort((a, b) => a.order - b.order),
}));
vi.mock("@/components/email/store/emailStore", () => ({
  useEmailStore: (selector: (state: { totalUnreadCount: number }) => unknown) =>
    selector({ totalUnreadCount: 0 }),
}));
vi.mock("@/components/schedule/todoStore", () => ({
  useTodoStore: (selector: (state: { inboxCount: number }) => unknown) =>
    selector({ inboxCount: 0 }),
}));
vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => mockLicense,
}));
vi.mock("@/lib/tauri", () => ({ isTauri: isTauriMock }));
vi.mock("@tauri-apps/api/menu", () => ({ Menu: { new: menuNew } }));

import { AppRail } from "./AppRail";

const noop = vi.fn();

function renderRail(extra?: Partial<Parameters<typeof AppRail>[0]>) {
  return render(
    <AppRail
      activeView="chat"
      onGoHome={noop}
      onOpenMessages={noop}
      onOpenNote={noop}
      onOpenDoc={noop}
      onOpenSSH={noop}
      onOpenDb={noop}
      onOpenEmail={noop}
      onOpenSchedule={noop}
      onOpenSystem={noop}
      onOpenProfile={noop}
      onOpenStock={noop}
      onOpenSettings={noop}
      onOpenLogin={noop}
      {...extra}
    />,
  );
}

describe("AppRail", () => {
  beforeEach(() => {
    mockLicense.loggedIn = false;
    mockLicense.licenseInfo = null;
    isTauriMock.mockReturnValue(false);
    menuNew.mockClear();
    popup.mockClear();
    close.mockClear();
  });

  it("keeps login reachable while logged out and exposes message attention", () => {
    renderRail({ messageAttentionCount: 3 });

    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    const messages = screen.getByRole("button", { name: "Sessions" });
    expect(within(messages).getByText("3")).toBeInTheDocument();
    expect(messages.querySelector("[aria-hidden]"))?.toHaveClass("text-theme");
  });

  it("routes stock module clicks to onOpenStock when the module is available", () => {
    const onOpenStock = vi.fn();
    renderRail({ onOpenStock, moduleAvailability: { stock: true } });

    fireEvent.click(screen.getByRole("button", { name: "Stocks" }));
    expect(onOpenStock).toHaveBeenCalledTimes(1);
  });

  it("uses the Mona signal instead of a filled active background", () => {
    renderRail({ activeView: "note" });

    const notes = screen.getByRole("button", { name: "Notes" });
    expect(notes).toHaveClass("before:bg-[hsl(var(--brand-red))]");
    expect(notes).not.toHaveClass("bg-[hsl(var(--sidebar-active-surface)/0.07)]");
  });

  it("hides the stock module when moduleAvailability marks it unavailable", () => {
    renderRail({ moduleAvailability: { stock: false } });

    expect(screen.queryByRole("button", { name: "Stocks" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notes" })).toBeInTheDocument();
  });

  it("opens general settings directly when the signed-in user area is clicked", () => {
    mockLicense.loggedIn = true;
    mockLicense.licenseInfo = { account: "mona-user", email: "user@example.com" };
    const onOpenSettings = vi.fn();
    renderRail({ onOpenSettings });

    fireEvent.click(screen.getByRole("button", { name: "mona-user" }));

    expect(onOpenSettings).toHaveBeenCalledWith("general");
  });

  it("shows a breathing red update icon when an update is available", () => {
    const onStartUpdate = vi.fn();
    renderRail({ updateAvailable: true, onStartUpdate });

    const update = screen.getByRole("button", { name: "Update available" });
    expect(update).toHaveClass("mona-update-breathe", "bg-[hsl(var(--brand-red))]", "h-6", "w-6");
    expect(within(update).queryByText("Update")).not.toBeInTheDocument();
    expect(update.querySelector(".bg-info")).not.toBeInTheDocument();

    fireEvent.click(update);
    expect(onStartUpdate).toHaveBeenCalledOnce();
  });

  it("hides the update icon until an update is available", () => {
    const onStartUpdate = vi.fn();
    renderRail({ onStartUpdate });

    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update available" })).not.toBeInTheDocument();
    expect(onStartUpdate).not.toHaveBeenCalled();
  });

  it("uses a native overflow menu without covering the browser WebView", async () => {
    isTauriMock.mockReturnValue(true);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(112);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(56);
    const onOpenNote = vi.fn();
    renderRail({ onOpenNote });

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await waitFor(() => expect(menuNew).toHaveBeenCalledOnce());
    expect(popup).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const items = menuNew.mock.calls[0][0].items as Array<{ text: string; action: () => void }>;
    items.find((item) => item.text === "Notes")?.action();
    expect(onOpenNote).toHaveBeenCalledOnce();
  });
});
