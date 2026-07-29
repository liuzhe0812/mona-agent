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
import {
  ideRemoteGetProcesses,
  ideRemoteKillProcess,
} from "@/components/terminal/ipc";
import type { RemoteProcessInfo } from "@/components/terminal/types/terminal";

interface Props {
  sessionId: string;
}

type SortField = "cpu" | "mem" | "pid" | "name" | "user";
type SortOrder = "asc" | "desc";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** exp).toFixed(1)} ${units[exp]}`;
}

export function ProcessesPanel({ sessionId }: Props) {
  const [processes, setProcesses] = useState<RemoteProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortField, setSortField] = useState<SortField>("cpu");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [killDialog, setKillDialog] = useState<{
    open: boolean;
    pid: number | null;
    processName: string;
  }>({ open: false, pid: null, processName: "" });

  const loadProcesses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await ideRemoteGetProcesses(sessionId);
      setProcesses(data.processes);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadProcesses();
  }, [loadProcesses]);

  const handleKill = async () => {
    if (!killDialog.pid) return;
    setKillingPid(killDialog.pid);
    setKillDialog({ open: false, pid: null, processName: "" });
    try {
      await ideRemoteKillProcess(sessionId, killDialog.pid);
      await loadProcesses();
    } catch (err) {
      setError(`终止进程失败: ${err}`);
    } finally {
      setKillingPid(null);
    }
  };

  const openKillDialog = (pid: number, processName: string) => {
    setKillDialog({ open: true, pid, processName });
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder(field === "name" || field === "user" ? "asc" : "desc");
    }
  };

  const filteredProcesses = useMemo(() => {
    return processes
      .filter((proc) => {
        if (!searchTerm) return true;
        const term = searchTerm.toLowerCase();
        return (
          proc.name.toLowerCase().includes(term) ||
          proc.user.toLowerCase().includes(term) ||
          proc.pid.toString().includes(term)
        );
      })
      .sort((a, b) => {
        let aVal: number | string = 0;
        let bVal: number | string = 0;

        switch (sortField) {
          case "cpu":
            aVal = a.cpuPercent;
            bVal = b.cpuPercent;
            break;
          case "mem":
            aVal = a.memPercent;
            bVal = b.memPercent;
            break;
          case "pid":
            aVal = a.pid;
            bVal = b.pid;
            break;
          case "name":
            aVal = a.name.toLowerCase();
            bVal = b.name.toLowerCase();
            break;
          case "user":
            aVal = a.user.toLowerCase();
            bVal = b.user.toLowerCase();
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
  }, [processes, searchTerm, sortField, sortOrder]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索进程、用户、PID..."
            className="h-7 rounded-md pl-7 pr-7 text-xs"
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
          <span className="text-[10px] text-muted-foreground">
            共 {processes.length} 个进程
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={loadProcesses}
            disabled={loading}
            className="h-6 w-6"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
            />
          </Button>
        </div>
        {error && (
          <div className="text-[10px] text-destructive">
            {error}
            <button
              type="button"
              onClick={loadProcesses}
              className="ml-2 underline"
            >
              重试
            </button>
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading && processes.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中...
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-sidebar">
              <tr className="border-b text-left text-muted-foreground">
                <th
                  className="cursor-pointer px-2 py-1.5 font-medium hover:text-foreground"
                  onClick={() => handleSort("pid")}
                >
                  PID {sortField === "pid" && (sortOrder === "asc" ? "↑" : "↓")}
                </th>
                <th
                  className="cursor-pointer px-1 py-1.5 font-medium hover:text-foreground"
                  onClick={() => handleSort("name")}
                >
                  进程 {sortField === "name" && (sortOrder === "asc" ? "↑" : "↓")}
                </th>
                <th
                  className="cursor-pointer px-1 py-1.5 font-medium hover:text-foreground"
                  onClick={() => handleSort("user")}
                >
                  用户 {sortField === "user" && (sortOrder === "asc" ? "↑" : "↓")}
                </th>
                <th
                  className="cursor-pointer whitespace-nowrap px-1 py-1.5 font-medium hover:text-foreground"
                  onClick={() => handleSort("cpu")}
                >
                  CPU {sortField === "cpu" && (sortOrder === "asc" ? "↑" : "↓")}
                </th>
                <th
                  className="cursor-pointer px-1 py-1.5 font-medium hover:text-foreground"
                  onClick={() => handleSort("mem")}
                >
                  内存 {sortField === "mem" && (sortOrder === "asc" ? "↑" : "↓")}
                </th>
                <th className="w-8 px-1 py-1.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredProcesses.map((proc) => (
                <tr
                  key={proc.pid}
                  className="border-b border-border/50 hover:bg-accent"
                >
                  <td className="px-2 py-1.5 font-mono">{proc.pid}</td>
                  <td
                    className="max-w-[80px] truncate px-1 py-1.5"
                    title={proc.name}
                  >
                    {proc.name}
                  </td>
                  <td className="max-w-[60px] truncate px-1 py-1.5 text-muted-foreground">
                    {proc.user}
                  </td>
                  <td className="px-1 py-1.5">{proc.cpuPercent.toFixed(1)}%</td>
                  <td className="px-1 py-1.5">
                    {proc.memPercent.toFixed(1)}%
                    <div className="text-[9px] text-muted-foreground">
                      {formatBytes(proc.memRss * 1024)}
                    </div>
                  </td>
                  <td className="px-1 py-1.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openKillDialog(proc.pid, proc.name)}
                      disabled={killingPid === proc.pid}
                      className="h-5 w-5 text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
                    >
                      {killingPid === proc.pid ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && filteredProcesses.length === 0 && (
          <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
            {searchTerm ? "无匹配结果" : "暂无进程数据"}
          </div>
        )}
      </ScrollArea>

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
                  <span className="text-[10px] text-orange-500">
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
