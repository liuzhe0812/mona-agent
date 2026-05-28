import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        请先连接一个数据库
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-card px-3.5 py-2">
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          刷新
        </Button>
        <button
          type="button"
          onClick={() => setAutoRefresh((v) => !v)}
          className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
            autoRefresh
              ? "bg-green-500/15 text-green-500"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          自动刷新 5s
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {["ID", "用户", "主机", "数据库", "命令", "时间(s)", "状态", "SQL", ""].map(
                (h) => (
                  <th
                    key={h}
                    className="sticky top-0 z-10 bg-muted px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
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
                <td className="px-2.5 py-1">{proc.id}</td>
                <td className="px-2.5 py-1">{proc.user}</td>
                <td className="px-2.5 py-1">{proc.host}</td>
                <td className="px-2.5 py-1">{proc.database ?? "NULL"}</td>
                <td className="px-2.5 py-1">
                  <span
                    className={`rounded px-1 py-0.5 text-[10px] font-medium ${
                      proc.command === "Query"
                        ? "bg-blue-500/15 text-blue-500"
                        : proc.command === "Sleep"
                          ? "bg-muted text-muted-foreground"
                          : "bg-orange-500/15 text-orange-500"
                    }`}
                  >
                    {proc.command}
                  </span>
                </td>
                <td className="px-2.5 py-1">{proc.time}</td>
                <td className="max-w-[200px] truncate px-2.5 py-1 text-muted-foreground">
                  {proc.state ?? "NULL"}
                </td>
                <td className="max-w-[300px] truncate px-2.5 py-1 font-mono text-[11px] text-foreground/70">
                  {proc.info ?? ""}
                </td>
                <td className="px-2.5 py-1">
                  {proc.command === "Query" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs text-destructive hover:text-destructive"
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
          <div className="p-5 text-sm text-muted-foreground">暂无进程</div>
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-card px-3.5 py-1 text-[11px] text-muted-foreground">
        共 {processes.length} 个进程
      </div>
    </div>
  );
}
