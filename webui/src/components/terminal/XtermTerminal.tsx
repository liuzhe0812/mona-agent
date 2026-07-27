import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  sshWrite,
  sshResize,
  shellWrite,
  shellResize,
  sshReconnect,
  sshConnect,
} from "./ipc";
import { useTerminalStore } from "./store/terminalStore";
import type { ConnectionConfig } from "./types/terminal";
import { Loader2 } from "lucide-react";

interface Props {
  sessionId: string;
}

function buildTheme(): Record<string, string> {
  return {
    background: "#1a1a1a",
    foreground: "#e5e5e5",
    cursor: "#e5e5e5",
    selectionBackground: "rgba(255,255,255,0.15)",
    selectionForeground: "#ffffff",
    black: "#1a1a1a",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#e5e5e5",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  };
}

export function XtermTerminal({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const settings = useTerminalStore((s) => s.settings);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const sessions = useTerminalStore((s) => s.sessions);
  const connections = useTerminalStore((s) => s.connections);
  const updateSessionStatus = useTerminalStore((s) => s.updateSessionStatus);
  const registry = useTerminalStore((s) => s.terminalRegistry);
  const sessionStatus = useTerminalStore(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.status,
  );

  const updateSessionTitle = useTerminalStore((s) => s.updateSessionTitle);

  useEffect(() => {
    if (!containerRef.current) return;

    const sessions = useTerminalStore.getState().sessions;
    const session = sessions.find((s) => s.id === sessionId);
    const sessionType = session?.type ?? "local";
    const writeFn = sessionType === "ssh" ? sshWrite : shellWrite;
    const resizeFn = sessionType === "ssh" ? sshResize : shellResize;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: settings.cursorStyle,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      scrollback: settings.scrollback,
      theme: buildTheme(),
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);

    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // WebGL 不可用时回退到默认 DOM 渲染器
    }

    const fitAndResize = (force = false) => {
      if (!fitAddonRef.current || !terminalRef.current) return;
      if (!containerRef.current || containerRef.current.clientWidth === 0 || containerRef.current.clientHeight === 0) return;
      // Don't resize backend during connecting state
      const currentStatus = useTerminalStore
        .getState()
        .sessions.find((s) => s.id === sessionId)?.status;
      if (currentStatus === "connecting") return;
      fitAddonRef.current.fit();
      const { cols, rows } = terminalRef.current;
      if (
        force ||
        lastSizeRef.current === null ||
        lastSizeRef.current.cols !== cols ||
        lastSizeRef.current.rows !== rows
      ) {
        lastSizeRef.current = { cols, rows };
        resizeFn(sessionId, cols, rows).catch(() => {});
      }
    };

    requestAnimationFrame(() => {
      fitAndResize(true);
    });

    let inputBuffer = "";
    let sshIntercepted = false;

    const dataDisposable = terminal.onData((data) => {
      if (sshIntercepted) return;

      if (sessionType === "local") {
        if (data === "\r" || data === "\n") {
          const parsed = parseSshCommand(inputBuffer);
          if (parsed) {
            sshIntercepted = true;
            writeFn(sessionId, "\x03").catch(() => {});
            setTimeout(() => {
              const { host, port, username } = parsed;

              useTerminalStore.getState().showSshPasswordDialog({
                host,
                port,
                username: username || "root",
                onConfirm: async (password: string) => {
                  const configId = crypto.randomUUID();
                  const config: ConnectionConfig = {
                    id: configId,
                    name: `${username || "root"}@${host}`,
                    protocol: "ssh",
                    host,
                    port,
                    username: username || "root",
                    auth: { type: "password", password },
                  };
                  try {
                    const newSessionId = await sshConnect(config);
                    useTerminalStore.getState().addSession({
                      id: newSessionId,
                      configId,
                      type: "ssh",
                      status: "connected",
                      title: host,
                    });
                    useTerminalStore.getState().addConnection(config);
                    terminal.write(`\x1b[32m→ 已连接到 ${host}\x1b[0m\r\n`);
                  } catch (err) {
                    const errMsg = String(err);
                    terminal.write(`\x1b[31m→ 连接失败: ${errMsg}\x1b[0m\r\n`);
                  }
                  sshIntercepted = false;
                },
                onCancel: () => {
                  terminal.write("\x1b[33m→ 已取消 SSH 连接\x1b[0m\r\n");
                  sshIntercepted = false;
                },
              });
            }, 80);

            inputBuffer = "";
            return;
          }
          inputBuffer = "";
        } else if (data === "\x7f" || data === "\b") {
          inputBuffer = inputBuffer.slice(0, -1);
        } else if (data === "\x03") {
          inputBuffer = "";
        } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
          inputBuffer += data;
        }
      }

      writeFn(sessionId, data).catch(() => {});
    });

    const titleDisposable = terminal.onTitleChange((title) => {
      if (!title || title.trim().length === 0) return;
      const current = useTerminalStore.getState().sessions.find(
        (s) => s.id === sessionId,
      );
      if (current && current.title === "Mona Shell") {
        const cleaned = title.replace(/^.*@/, "");
        if (cleaned && cleaned !== sessionId) {
          updateSessionTitle(sessionId, cleaned);
        }
      }
    });

    // 选中即复制（已移除，改为右键复制）

    registry.register(sessionId, terminal);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        fitAndResize();
      }, 250);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      titleDisposable.dispose();
      registry.unregister(sessionId);
      // xterm WebglAddon.dispose() 在容器已分离时偶发抛 _isDisposed 异常（上游 bug），吞掉避免中断清理
      try { terminal.dispose(); } catch { /* terminal already disposed */ }
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastSizeRef.current = null;
    };
  }, [sessionId, registry]);

  // When session becomes connected, trigger initial fit + resize
  useEffect(() => {
    if (sessionStatus !== "connected") return;
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    requestAnimationFrame(() => {
      fitAddon.fit();
      const { cols, rows } = terminal;
      if (
        lastSizeRef.current === null ||
        lastSizeRef.current.cols !== cols ||
        lastSizeRef.current.rows !== rows
      ) {
        lastSizeRef.current = { cols, rows };
        const sessions = useTerminalStore.getState().sessions;
        const session = sessions.find((s) => s.id === sessionId);
        const resizeFn = session?.type === "ssh" ? sshResize : shellResize;
        resizeFn(sessionId, cols, rows).catch(() => {});
      }
      terminal.focus();
    });
  }, [sessionStatus, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = settings.fontSize;
    terminal.options.fontFamily = settings.fontFamily;
    terminal.options.scrollback = settings.scrollback;
    terminal.options.cursorStyle = settings.cursorStyle;
  }, [settings]);

  const isActive = useTerminalStore((s) => s.activeSessionId === sessionId);

  useEffect(() => {
    if (!isActive) return;
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    requestAnimationFrame(() => {
      if (!containerRef.current || containerRef.current.clientWidth === 0) return;
      fitAddon.fit();
      terminal.refresh(0, terminal.rows - 1);
      terminal.focus();
    });
  }, [isActive]);

  const handleContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      const terminal = terminalRef.current;
      if (!terminal) return;
      const selection = terminal.getSelection();
      if (selection) {
        // 有选中：复制并清除选中
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("plugin:clipboard-manager|write_text", { text: selection });
        } catch {}
        terminal.clearSelection();
      } else {
        // 无选中：粘贴
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const text = await invoke<string>("plugin:clipboard-manager|read_text");
          if (text) {
            terminal.paste(text);
          }
        } catch {}
      }
    },
    [],
  );

  const handleReconnect = async () => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || session.type === "local") return;

    const config = connections.find((c) => c.id === session.configId);
    if (!config) return;

    setReconnecting(true);
    try {
      await sshReconnect(sessionId, config);
      setDisconnected(false);
      updateSessionStatus(sessionId, "connected");
    } catch {
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[#1a1a1a]"
      onContextMenu={handleContextMenu}
    >
      {sessionStatus === "connecting" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">连接中…</span>
          </div>
        </div>
      ) : sessionStatus === "error" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
          <span className="text-sm text-red-500">连接失败</span>
        </div>
      ) : null}
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ padding: "4px 0 0 4px" }}
      />
      {disconnected && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-center bg-background/80 py-2">
          <span className="mr-3 text-sm text-muted-foreground">
            连接已断开
          </span>
          <button
            onClick={handleReconnect}
            disabled={reconnecting}
            className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {reconnecting ? "重连中…" : "重新连接"}
          </button>
        </div>
      )}
    </div>
  );
}

interface ParsedSshCommand {
  host: string;
  port: number;
  username: string;
}

function parseSshCommand(input: string): ParsedSshCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("ssh")) return null;
  if (trimmed.length === 3 || !/^ssh\s/.test(trimmed)) return null;

  const args = trimmed.slice(4).trim();
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;

  for (const ch of args) {
    if (ch === '"' || ch === "'") {
      inQuote = !inQuote;
    } else if (ch === " " && !inQuote) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  let host = "";
  let port = 22;
  let username = "";

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "-p" && i + 1 < tokens.length) {
      port = parseInt(tokens[++i], 10) || 22;
    } else if (tok === "-l" && i + 1 < tokens.length) {
      username = tokens[++i];
    } else if (tok.startsWith("-")) {
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i++;
      }
    } else if (!host) {
      host = tok;
    }
  }

  if (!host) return null;

  if (host.includes("@")) {
    const parts = host.split("@");
    username = parts[0];
    host = parts.slice(1).join("@");
  }

  if (!host) return null;

  return { host, port, username };
}
