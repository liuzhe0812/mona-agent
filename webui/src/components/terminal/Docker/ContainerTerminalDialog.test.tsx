import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type OutputHandler = (event: {
  terminalId: string;
  sessionId: string;
  containerId: string;
  data: string;
}) => void;

type EndedHandler = (event: { terminalId: string; exitCode: number | null }) => void;

interface MockTerminal {
  cols: number;
  rows: number;
  dataHandler: ((data: string) => void) | null;
  resizeHandler: ((size: { cols: number; rows: number }) => void) | null;
  dispose: ReturnType<typeof vi.fn>;
}

const terminalState = vi.hoisted(() => ({
  instance: null as MockTerminal | null,
  outputHandler: null as OutputHandler | null,
  endedHandler: null as EndedHandler | null,
}));

const dockerIpc = vi.hoisted(() => ({
  open: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  close: vi.fn(),
  onOutput: vi.fn(),
  onEnded: vi.fn(),
  outputUnlisten: vi.fn(),
  endedUnlisten: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 96;
    rows = 32;
    dataHandler: ((data: string) => void) | null = null;
    resizeHandler: ((size: { cols: number; rows: number }) => void) | null = null;
    dispose = vi.fn();

    constructor() {
      terminalState.instance = this as unknown as MockTerminal;
    }

    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    }
    onResize(handler: (size: { cols: number; rows: number }) => void) {
      this.resizeHandler = handler;
      return { dispose: vi.fn() };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("./docker-ipc", () => ({
  dockerOpenContainerTerminal: dockerIpc.open,
  dockerWriteContainerTerminal: dockerIpc.write,
  dockerResizeContainerTerminal: dockerIpc.resize,
  dockerCloseContainerTerminal: dockerIpc.close,
  onDockerTerminalOutput: dockerIpc.onOutput,
  onDockerTerminalEnded: dockerIpc.onEnded,
}));

import { ContainerTerminalDialog } from "./ContainerTerminalDialog";

function renderDialog(onOpenChange = vi.fn()) {
  return render(
    <ContainerTerminalDialog
      open
      onOpenChange={onOpenChange}
      parentSessionId="ssh-session-1"
      containerId="container-1"
      containerName="web"
    />,
  );
}

function ControlledDialog() {
  const [open, setOpen] = useState(true);
  return (
    <ContainerTerminalDialog
      open={open}
      onOpenChange={setOpen}
      parentSessionId="ssh-session-1"
      containerId="container-1"
      containerName="web"
    />
  );
}

describe("ContainerTerminalDialog", () => {
  beforeEach(() => {
    terminalState.instance = null;
    terminalState.outputHandler = null;
    terminalState.endedHandler = null;

    dockerIpc.open.mockReset().mockResolvedValue("docker-terminal-1");
    dockerIpc.write.mockReset().mockResolvedValue(undefined);
    dockerIpc.resize.mockReset().mockResolvedValue(undefined);
    dockerIpc.close.mockReset().mockResolvedValue(undefined);
    dockerIpc.outputUnlisten.mockReset();
    dockerIpc.endedUnlisten.mockReset();
    dockerIpc.onOutput.mockReset().mockImplementation(async (handler: OutputHandler) => {
      terminalState.outputHandler = handler;
      return dockerIpc.outputUnlisten;
    });
    dockerIpc.onEnded.mockReset().mockImplementation(async (handler: EndedHandler) => {
      terminalState.endedHandler = handler;
      return dockerIpc.endedUnlisten;
    });
  });

  it("opens the container terminal with the fitted terminal size", async () => {
    renderDialog();

    await waitFor(() =>
      expect(dockerIpc.open).toHaveBeenCalledWith(
        "ssh-session-1",
        "container-1",
        96,
        32,
      ),
    );
    expect(dockerIpc.onOutput).toHaveBeenCalledTimes(1);
    expect(dockerIpc.onEnded).toHaveBeenCalledTimes(1);
  });

  it("forwards terminal input to the opened container terminal", async () => {
    renderDialog();
    await waitFor(() => expect(dockerIpc.open).toHaveBeenCalled());

    await act(async () => {
      terminalState.instance?.dataHandler?.("ls -la\r");
    });

    expect(dockerIpc.write).toHaveBeenCalledWith("docker-terminal-1", "ls -la\r");
  });

  it("closes the backend terminal and cleans up xterm listeners", async () => {
    const { unmount } = render(<ControlledDialog />);
    await waitFor(() => expect(dockerIpc.open).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(dockerIpc.close).toHaveBeenCalledWith("docker-terminal-1"));

    expect(terminalState.instance?.dispose).toHaveBeenCalledTimes(1);
    expect(dockerIpc.outputUnlisten).toHaveBeenCalledTimes(1);
    expect(dockerIpc.endedUnlisten).toHaveBeenCalledTimes(1);
    unmount();
  });
});
