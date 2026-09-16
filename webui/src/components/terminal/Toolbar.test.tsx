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
