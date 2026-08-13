import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Search,
  XCircle,
  Trash2,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ideRemoteGetPorts,
  ideRemoteKillProcess,
} from "@/components/terminal/ipc";
import type { RemotePortInfo } from "@/components/terminal/types/terminal";

interface Props {
  sessionId: string;
}

type ProtocolFilter = "all" | "tcp" | "udp";
type SortField = "port" | "protocol" | "state" | "pid" | "processName";
type SortOrder = "asc" | "desc";

export function PortsPanel({ sessionId }: Props) {
  const [ports, setPorts] = useState<RemotePortInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>("all");
  const [sortField, setSortField] = useState<SortField>("port");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [killDialog, setKillDialog] = useState<{
    open: boolean;
    pid: number | null;
    processName: string;
  }>({ open: false, pid: null, processName: "" });

  const loadPorts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await ideRemoteGetPorts(sessionId);
      setPorts(data.ports);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadPorts();
  }, [loadPorts]);

  const handleKill = async () => {
    if (!killDialog.pid) return;
    setKillingPid(killDialog.pid);
    setKillDialog({ open: false, pid: null, processName: "" });
    try {
      await ideRemoteKillProcess(sessionId, killDialog.pid);
      await loadPorts();
    } catch (err) {
      setError(`终止进程失败: ${err}`);
    } finally {
      setKillingPid(null);
    }
  };

  const openKillDialog = (pid: number, processName: string | null) => {
    setKillDialog({ open: true, pid, processName: processName || "unknown" });
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const filteredPorts = useMemo(() => {
    return ports
      .filter((port) => {
        if (protocolFilter !== "all" && port.protocol !== protocolFilter) {
          return false;
        }
        if (searchTerm) {
          const term = searchTerm.toLowerCase();
          return (
            port.localPort.toString().includes(term) ||
            (port.processName?.toLowerCase().includes(term) ?? false) ||
            (port.pid?.toString().includes(term) ?? false) ||
            port.localAddr.toLowerCase().includes(term)
          );
        }
        return true;
      })
      .sort((a, b) => {
        let aVal: number | string = 0;
        let bVal: number | string = 0;

        switch (sortField) {
          case "port":
            aVal = a.localPort;
            bVal = b.localPort;
            break;
          case "protocol":
            aVal = a.protocol;
            bVal = b.protocol;
            break;
          case "state":
            aVal = a.state;
            bVal = b.state;
            break;
          case "pid":
            aVal = a.pid ?? 0;
            bVal = b.pid ?? 0;
            break;
          case "processName":
            aVal = a.processName ?? "";
            bVal = b.processName ?? "";
            break;
        }

        if (typeof aVal === "string") {
          return sortOrder === "asc"
            ? aVal.localeCompare(bVal as string)
            : (bVal as string).localeCompare(aVal);
        }
        return sortOrder === "asc"
          ? aVal - (bVal as number)
          : (bVal as number) - aVal;
      });
  }, [ports, protocolFilter, searchTerm, sortField, sortOrder]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索端口、进程、PID..."
            className="h-7 rounded-md pl-7 pr-7 text-caption"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <XCircle className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {(["all", "tcp", "udp"] as ProtocolFilter[]).map((filter) => (
              <Button
                key={filter}
                variant={protocolFilter === filter ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setProtocolFilter(filter)}
              >
                {filter === "all" ? "全部" : filter.toUpperCase()}
              </Button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={loadPorts}
            disabled={loading}
            className="h-6 w-6"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
          </Button>
        </div>
        {error && (
          <div className="text-micro text-destructive">
            {error}
            <button
              type="button"
              onClick={loadPorts}
              className="ml-2 underline"
            >
              重试
            </button>
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading && ports.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-caption text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中...
          </div>
        ) : (
          <table className="w-full text-micro">
            <thead className="sticky top-0 bg-muted">
              <tr className="border-b text-left text-muted-foreground">
                <th
                  className="cursor-pointer px-2 py-1.5 font-medium hover:text-foreground"
                  onClick={() => handleSort("port")}
                >
                  端口 {sortField === "port" && (sortOrder === "asc" ? "↑" : "↓")}
                </th>
                <th
                  className="cursor-pointer px-1 py-1.5 font-medium hover:text-foreground"
                  onClick={() => handleSort("protocol")}
                >
                  协议 {sortField === "protocol" && (sortOrder === "asc" ? "↑" : "↓")}
                </th>
                <th className="px-1 py-1.5 font-medium">状态</th>
                <th
                  className="cursor-pointer px-1 py-1.5 font-medium hover:text-foreground"
                  onClick={() => handleSort("pid")}
                >
                  PID {sortField === "pid" && (sortOrder === "asc" ? "↑" : "↓")}
                </th>
                <th
                  className="cursor-pointer px-1 py-1.5 font-medium hover:text-foreground"
                  onClick={() => handleSort("processName")}
                >
                  进程 {sortField === "processName" && (sortOrder === "asc" ? "↑" : "↓")}
                </th>
                <th className="w-8 px-1 py-1.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredPorts.map((port, index) => (
                <tr
                  key={`${port.protocol}-${port.localAddr}-${port.localPort}-${index}`}
                  className="border-b border-border/50 hover:bg-accent"
                >
                  <td className="px-2 py-1.5 font-mono">{port.localPort}</td>
                  <td className="px-1 py-1.5">
                    <span
                      className={cn(
                        "rounded-xs px-1 py-0.5 text-micro",
                        port.protocol === "tcp"
                          ? "bg-info/15 text-info"
                          : "bg-success/15 text-success",
                      )}
                    >
                      {port.protocol.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-1 py-1.5 text-muted-foreground">
                    {port.state}
                  </td>
                  <td className="px-1 py-1.5 font-mono">
                    {port.pid ?? "-"}
                  </td>
                  <td
                    className="max-w-[80px] truncate px-1 py-1.5"
                    title={port.processName ?? undefined}
                  >
                    {port.processName ?? "-"}
                  </td>
                  <td className="px-1 py-1.5">
                    {port.pid && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          openKillDialog(port.pid as number, port.processName)
                        }
                        disabled={killingPid === port.pid}
                        className="h-5 w-5 text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
                      >
                        {killingPid === port.pid ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && filteredPorts.length === 0 && (
          <EmptyState title={searchTerm ? "无匹配结果" : "暂无端口数据"} />
        )}
      </ScrollArea>

      <div className="shrink-0 border-t px-2 py-1 text-micro text-muted-foreground">
        共 {ports.length} 个端口，显示 {filteredPorts.length} 个
      </div>

      <AlertDialog
        open={killDialog.open}
        onOpenChange={(open) => setKillDialog((prev) => ({ ...prev, open }))}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <AlertDialogTitle>确认终止进程</AlertDialogTitle>
                <AlertDialogDescription className="mt-1">
                  确定要终止进程 <strong>{killDialog.processName}</strong>（PID: {" "}
                  <code>{killDialog.pid}</code>）吗？
                  <br />
                  <span className="text-micro text-warning">
                    此操作可能会导致相关服务中断。
                  </span>
                </AlertDialogDescription>
              </div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleKill}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              终止进程
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
