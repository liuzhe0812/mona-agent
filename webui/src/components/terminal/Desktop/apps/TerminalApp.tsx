import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  desktopStartTerminal,
  desktopSendTerminalInput,
  desktopResizeTerminal,
  onTerminalOutput,
  desktopExec,
} from "../../ipc";
import type { UnlistenFn } from "../../ipc";
import { useDesktopPortal } from "../DesktopMode";
import {
  FolderOpen,
  Search,
  Settings,
  Code,
  X,
  Send,
  Copy,
  Monitor,
  Wrench,
  Network,
  FileText,
  Shield,
  Container,
  ChevronsLeft,
  ChevronsRight,
  Minus,
  Plus,
  Clipboard,
  Trash2,
  Check,
  Loader2,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface CommandItem {
  category: string;
  title: string;
  cmd: string;
  desc: string;
}

const commandCategories = [
  { id: "monitor", name: "系统监控", icon: Monitor },
  { id: "maintain", name: "系统维护", icon: Wrench },
  { id: "network", name: "网络工具", icon: Network },
  { id: "file", name: "文件操作", icon: FileText },
  { id: "security", name: "安全工具", icon: Shield },
  { id: "docker", name: "Docker容器", icon: Container },
];

const predefinedCommands: CommandItem[] = [
  { category: "monitor", title: "查看系统资源", cmd: "top", desc: "实时显示进程状态" },
  { category: "monitor", title: "查看内存使用", cmd: "free -h", desc: "显示内存使用情况" },
  { category: "monitor", title: "查看磁盘空间", cmd: "df -h", desc: "显示磁盘分区及使用情况" },
  { category: "monitor", title: "系统负载", cmd: "uptime", desc: "查看系统运行时间和负载" },
  {
    category: "maintain",
    title: "系统更新",
    cmd: "apt update && apt upgrade -y",
    desc: "更新系统软件包(Debian/Ubuntu)",
  },
  {
    category: "maintain",
    title: "清理缓存",
    cmd: "apt autoremove && apt clean",
    desc: "清理无用的包和缓存",
  },
  { category: "network", title: "查看端口占用", cmd: "ss -tuln", desc: "查看监听的端口" },
  { category: "network", title: "网络连接状态", cmd: "netstat -anp", desc: "查看所有网络连接" },
  {
    category: "network",
    title: "测试网络连通",
    cmd: "ping baidu.com -c 4",
    desc: "Ping测试",
  },
  { category: "network", title: "查看IP地址", cmd: "ip addr", desc: "显示网络接口信息" },
  {
    category: "file",
    title: "列出文件详情",
    cmd: "ls -la",
    desc: "显示当前目录下所有文件详情",
  },
  { category: "file", title: "查看当前路径", cmd: "pwd", desc: "显示当前工作目录" },
  {
    category: "file",
    title: "查找大文件",
    cmd: "find / -type f -size +100M",
    desc: "查找大于100M的文件",
  },
  { category: "security", title: "查看登录日志", cmd: "last", desc: "查看用户登录历史" },
  { category: "security", title: "防火墙状态", cmd: "ufw status", desc: "查看UFW防火墙状态" },
  { category: "security", title: "当前登录用户", cmd: "who", desc: "查看当前在线用户" },
  {
    category: "docker",
    title: "查看运行容器",
    cmd: "docker ps",
    desc: "显示正在运行的容器",
  },
  {
    category: "docker",
    title: "查看所有镜像",
    cmd: "docker images",
    desc: "显示本地镜像列表",
  },
  {
    category: "docker",
    title: "查看容器日志",
    cmd: "docker logs --tail 100 -f <container_id>",
    desc: "跟踪显示容器日志",
  },
];

interface TerminalAppProps {
  sessionId: string;
}

const generateTerminalSessionId = () =>
  `desktop_term_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export function TerminalApp({ sessionId }: TerminalAppProps) {
  const portalTarget = useDesktopPortal();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const categoriesRef = useRef<HTMLDivElement>(null);
  const terminalSessionIdRef = useRef<string>(generateTerminalSessionId());
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const inputBufferRef = useRef<string>("");

  const [isConnecting, setIsConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(false);
  const [activeTab, setActiveTab] = useState<"history" | "command">("history");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [historyCommands, setHistoryCommands] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showCopyToast, setShowCopyToast] = useState(false);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = fontSize;
      const id = setTimeout(() => fitAddonRef.current?.fit(), 100);
      return () => clearTimeout(id);
    }
  }, [fontSize]);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminalSessionId = terminalSessionIdRef.current;
    let isCleanedUp = false;
    const timeoutIds: ReturnType<typeof setTimeout>[] = [];

    const term = new Terminal({
      theme: {
        background: "#0c0c0c",
        foreground: "#cccccc",
        cursor: "#ffffff",
        selectionBackground: "#264f78",
        black: "#0c0c0c",
        red: "#c50f1f",
        green: "#13a10e",
        yellow: "#c19c00",
        blue: "#0037da",
        magenta: "#881798",
        cyan: "#3a96dd",
        white: "#cccccc",
        brightBlack: "#767676",
        brightRed: "#e74856",
        brightGreen: "#16c60c",
        brightYellow: "#f9f1a5",
        brightBlue: "#3b78ff",
        brightMagenta: "#b4009e",
        brightCyan: "#61d6d6",
        brightWhite: "#f2f2f2",
      },
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Consolas", "Courier New", monospace',
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const connect = async () => {
      try {
        setIsConnecting(true);
        setError(null);

        const unlisten = await onTerminalOutput((event) => {
          if (event.sessionId === terminalSessionId) {
            term.write(event.data);
          }
        });
        unlistenRef.current = unlisten;

        await desktopStartTerminal(
          sessionId,
          terminalSessionId,
          term.cols,
          term.rows,
        );

        setIsConnecting(false);

        const focusTimeout = setTimeout(() => {
          if (!isCleanedUp) term.focus();
        }, 100);
        timeoutIds.push(focusTimeout);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setIsConnecting(false);
        term.writeln(`\r\n\x1b[31m连接失败: ${err}\x1b[0m`);
      }
    };

    connect();

    term.onData((data) => {
      if (isCleanedUp) return;

      desktopSendTerminalInput(sessionId, data).catch(() => {});

      if (data === "\r") {
        const cmd = inputBufferRef.current.trim();
        if (cmd) {
          setHistoryCommands((prev) => [cmd, ...prev].slice(0, 50));
        }
        inputBufferRef.current = "";
      } else if (data === "\x7f") {
        inputBufferRef.current = inputBufferRef.current.slice(0, -1);
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        inputBufferRef.current += data;
      }
    });

    const handleResize = () => {
      if (isCleanedUp) return;
      fitAddon.fit();
      desktopResizeTerminal(sessionId, term.cols, term.rows).catch(() => {});
    };

    window.addEventListener("resize", handleResize);

    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (!isCleanedUp) handleResize();
      }, 150);
    });
    resizeObserver.observe(containerRef.current);

    requestAnimationFrame(handleResize);
    [50, 150, 350, 700].forEach((delay) => {
      const id = setTimeout(handleResize, delay);
      timeoutIds.push(id);
    });

    return () => {
      isCleanedUp = true;
      timeoutIds.forEach((id) => clearTimeout(id));
      if (resizeTimeout) clearTimeout(resizeTimeout);
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
      unlistenRef.current?.();
      unlistenRef.current = null;
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (fitAddonRef.current && terminalRef.current) {
      const id = setTimeout(() => {
        if (fitAddonRef.current && terminalRef.current) {
          fitAddonRef.current.fit();
          desktopResizeTerminal(
            sessionId,
            terminalRef.current.cols,
            terminalRef.current.rows,
          ).catch(() => {});
        }
      }, 300);
      return () => clearTimeout(id);
    }
  }, [showSidebar, sessionId]);

  const sendCommand = useCallback(
    (cmd: string) => {
      desktopSendTerminalInput(sessionId, cmd + "\r").catch(() => {});
      terminalRef.current?.focus();
      setHistoryCommands((prev) => [cmd, ...prev].slice(0, 50));
    },
    [sessionId],
  );

  const handleCopy = () => {
    if (terminalRef.current) {
      const selection = terminalRef.current.getSelection();
      if (selection) {
        navigator.clipboard
          .writeText(selection)
          .then(() => {
            setShowCopyToast(true);
            setTimeout(() => setShowCopyToast(false), 2000);
          })
          .catch(() => {});
      }
    }
    setContextMenu(null);
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        desktopSendTerminalInput(sessionId, text).catch(() => {});
      }
    } catch {
      // clipboard read failed
    }
    setContextMenu(null);
  };

  const handleClear = () => {
    terminalRef.current?.clear();
    setContextMenu(null);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  const handleOpenCurrentDir = async () => {
    try {
      const result = await desktopExec(sessionId, "pwd");
      if (result) {
        const cwd = result.trim();
        if (cwd) {
          console.log("Current directory:", cwd);
        }
      }
    } catch {
      // failed to get cwd
    }
  };

  const scrollCategories = (direction: "left" | "right") => {
    if (categoriesRef.current) {
      const scrollAmount = 150;
      const currentScroll = categoriesRef.current.scrollLeft;
      categoriesRef.current.scrollTo({
        left:
          direction === "left"
            ? currentScroll - scrollAmount
            : currentScroll + scrollAmount,
        behavior: "smooth",
      });
    }
  };

  const filteredCommands = predefinedCommands.filter((cmd) => {
    const matchesSearch =
      cmd.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cmd.cmd.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cmd.desc.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory ? cmd.category === selectedCategory : true;
    return matchesSearch && matchesCategory;
  });

  return (
    <TooltipProvider>
    <div className="h-full flex flex-col relative overflow-hidden">
      <div className="flex-1 flex overflow-hidden relative">
        <div
          className="flex-1 relative h-full bg-[#0c0c0c]"
          onContextMenu={handleContextMenu}
          onClick={() => terminalRef.current?.focus()}
        >
          <div
            ref={containerRef}
            className="h-full w-full"
            style={{ padding: "4px 0 0 4px" }}
          />

          {isConnecting && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0c0c0c]/80 z-10">
              <div className="flex items-center gap-2 text-white/80">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>正在连接...</span>
              </div>
            </div>
          )}

          {error && (
            <div className="absolute top-2 right-2 bg-red-500/80 text-white px-3 py-1 rounded text-sm z-10">
              {error}
            </div>
          )}
        </div>

        {showCopyToast &&
          createPortal(
            <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[10000] animate-in fade-in slide-in-from-top-4 duration-200">
              <div className="bg-[#1e1e1e] border border-white/10 text-white px-4 py-3 rounded-lg shadow-2xl flex items-center gap-3">
                <div className="bg-green-500 rounded-full p-1">
                  <Check className="w-3 h-3 text-white" strokeWidth={3} />
                </div>
                <span className="text-sm font-medium">已成功复制到剪贴板</span>
              </div>
            </div>,
            portalTarget ?? document.body,
          )}

        {contextMenu &&
          createPortal(
            <div
              className="fixed z-[100001] bg-[#252526] border border-white/10 rounded-lg shadow-2xl py-1 w-48 animate-in fade-in zoom-in-95 duration-100"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                onClick={handleCopy}
                className="w-full px-3 py-2 text-left text-sm text-white/80 hover:bg-[#37373d] hover:text-white flex items-center gap-2 transition-colors"
              >
                <Copy className="w-4 h-4" />
                复制
              </button>
              <button
                onClick={handlePaste}
                className="w-full px-3 py-2 text-left text-sm text-white/80 hover:bg-[#37373d] hover:text-white flex items-center gap-2 transition-colors"
              >
                <Clipboard className="w-4 h-4" />
                粘贴
              </button>
              <div className="my-1 border-t border-white/10" />
              <button
                onClick={handleClear}
                className="w-full px-3 py-2 text-left text-sm text-white/80 hover:bg-[#37373d] hover:text-white flex items-center gap-2 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                清屏
              </button>
            </div>,
            portalTarget ?? document.body,
          )}

        <div
          className={`
            absolute top-0 right-0 bottom-0 z-30 shadow-2xl
            border-l border-white/10 bg-[#1e1e1e] flex flex-col transition-all duration-300 ease-in-out
            ${showSidebar ? "w-[400px] opacity-100 translate-x-0" : "w-0 opacity-0 translate-x-full overflow-hidden"}
          `}
        >
          <div className="h-10 border-b border-white/10 flex items-center justify-between px-4 shrink-0">
            <div className="flex items-center gap-1 bg-[#252526] p-1 rounded-lg">
              <button
                onClick={() => setActiveTab("history")}
                className={`
                  px-3 py-1 text-xs rounded-md transition-colors
                  ${activeTab === "history" ? "bg-[#37373d] text-white" : "text-white/50 hover:text-white/80"}
                `}
              >
                历史命令
              </button>
              <button
                onClick={() => setActiveTab("command")}
                className={`
                  px-3 py-1 text-xs rounded-md transition-colors
                  ${activeTab === "command" ? "bg-[#37373d] text-white" : "text-white/50 hover:text-white/80"}
                `}
              >
                命令中心
              </button>
            </div>
            <button
              onClick={() => setShowSidebar(false)}
              className="text-white/50 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-3 border-b border-white/10 shrink-0">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
              <input
                type="text"
                placeholder="搜索命令..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#252526] border border-white/10 rounded-md py-1.5 pl-9 pr-3 text-sm text-white/80 placeholder:text-white/30 focus:outline-none focus:border-blue-500/50"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {activeTab === "command" && (
              <>
                <div className="flex items-center gap-1 mb-4">
                  <button
                    onClick={() => scrollCategories("left")}
                    className="p-1 hover:bg-white/10 rounded text-white/50 hover:text-white transition-colors shrink-0"
                  >
                    <ChevronsLeft className="w-4 h-4" />
                  </button>

                  <div
                    ref={categoriesRef}
                    className="flex-1 flex gap-2 overflow-x-auto scroll-smooth whitespace-nowrap"
                    style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
                  >
                    {commandCategories.map((cat) => (
                      <button
                        key={cat.id}
                        onClick={() =>
                          setSelectedCategory(cat.id === selectedCategory ? null : cat.id)
                        }
                        className={`
                          px-2 py-1 text-xs rounded border transition-colors shrink-0
                          ${selectedCategory === cat.id
                            ? "bg-blue-500/20 border-blue-500/50 text-blue-200"
                            : "border-white/10 text-white/50 hover:bg-white/5"}
                        `}
                      >
                        {cat.name}
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => scrollCategories("right")}
                    className="p-1 hover:bg-white/10 rounded text-white/50 hover:text-white transition-colors shrink-0"
                  >
                    <ChevronsRight className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-2">
                  {filteredCommands.map((item, index) => (
                    <div
                      key={index}
                      className="group bg-[#252526] hover:bg-[#2d2d2e] border border-white/5 rounded-lg p-3 transition-colors"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <h3 className="text-white/90 text-sm font-medium">
                            {item.title}
                          </h3>
                          <p className="text-white/40 text-xs mt-0.5">{item.desc}</p>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() =>
                                  navigator.clipboard.writeText(item.cmd)
                                }
                                className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white"
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>复制</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => sendCommand(item.cmd)}
                                className="p-1.5 rounded bg-blue-500/10 hover:bg-blue-500/20 text-blue-400"
                              >
                                <Send className="w-3.5 h-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>发送到终端</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                      <div className="bg-[#1e1e1e] p-2 rounded text-xs font-mono text-white/70 break-all border border-white/5">
                        {item.cmd}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {activeTab === "history" && (
              <div className="space-y-1">
                {historyCommands.length === 0 ? (
                  <div className="text-center py-8 text-white/30 text-sm">
                    暂无历史命令
                  </div>
                ) : (
                  historyCommands
                    .filter((cmd) =>
                      cmd.toLowerCase().includes(searchQuery.toLowerCase()),
                    )
                    .map((cmd, index) => (
                      <div
                        key={index}
                        className="group flex items-center gap-3 p-2 rounded hover:bg-[#2d2d2e] transition-colors"
                      >
                        <span className="text-white/20 font-mono text-xs w-6 text-right shrink-0">
                          {historyCommands.length - index}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p
                            className="text-white/80 text-sm font-mono truncate"
                            title={cmd}
                          >
                            {cmd}
                          </p>
                        </div>
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button
                            onClick={() => navigator.clipboard.writeText(cmd)}
                            className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => sendCommand(cmd)}
                            className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white"
                          >
                            <Send className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="h-8 bg-[#1e1e1e] border-t border-white/5 flex items-center px-3 gap-4 shrink-0 z-20">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleOpenCurrentDir}
              className="text-white/60 hover:text-white/80 transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>打开当前目录</TooltipContent>
        </Tooltip>

        <div className="flex-1" />

        <div className="relative">
          {showSettings && (
            <div className="absolute bottom-10 right-0 w-48 bg-[#1e1e1e] border border-white/10 rounded-lg shadow-2xl p-4 z-50 animate-in fade-in slide-in-from-bottom-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-white/80">字体大小:</span>
                <div className="flex items-center gap-2 bg-[#2d2d2e] rounded p-0.5 border border-white/10">
                  <button
                    onClick={() => setFontSize((s) => Math.max(10, s - 1))}
                    className="p-1 hover:bg-white/10 rounded text-white/60 hover:text-white transition-colors"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <span className="text-sm font-mono min-w-[1.5rem] text-center text-white">
                    {fontSize}
                  </span>
                  <button
                    onClick={() => setFontSize((s) => Math.min(24, s + 1))}
                    className="p-1 hover:bg-white/10 rounded text-white/60 hover:text-white transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`transition-colors ${showSettings ? "text-white" : "text-white/60 hover:text-white/80"}`}
              >
                <Settings className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>设置</TooltipContent>
          </Tooltip>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => {
                setShowSidebar(!showSidebar);
                setActiveTab("command");
              }}
              className={`transition-colors ${showSidebar ? "text-white" : "text-white/60 hover:text-white/80"}`}
            >
              <Code className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>命令中心</TooltipContent>
        </Tooltip>
      </div>
    </div>
    </TooltipProvider>
  );
}
