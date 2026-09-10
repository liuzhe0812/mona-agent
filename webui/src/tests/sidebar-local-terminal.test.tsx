import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const xtermTerminal = vi.hoisted(() => vi.fn());

vi.mock("@/components/terminal/XtermTerminal", () => ({
  XtermTerminal: ({ sessionId }: { sessionId: string }) => {
    xtermTerminal(sessionId);
    return <div data-testid="xterm-terminal" data-session-id={sessionId} />;
  },
}));

import { SidebarLocalTerminal } from "@/components/deliver/SidebarLocalTerminal";

describe("SidebarLocalTerminal", () => {
  beforeEach(() => {
    xtermTerminal.mockClear();
  });

  it("renders XtermTerminal only for the ready session", () => {
    render(
      <SidebarLocalTerminal
        sessionId="shell-123"
        status="ready"
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByTestId("xterm-terminal")).toHaveAttribute("data-session-id", "shell-123");
    expect(xtermTerminal).toHaveBeenCalledWith("shell-123");
    expect(screen.queryByText("正在打开本地终端…")).not.toBeInTheDocument();
  });

  it("shows the opening state without mounting XtermTerminal", () => {
    render(<SidebarLocalTerminal onRetry={vi.fn()} />);

    expect(screen.getByText("正在打开本地终端…")).toBeInTheDocument();
    expect(screen.queryByTestId("xterm-terminal")).not.toBeInTheDocument();
    expect(xtermTerminal).not.toHaveBeenCalled();
  });

  it("shows the startup error and retries when requested", () => {
    const onRetry = vi.fn();
    render(
      <SidebarLocalTerminal
        status="error"
        error="shell spawn failed"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("shell spawn failed")).toBeInTheDocument();
    expect(screen.queryByTestId("xterm-terminal")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新打开" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
