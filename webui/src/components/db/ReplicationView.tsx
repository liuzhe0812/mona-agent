import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageToolbar } from "@/components/ui/page-toolbar";
import { StatusNotice } from "@/components/ui/status-notice";
import { cn } from "@/lib/utils";
import { useDbStore } from "./store/dbStore";
import { displayCellValue } from "./types";

interface ReplicationRow {
  key: string;
  value: string;
}

export function ReplicationView() {
  const selectedConnectionId = useDbStore((s) => s.selectedConnectionId);
  const [masterRows, setMasterRows] = useState<ReplicationRow[]>([]);
  const [slaveRows, setSlaveRows] = useState<ReplicationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"master" | "slave">("slave");

  const load = useCallback(async () => {
    if (!selectedConnectionId) return;
    setLoading(true);
    setError(null);
    try {
      const ipc = await import("./ipc");

      try {
        const masterResult = await ipc.dbExecuteQuery(
          selectedConnectionId,
          "SHOW MASTER STATUS",
        );
        const mRows: ReplicationRow[] = [];
        if (masterResult.columns.length > 0 && masterResult.rows.length > 0) {
          masterResult.columns.forEach((col, i) => {
            mRows.push({
              key: col.name,
              value: displayCellValue(masterResult.rows[0][i]),
            });
          });
        }
        setMasterRows(mRows);
      } catch {
        setMasterRows([]);
      }

      try {
        const slaveResult = await ipc.dbExecuteQuery(
          selectedConnectionId,
          "SHOW SLAVE STATUS",
        );
        const sRows: ReplicationRow[] = [];
        if (slaveResult.columns.length > 0 && slaveResult.rows.length > 0) {
          slaveResult.columns.forEach((col, i) => {
            sRows.push({
              key: col.name,
              value: displayCellValue(slaveResult.rows[0][i]),
            });
          });
        }
        setSlaveRows(sRows);
      } catch {
        setSlaveRows([]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedConnectionId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!selectedConnectionId) {
    return (
      <EmptyState className="h-full" title="请先连接一个数据库" />
    );
  }

  const currentRows = activeTab === "master" ? masterRows : slaveRows;

  const slaveRunning = slaveRows.find((r) => r.key === "Slave_IO_Running")?.value;
  const slaveSqlRunning = slaveRows.find((r) => r.key === "Slave_SQL_Running")?.value;
  const secondsBehind = slaveRows.find((r) => r.key === "Seconds_Behind_Master")?.value;

  return (
    <div className="flex h-full flex-col">
      <PageToolbar
        className="h-10 border-b border-border bg-card px-3.5"
        leading={
          <>
            <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-0.5">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setActiveTab("slave")}
                className={cn(
                  "font-medium",
                  activeTab === "slave"
                    ? "bg-background text-foreground shadow-sm hover:bg-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                从库状态
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setActiveTab("master")}
                className={cn(
                  "font-medium",
                  activeTab === "master"
                    ? "bg-background text-foreground shadow-sm hover:bg-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                主库状态
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              刷新
            </Button>
          </>
        }
      />

      {activeTab === "slave" && slaveRows.length > 0 && (
        <div className="shrink-0 border-b border-border bg-card px-3.5 py-2">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-micro text-muted-foreground">IO 线程:</span>
              <span
                className={`rounded-xs px-1.5 py-0.5 text-micro font-medium ${
                  slaveRunning === "Yes"
                    ? "bg-success/15 text-success"
                    : "bg-destructive/15 text-destructive"
                }`}
              >
                {slaveRunning ?? "N/A"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-micro text-muted-foreground">SQL 线程:</span>
              <span
                className={`rounded-xs px-1.5 py-0.5 text-micro font-medium ${
                  slaveSqlRunning === "Yes"
                    ? "bg-success/15 text-success"
                    : "bg-destructive/15 text-destructive"
                }`}
              >
                {slaveSqlRunning ?? "N/A"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-micro text-muted-foreground">延迟:</span>
              <span
                className={`rounded-xs px-1.5 py-0.5 text-micro font-medium ${
                  secondsBehind === "0" || secondsBehind === null
                    ? "bg-success/15 text-success"
                    : "bg-warning/15 text-warning"
                }`}
              >
                {secondsBehind ?? "N/A"}s
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {error ? (
          <StatusNotice tone="danger" className="m-3.5">
            {error}
          </StatusNotice>
        ) : currentRows.length === 0 ? (
          <EmptyState
            title={
              activeTab === "master"
                ? "未配置为主库或无活跃主库状态"
                : "未配置为从库或无活跃从库状态"
            }
          />
        ) : (
          <table className="w-full border-collapse text-caption">
            <thead>
              <tr>
                <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left text-micro font-semibold uppercase tracking-wider text-muted-foreground">
                  参数
                </th>
                <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left text-micro font-semibold uppercase tracking-wider text-muted-foreground">
                  值
                </th>
              </tr>
            </thead>
            <tbody>
              {currentRows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-border/50 hover:bg-accent"
                >
                  <td className="max-w-[300px] truncate px-3 py-1 font-mono text-micro">
                    {row.key}
                  </td>
                  <td className="px-3 py-1 font-mono text-micro text-foreground/80">
                    {row.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-card px-3.5 py-1 text-micro text-muted-foreground">
        {activeTab === "master"
          ? `主库状态 ${masterRows.length} 个参数`
          : `从库状态 ${slaveRows.length} 个参数`}
      </div>
    </div>
  );
}
