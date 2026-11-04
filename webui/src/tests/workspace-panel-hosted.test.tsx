import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { WorkspacePanel } from "@/components/deliver/WorkspacePanel";
import { configureHostedPlatform } from "@/lib/hosted-platform";
import { isTauri } from "@/lib/tauri";

let release: (() => void) | undefined;

afterEach(() => {
  cleanup();
  release?.();
  release = undefined;
});

it("offers web workspace file actions without desktop system actions", async () => {
  expect(isTauri()).toBe(false);
  release = configureHostedPlatform({ apiBase: "/api/work/desktop", token: "synthetic-account" });
  render(<WorkspacePanel
    scope="shared"
    sessionKey={`websocket:${"1".repeat(32)}`}
    listOnly="workspace"
    files={[{ path: "result.txt", absolute_path: "/workspace/result.txt", name: "result.txt",
      size: 3, size_human: "3 B", mime: "text/plain", sha256: "a".repeat(64) }]}
    onRename={vi.fn()}
    onDelete={vi.fn()}
  />);

  fireEvent.contextMenu(screen.getByText("result.txt"));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "下载文件" })).toBeVisible();
  expect(within(menu).getByRole("menuitem", { name: "重命名" })).toBeVisible();
  expect(within(menu).getByRole("menuitem", { name: "删除" })).toBeVisible();
  expect(within(menu).queryByRole("menuitem", { name: "用系统程序打开" })).not.toBeInTheDocument();
  expect(within(menu).queryByRole("menuitem", { name: "打开所在目录" })).not.toBeInTheDocument();
});
