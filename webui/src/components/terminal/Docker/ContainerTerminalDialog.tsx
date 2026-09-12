import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import { buildTerminalTheme } from "../XtermTerminal";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  dockerCloseContainerTerminal,
  dockerOpenContainerTerminal,
  dockerResizeContainerTerminal,
  dockerWriteContainerTerminal,
  onDockerTerminalEnded,
  onDockerTerminalOutput,
} from "./docker-ipc";

interface DockerTerminalOutputEvent {
  terminalId: string;
  sessionId: string;
  containerId: string;
  data: string;
}

interface DockerTerminalEndedEvent {
  terminalId: string;
  exitCode: number | null;
}

export interface ContainerTerminalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentSessionId: string;
  containerId: string;
  containerName: string;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function ContainerTerminalDialog({
  open,
  onOpenChange,
  parentSessionId,
  containerId,
  containerName,
}: ContainerTerminalDialogProps) {
  const [terminalHost, setTerminalHost] = useState<HTMLDivElement | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const terminalEndedRef = useRef(false);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<DockerTerminalEndedEvent | null>(null);

  useEffect(() => {
    if (!open || !terminalHost) return;

    const host = terminalHost;
    let active = true;
    let terminalId: string | null = null;
    let pendingOutput: DockerTerminalOutputEvent[] = [];
    let pendingOutputBytes = 0;
    let outputUnlisten: (() => void) | null = null;
    let endedUnlisten: (() => void) | null = null;

    setError(null);
    setEnded(null);
    terminalIdRef.current = null;
    terminalEndedRef.current = false;
    lastSizeRef.current = null;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "monospace",
      fontSize: 14,
      scrollback: 2000,
      theme: buildTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    const outputHandler = (event: DockerTerminalOutputEvent) => {
      if (!active || event.sessionId !== parentSessionId || event.containerId !== containerId) {
        return;
      }
      if (!terminalIdRef.current) {
        pendingOutput.push(event);
        pendingOutputBytes += event.data.length;
        while (pendingOutputBytes > 64 * 1024 && pendingOutput.length > 1) {
          pendingOutputBytes -= pendingOutput.shift()?.data.length ?? 0;
        }
        return;
      }
      if (event.terminalId !== terminalIdRef.current) return;
      terminal.write(event.data);
    };

    const endedHandler = (event: DockerTerminalEndedEvent) => {
      if (!active || event.terminalId !== terminalIdRef.current) return;
      terminalEndedRef.current = true;
      setEnded(event);
    };

    const outputRegistration = onDockerTerminalOutput(outputHandler).then((unlisten) => {
      if (!active) {
        unlisten();
        return;
      }
      outputUnlisten = unlisten;
    });
    const endedRegistration = onDockerTerminalEnded(endedHandler).then((unlisten) => {
      if (!active) {
        unlisten();
        return;
      }
      endedUnlisten = unlisten;
    });

    const sendResize = (cols: number, rows: number) => {
      const currentTerminalId = terminalIdRef.current;
      if (
        !active ||
        !currentTerminalId ||
        terminalEndedRef.current ||
        (lastSizeRef.current?.cols === cols && lastSizeRef.current?.rows === rows)
      ) {
        return;
      }
      lastSizeRef.current = { cols, rows };
      void dockerResizeContainerTerminal(currentTerminalId, cols, rows).catch((reason) => {
        if (active) setError(`调整终端大小失败：${errorMessage(reason)}`);
      });
    };

    const fitTerminal = () => {
      try {
        fitAddon.fit();
      } catch (reason) {
        if (active) setError(`终端布局失败：${errorMessage(reason)}`);
        return;
      }
      sendResize(terminal.cols, terminal.rows);
    };

    const dataDisposable = terminal.onData((data) => {
      const currentTerminalId = terminalIdRef.current;
      if (!active || !currentTerminalId || terminalEndedRef.current) return;
      void dockerWriteContainerTerminal(currentTerminalId, data).catch((reason) => {
        if (active) setError(`终端输入失败：${errorMessage(reason)}`);
      });
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      sendResize(cols, rows);
    });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(fitTerminal);
      resizeObserver.observe(host);
    }

    const start = async () => {
      try {
        await Promise.all([outputRegistration, endedRegistration]);
        if (!active) return;

        fitTerminal();
        const { cols, rows } = terminal;
        const openedTerminalId = await dockerOpenContainerTerminal(
          parentSessionId,
          containerId,
          cols,
          rows,
        );
        if (!active) {
          await dockerCloseContainerTerminal(openedTerminalId);
          return;
        }
        terminalId = openedTerminalId;
        terminalIdRef.current = openedTerminalId;
        lastSizeRef.current = { cols, rows };
        for (const event of pendingOutput) {
          if (event.terminalId === openedTerminalId) terminal.write(event.data);
        }
        pendingOutput = [];
        pendingOutputBytes = 0;
        terminal.focus();
      } catch (reason) {
        if (active) setError(`打开容器终端失败：${errorMessage(reason)}`);
      }
    };
    void start();

    return () => {
      active = false;
      resizeObserver?.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();

      if (outputUnlisten) {
        outputUnlisten();
        outputUnlisten = null;
      }
      if (endedUnlisten) {
        endedUnlisten();
        endedUnlisten = null;
      }
      void outputRegistration.catch(() => {});
      void endedRegistration.catch(() => {});

      const currentTerminalId = terminalId ?? terminalIdRef.current;
      terminalIdRef.current = null;
      if (currentTerminalId) {
        void dockerCloseContainerTerminal(currentTerminalId).catch(() => {});
      }

      try {
        terminal.dispose();
      } catch {
        // xterm can already be disposed when the dialog content is removed.
      }
      lastSizeRef.current = null;
    };
  }, [containerId, open, parentSessionId, terminalHost]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-h-[720px] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-5 py-4 text-left">
          <DialogTitle>容器终端：{containerName || containerId}</DialogTitle>
          <DialogDescription className="truncate font-mono">
            {containerId}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-caption text-destructive">
            {error}
          </div>
        ) : null}
        {ended ? (
          <div role="status" className="border-b border-warning/30 bg-warning/10 px-5 py-2 text-caption text-warning">
            容器终端已结束（退出码：{ended.exitCode ?? "未知"}）
          </div>
        ) : null}

        <div
          ref={setTerminalHost}
          aria-label="容器交互终端"
          className="min-h-0 flex-1 bg-background p-2"
          data-testid="container-terminal"
        />

        <DialogFooter className="border-t border-border/70 px-5 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
