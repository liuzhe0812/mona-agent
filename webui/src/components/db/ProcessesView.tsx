import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageToolbar } from "@/components/ui/page-toolbar";
import { cn } from "@/lib/utils";
import { useDbStore } from "./store/dbStore";

export function ProcessesView() {
  const selectedConnectionId = useDbStore((s) => s.selectedConnectionId);
  const processes = useDbStore((s) => s.processes);
  const refreshProcesses = useDbStore((s) => s.refreshProcesses);
  const killProcess = useDbStore((s) => s.killProcess);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [killing, setKilling] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!selectedConnectionId) return;
    await refreshProcesses(selectedConnectionId);
  }, [selectedConnectionId, refreshProcesses]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh || !selectedConnectionId) return;
    const timer = setInterval(() => {
      refreshProcesses(selectedConnectionId);
    }, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, selectedConnectionId, refreshProcesses]);

  const handleKill = async (processId: number) => {
    if (!selectedConnectionId) return;
    setKilling(processId);
    try {
      await killProcess(selectedConnectionId, processId);
    } finally {
      setKilling(null);
    }
  };

  if (!selectedConnectionId) {
    return (
      <EmptyState className="h-full" title="请先连接一个数据库" />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageToolbar
        className="h-10 border-b border-border bg-card px-3.5"
        leading={
          <>
            <Button variant="ghost" size="sm" onClick={load}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              刷新
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setAutoRefresh((v) => !v)}
              className={cn(
                "font-medium",
                autoRefresh
                  ? "bg-success/15 text-success hover:bg-success/20 hover:text-success"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              自动刷新 5s
            </Button>
          </>
        }
      />
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-caption">
          <thead>
            <tr>
              {["ID", "用户", "主机", "数据库", "命令", "时间(s)", "状态", "SQL", ""].map(
                (h) => (
                  <th
                    key={h}
                    className={
                      h === "ID" || h === "时间(s)"
                        ? "sticky top-0 z-10 bg-muted px-2.5 py-1.5 text-right text-micro font-semibold uppercase tracking-wider text-muted-foreground"
                        : "sticky top-0 z-10 bg-muted px-2.5 py-1.5 text-left text-micro font-semibold uppercase tracking-wider text-muted-foreground"
                    }
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {processes.map((proc) => (
              <tr
                key={proc.id}
                className="border-b border-border/50 hover:bg-accent"
              >
                <td className="px-2.5 py-1 text-right">{proc.id}</td>
                <td className="px-2.5 py-1">{proc.user}</td>
                <td className="px-2.5 py-1">{proc.host}</td>
                <td className="px-2.5 py-1">{proc.database ?? "NULL"}</td>
                <td className="px-2.5 py-1">
                  <span
                    className={`rounded-xs px-1 py-0.5 text-micro font-medium ${
                      proc.command === "Query"
                        ? "bg-info/15 text-info"
                        : proc.command === "Sleep"
                          ? "bg-muted text-muted-foreground"
                          : "bg-warning/15 text-warning"
                    }`}
                  >
                    {proc.command}
                  </span>
                </td>
                <td className="px-2.5 py-1 text-right">{proc.time}</td>
                <td className="max-w-[200px] truncate px-2.5 py-1 text-muted-foreground">
                  {proc.state ?? "NULL"}
                </td>
                <td className="max-w-[300px] truncate px-2.5 py-1 font-mono text-micro text-foreground/70">
                  {proc.info ?? ""}
                </td>
                <td className="px-2.5 py-1">
                  {proc.command === "Query" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-caption text-destructive hover:text-destructive"
                      disabled={killing === proc.id}
                      onClick={() => handleKill(proc.id)}
                    >
                      {killing === proc.id ? "..." : "Kill"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {processes.length === 0 && (
          <EmptyState title="暂无进程" />
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-card px-3.5 py-1 text-micro text-muted-foreground">
        共 {processes.length} 个进程
      </div>
    </div>
  );
}
