import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const monitor = vi.hoisted(() => ({ visible: false, toggle: vi.fn() }));

vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => ({ licenseActive: false }),
}));

vi.mock("../ide/useIdeStore", () => ({
  useIdeStore: <T,>(selector: (state: {
    leftFileTreeVisible: boolean;
    leftSystemMonitorVisible: boolean;
    toggleLeftFileTree: () => void;
    toggleLeftSystemMonitor: () => void;
  }) => T) => selector({
    leftFileTreeVisible: false,
    leftSystemMonitorVisible: monitor.visible,
    toggleLeftFileTree: () => {},
    toggleLeftSystemMonitor: monitor.toggle,
  }),
}));

import { Toolbar } from "./Toolbar";
import { useTerminalStore } from "./store/terminalStore";

describe("Toolbar desktop entry", () => {
  beforeEach(() => {
    monitor.visible = false;
    monitor.toggle.mockReset();
    useTerminalStore.setState({
      sessions: [{
        id: "ssh-current",
        configId: "connection-current",
        type: "ssh",
        status: "connected",
        title: "172.31.13.200",
      }],
      activeSessionId: "ssh-current",
    });
  });

  it.each([true, false])("omits the redundant SFTP toolbar button (embedded=%s)", (embedded) => {
    render(<Toolbar embedded={embedded} />);

    expect(screen.queryByRole("button", { name: "SFTP", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批量", exact: true })).not.toBeInTheDocument();
    for (const name of ["桌面", "Docker", "设置"]) {
      expect(screen.getByRole("button", { name, exact: true })).toBeInTheDocument();
    }
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    expect(useTerminalStore.getState().sessions[0].sftpVisible).toBeUndefined();
  });

  it("keeps system monitoring and transfer history in the left group, with settings on the right", () => {
    const view = render(<Toolbar />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label") || button.textContent)).toEqual([
      "新建", "桌面", "Docker", "显示系统监控", "传输记录", "显示 AI 面板", "设置",
    ]);
    const monitorButton = screen.getByRole("button", { name: "显示系统监控" });
    expect(monitorButton).toHaveTextContent("系统监控");
    expect(monitorButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(monitorButton);
    expect(monitor.toggle).toHaveBeenCalledOnce();
    monitor.visible = true;
    view.rerender(<Toolbar />);
    expect(screen.getByRole("button", { name: "隐藏系统监控" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute("title", "设置");
  });

  it.each(["ssh", "sftp"] as const)("opens transfer history only in the current %s session", (type) => {
    useTerminalStore.setState({
      sessions: [
        { id: "current", configId: "one", type, status: "connected", title: "当前", sftpVisible: false, transferPanelVisible: false },
        { id: "other", configId: "two", type: "ssh", status: "connected", title: "其他", sftpVisible: false, transferPanelVisible: false },
      ],
      activeSessionId: "current",
    });
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "传输记录" }));

    expect(useTerminalStore.getState().sessions).toEqual([
      expect.objectContaining({ id: "current", sftpVisible: true, transferPanelVisible: true }),
      expect.objectContaining({ id: "other", sftpVisible: false, transferPanelVisible: false }),
    ]);
  });

  it.each(["ssh", "sftp"] as const)("disables transfer history for disconnected %s sessions", (type) => {
    useTerminalStore.setState({
      sessions: [{ id: "current", configId: "one", type, status: "disconnected", title: "当前" }],
      activeSessionId: "current",
    });
    render(<Toolbar />);
    expect(screen.getByRole("button", { name: "传输记录" })).toBeDisabled();
  });

  it("opens desktop from the active SSH session without asking for credentials again", () => {
    render(<Toolbar />);

    fireEvent.click(screen.getByRole("button", { name: "桌面" }));

    expect(useTerminalStore.getState().sessions).toContainEqual({
      id: "desktop:ssh-current",
      configId: "connection-current",
      type: "desktop",
      status: "connected",
      title: "172.31.13.200 (桌面)",
      parentSessionId: "ssh-current",
    });
    expect(useTerminalStore.getState().activeSessionId).toBe("desktop:ssh-current");

    fireEvent.click(screen.getByRole("button", { name: "桌面" }));
    expect(
      useTerminalStore.getState().sessions.filter((session) => session.parentSessionId === "ssh-current"),
    ).toHaveLength(1);
  });
});
