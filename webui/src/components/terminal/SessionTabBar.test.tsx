import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isTauriMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/lib/tauri", () => ({ isTauri: isTauriMock }));
vi.mock("./ipc", () => ({
  onTerminalMaintenanceUpdated: vi.fn().mockResolvedValue(() => {}),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onTerminalSessionStatus: vi.fn().mockResolvedValue(() => {}),
  shellKill: vi.fn().mockResolvedValue(undefined),
  shellSpawn: vi.fn().mockResolvedValue("new-session"),
  sshConnect: vi.fn().mockResolvedValue("new-session"),
  sshDisconnect: vi.fn().mockResolvedValue(undefined),
  sshOpenSftp: vi.fn().mockResolvedValue("new-sftp-session"),
  terminalLoadConnections: vi.fn().mockResolvedValue([]),
  terminalSaveConnections: vi.fn().mockResolvedValue(undefined),
  vncDisconnect: vi.fn().mockResolvedValue(undefined),
}));

import { SessionTabBar } from "./SessionTabBar";
import { useTerminalStore } from "./store/terminalStore";

describe("SessionTabBar", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(false);
    useTerminalStore.setState({
      sessions: [
        {
          id: "session-1",
          configId: "config-1",
          type: "ssh",
          status: "connected",
          title: "47.117.69.105",
        },
      ],
      activeSessionId: "session-1",
    });
  });

  it("reveals the close button when the whole tab is hovered", () => {
    render(<SessionTabBar />);

    const tab = screen.getByText("47.117.69.105").parentElement;
    expect(tab).not.toBeNull();
    expect(tab).toHaveClass("group");

    const closeButton = screen.getByRole("button", { name: "关闭 47.117.69.105" });
    expect(closeButton).toHaveClass("opacity-0", "group-hover:opacity-100");

    fireEvent.click(closeButton);
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it("opens one Docker tool tab for the SSH session and closes it independently", async () => {
    render(<SessionTabBar />);

    fireEvent.contextMenu(screen.getByText("47.117.69.105").parentElement!);
    fireEvent.click(await screen.findByText("Docker 管理"));

    const sessions = useTerminalStore.getState().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).toMatchObject({
      id: "docker:session-1",
      type: "docker",
      parentSessionId: "session-1",
    });

    fireEvent.click(screen.getByRole("button", { name: "关闭 Docker · 47.117.69.105" }));
    expect(useTerminalStore.getState().sessions).toEqual([
      expect.objectContaining({ id: "session-1", type: "ssh" }),
    ]);
  });
});
