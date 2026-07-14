import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import { Sidebar } from "@/components/Sidebar";

vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => ({
    loggedIn: false,
    licenseInfo: null,
    licenseActive: true,
    serverTrial: false,
    remainingDays: 0,
  }),
}));

describe("system sidebar entry", () => {
  it("opens the system module from the primary toolbox", () => {
    const onOpenSystem = vi.fn();
    const props = {
      sessions: [],
      activeKey: null,
      loading: false,
      onNewChat: vi.fn(),
      onSelect: vi.fn(),
      onRequestDelete: vi.fn(),
      onTogglePin: vi.fn(),
      onRequestRename: vi.fn(),
      onToggleArchive: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenSearch: vi.fn(),
      onToggleArchived: vi.fn(),
      onUpdateView: vi.fn(),
      onCollapse: vi.fn(),
      onOpenSystem,
    } as ComponentProps<typeof Sidebar> & { onOpenSystem: () => void };

    render(<Sidebar {...props} />);
    const systemButton = screen.getByRole("button", { name: "系统" });
    const systemIcon = systemButton.querySelector("img");
    expect(systemIcon).not.toBeNull();
    expect((systemIcon as HTMLImageElement).src).toContain("sidebar-system");

    fireEvent.click(systemButton);

    expect(onOpenSystem).toHaveBeenCalledOnce();
  });
});
