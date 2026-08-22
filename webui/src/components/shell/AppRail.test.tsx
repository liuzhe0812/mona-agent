import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const MOCK_MODULE_DEFS = vi.hoisted(() => [
  { key: "note", label: "笔记", icon: null },
  { key: "stock", label: "股票", icon: null },
]);
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
  useLicense: () => ({
    loggedIn: false,
    licenseInfo: null,
    licenseActive: false,
    serverTrial: false,
    logout: vi.fn(),
  }),
}));

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
  it("keeps settings reachable while logged out and exposes message attention", () => {
    renderRail({ messageAttentionCount: 3 });

    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
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

  it("hides the stock module when moduleAvailability marks it unavailable", () => {
    renderRail({ moduleAvailability: { stock: false } });

    expect(screen.queryByRole("button", { name: "Stocks" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notes" })).toBeInTheDocument();
  });
});
