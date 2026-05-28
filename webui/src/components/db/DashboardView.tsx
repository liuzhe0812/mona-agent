import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDbStore } from "./store/dbStore";

export function DashboardView() {
  const selectedConnectionId = useDbStore((s) => s.selectedConnectionId);
  const serverStats = useDbStore((s) => s.serverStats);
  const processes = useDbStore((s) => s.processes);
  const refreshServerStats = useDbStore((s) => s.refreshServerStats);
  const refreshProcesses = useDbStore((s) => s.refreshProcesses);
  const killProcess = useDbStore((s) => s.killProcess);

  useEffect(() => {
    if (selectedConnectionId) {
      refreshServerStats(selectedConnectionId);
      refreshProcesses(selectedConnectionId);
    }
  }, [selectedConnectionId, refreshServerStats, refreshProcesses]);

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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            refreshServerStats(selectedConnectionId);
            refreshProcesses(selectedConnectionId);
          }}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          刷新
        </Button>
        <span className="text-[11px] text-muted-foreground">自动刷新: 30s</span>
      </div>
      <div className="flex-1 overflow-auto p-5">
        {serverStats && (
          <>
            <div className="grid grid-cols-3 gap-3.5">
              <StatCard
                label="连接数"
                value={String(serverStats.connections)}
                sub={`最大: ${serverStats.max_connections} · 使用率 ${Math.round((serverStats.connections / serverStats.max_connections) * 100)}%`}
                color="blue"
              />
              <StatCard
                label="QPS"
                value={serverStats.qps.toLocaleString()}
                sub={`慢查询: ${serverStats.slow_queries}`}
                color="green"
              />
              <StatCard
                label="慢查询"
                value={String(serverStats.slow_queries)}
                sub="最近 1 小时 · >1s"
                color="orange"
              />
              <StatCard
                label="缓冲池命中率"
                value={
                  serverStats.buffer_pool_hit_rate !== null
                    ? `${serverStats.buffer_pool_hit_rate.toFixed(1)}%`
                    : "N/A"
                }
                sub="InnoDB Buffer Pool"
                color="green"
              />
              <StatCard
                label="主从延迟"
                value={
                  serverStats.replication_lag_seconds !== null
                    ? `${serverStats.replication_lag_seconds.toFixed(1)}s`
                    : "N/A"
                }
                sub={serverStats.replication_lag_seconds !== null ? "正常" : "未配置"}
                color="green"
              />
              <StatCard
                label="磁盘使用"
                value={
                  serverStats.disk_usage_gb !== null
                    ? `${serverStats.disk_usage_gb.toFixed(1)} GB`
                    : "N/A"
                }
                sub={
                  serverStats.disk_total_gb !== null
                    ? `总容量 ${serverStats.disk_total_gb}GB`
                    : "未知"
                }
              />
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3.5">
              <ChartPlaceholder title="QPS 趋势" />
              <ChartPlaceholder title="连接数趋势" />
            </div>

            <div className="mt-5">
              <h3 className="mb-2 text-sm font-semibold">活跃进程</h3>
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    {["ID", "用户", "主机", "数据库", "命令", "时间", "状态", ""].map(
                      (h) => (
                        <th
                          key={h}
                          className="bg-muted px-2.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
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
                      <td className="px-2.5 py-1">{proc.command}</td>
                      <td className="px-2.5 py-1">{proc.time}s</td>
                      <td className="px-2.5 py-1">{proc.state ?? "NULL"}</td>
                      <td className="px-2.5 py-1">
                        {proc.command === "Query" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-xs text-destructive hover:text-destructive"
                            onClick={() =>
                              killProcess(selectedConnectionId, proc.id)
                            }
                          >
                            Kill
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color?: "blue" | "green" | "orange" | "red";
}) {
  const colorMap = {
    blue: "text-blue-400",
    green: "text-green-400",
    orange: "text-orange-400",
    red: "text-red-400",
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={`text-2xl font-bold ${color ? colorMap[color] : ""}`}>
        {value}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function ChartPlaceholder({ title }: { title: string }) {
  return (
    <div className="flex h-[180px] items-center justify-center rounded-lg border border-border bg-card text-sm text-muted-foreground">
      📈 {title}图
    </div>
  );
}
