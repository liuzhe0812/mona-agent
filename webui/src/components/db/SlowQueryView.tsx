import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Search, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDbStore } from "./store/dbStore";
import { displayCellValue } from "./types";

interface SlowQueryRow {
  start_time: string;
  user_host: string;
  query_time: string;
  lock_time: string;
  rows_sent: string;
  rows_examined: string;
  sql_text: string;
}

export function SlowQueryView() {
  const selectedConnectionId = useDbStore((s) => s.selectedConnectionId);
  const [rows, setRows] = useState<SlowQueryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    if (!selectedConnectionId) return;
    setLoading(true);
    setError(null);
    try {
      const ipc = await import("./ipc");
      const enabledResult = await ipc.dbExecuteQuery(
        selectedConnectionId,
        "SHOW VARIABLES LIKE 'slow_query_log'",
      );
      const enabledVal = enabledResult.rows[0]
        ? displayCellValue(enabledResult.rows[0][1])
        : "OFF";
      setEnabled(enabledVal === "ON");

      try {
        const result = await ipc.dbExecuteQuery(
          selectedConnectionId,
          "SELECT start_time, user_host, query_time, lock_time, rows_sent, rows_examined, sql_text FROM mysql.slow_log ORDER BY start_time DESC LIMIT 200",
        );
        const parsed: SlowQueryRow[] = result.rows.map((row) => ({
          start_time: displayCellValue(row[0]),
          user_host: displayCellValue(row[1]),
          query_time: displayCellValue(row[2]),
          lock_time: displayCellValue(row[3]),
          rows_sent: displayCellValue(row[4]),
          rows_examined: displayCellValue(row[5]),
          sql_text: displayCellValue(row[6]),
        }));
        setRows(parsed);
      } catch {
        try {
          const result = await ipc.dbExecuteQuery(
            selectedConnectionId,
            "SHOW VARIABLES LIKE 'slow_query_log_file'",
          );
          const logFile = result.rows[0] ? displayCellValue(result.rows[0][1]) : "";
          setError(
            `无法读取慢查询日志表。慢查询日志文件: ${logFile || "未配置"}`,
          );
        } catch {
          setError("无法读取慢查询日志，请检查是否已开启慢查询日志。");
        }
        setRows([]);
      }
    } catch (e) {
      setError(String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [selectedConnectionId]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = search
    ? rows.filter((r) => r.sql_text.toLowerCase().includes(search.toLowerCase()))
    : rows;

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
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">
          慢查询日志: {enabled === null ? "检测中..." : enabled ? "已开启" : "未开启"}
        </span>
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索 SQL..."
            className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-[12px] outline-none focus:border-ring"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="p-5 text-sm text-destructive">{error}</div>
        ) : (
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                {["时间", "用户@主机", "查询耗时", "锁等待", "扫描行数", "返回行数", "SQL"].map(
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
              {filtered.map((row, idx) => (
                <tr
                  key={idx}
                  className="border-b border-border/50 hover:bg-accent cursor-pointer"
                  onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                >
                  <td className="whitespace-nowrap px-2.5 py-1 text-[11px] text-muted-foreground">
                    {row.start_time}
                  </td>
                  <td className="max-w-[150px] truncate px-2.5 py-1 text-[11px]">
                    {row.user_host}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1">
                    <span className="rounded bg-orange-500/15 px-1 py-0.5 text-[10px] font-medium text-orange-500">
                      {row.query_time}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1 text-[11px] text-muted-foreground">
                    {row.lock_time}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1 text-[11px]">
                    {row.rows_examined}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1 text-[11px]">
                    {row.rows_sent}
                  </td>
                  <td className="max-w-[300px] px-2.5 py-1">
                    {expandedIdx === idx ? (
                      <pre className="whitespace-pre-wrap font-mono text-[11px] text-foreground/80">
                        {row.sql_text}
                      </pre>
                    ) : (
                      <span className="truncate font-mono text-[11px] text-foreground/70">
                        {row.sql_text}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && filtered.length === 0 && !error && (
          <div className="p-5 text-sm text-muted-foreground">
            {search ? "没有匹配的慢查询" : "暂无慢查询记录"}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-card px-3.5 py-1 text-[11px] text-muted-foreground">
        共 {filtered.length} 条慢查询
      </div>
    </div>
  );
}
