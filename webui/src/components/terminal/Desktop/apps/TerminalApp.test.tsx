import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalApp } from "./TerminalApp";

const terminalWrite = vi.hoisted(() => vi.fn());
const terminalIpc = vi.hoisted(() => ({
  outputHandler: null as null | ((event: { sessionId: string; data: string }) => void),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    loadAddon() {}
    open() {}
    write(data: string) { terminalWrite(data); }
    focus() {}
    dispose() {}
    clear() {}
    getSelection() { return ""; }
    onData() { return { dispose() {} }; }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() {} },
}));

vi.mock("../DesktopMode", () => ({ useDesktopPortal: () => null }));
vi.mock("../../AIPanel/AIPanel", () => ({
  AIPanel: ({
    sessionId,
    sessionType,
  }: {
    sessionId: string;
    sessionType: string;
  }) => <div data-testid="terminal-ai">{sessionId}:{sessionType}</div>,
}));
vi.mock("../../ipc", () => ({
  desktopExec: vi.fn(),
  desktopResizeTerminal: vi.fn().mockResolvedValue(undefined),
  desktopSendTerminalInput: vi.fn().mockResolvedValue(undefined),
  desktopStartTerminal: vi.fn().mockResolvedValue(undefined),
  onTerminalMaintenanceUpdated: vi.fn().mockResolvedValue(() => {}),
  onTerminalOutput: vi.fn().mockImplementation(async (handler) => {
    terminalIpc.outputHandler = handler;
    return () => {};
  }),
}));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

describe("desktop Terminal AI", () => {
  beforeEach(() => {
    terminalWrite.mockClear();
    terminalIpc.outputHandler = null;
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn());
  });

  it("opens an AI sidebar bound to the current desktop session", async () => {
    await act(async () => {
      render(<TerminalApp sessionId="desktop-1" aiEnabled />);
    });

    expect(screen.queryByTestId("terminal-ai")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开 AI 助手" }));
    const panel = screen.getByTestId("terminal-ai");
    expect(panel).toHaveTextContent("desktop-1:desktop");
    expect(panel.parentElement).toHaveClass("shrink-0");
    expect(panel.parentElement).not.toHaveClass("absolute");

    act(() => terminalIpc.outputHandler?.({
      sessionId: "desktop-1",
      data: "\r\n$ pwd\r\n/root\r\n",
    }));
    expect(terminalWrite).toHaveBeenCalledWith("\r\n$ pwd\r\n/root\r\n");

    fireEvent.click(screen.getByRole("button", { name: "关闭 AI 侧栏" }));
    expect(screen.queryByTestId("terminal-ai")).toBeNull();
  });
});
