import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    leftSystemMonitorVisible: false,
    toggleLeftFileTree: () => {},
    toggleLeftSystemMonitor: () => {},
  }),
}));

import { Toolbar } from "./Toolbar";
import { useTerminalStore } from "./store/terminalStore";

describe("Toolbar desktop entry", () => {
  beforeEach(() => {
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
    for (const name of ["批量", "桌面", "Docker", "设置"]) {
      expect(screen.getByRole("button", { name, exact: true })).toBeInTheDocument();
    }
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    expect(useTerminalStore.getState().sessions[0].sftpVisible).toBeUndefined();
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
