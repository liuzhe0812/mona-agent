import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DesktopSurface } from "./Desktop";

function openDesktopMenu(): void {
  const surface = screen.getByRole("application", { name: "远程桌面" });
  fireEvent.contextMenu(surface, { clientX: 120, clientY: 120 });
}

function clickMenuItem(name: string): void {
  const item = screen.getByRole("button", { name });
  fireEvent.mouseDown(item, { button: 0 });
  fireEvent.click(item);
}

describe("DesktopSurface context menu", () => {
  it("executes every desktop context-menu action after pointer down", () => {
    const onOpenApp = vi.fn();
    const onDesktopContextMenu = vi.fn();
    render(
      <DesktopSurface
        onOpenApp={onOpenApp}
        onDesktopContextMenu={onDesktopContextMenu}
      />,
    );

    for (const [label, action] of [
      ["粘贴", "paste"],
      ["新建文件", "newFile"],
      ["新建文件夹", "newFolder"],
      ["刷新", "refresh"],
    ] as const) {
      openDesktopMenu();
      clickMenuItem(label);
      expect(onDesktopContextMenu).toHaveBeenLastCalledWith(action);
    }

    openDesktopMenu();
    clickMenuItem("打开终端");
    expect(onOpenApp).toHaveBeenLastCalledWith("terminal", "终端");

    openDesktopMenu();
    clickMenuItem("文件管理器");
    expect(onOpenApp).toHaveBeenLastCalledWith("fileManager", "此电脑", { path: "" });
  });
});
