import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Search, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PageToolbar } from "@/components/ui/page-toolbar";
import { StatusNotice } from "@/components/ui/status-notice";
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
      <EmptyState className="h-full" title="请先连接一个数据库" />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageToolbar
        className="h-10 border-b border-border bg-card px-3.5"
        leading={
          <>
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="shrink-0 text-micro text-muted-foreground">
              慢查询日志: {enabled === null ? "检测中..." : enabled ? "已开启" : "未开启"}
            </span>
          </>
        }
        actions={
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        }
      >
        <div className="relative w-full">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索 SQL..."
            className="h-7 rounded-full pl-7 pr-2 text-caption"
          />
        </div>
      </PageToolbar>
      <div className="flex-1 overflow-auto">
        {error ? (
          <StatusNotice tone="danger" className="m-3.5">
            {error}
          </StatusNotice>
        ) : (
          <table className="w-full border-collapse text-caption">
            <thead>
              <tr>
                {["时间", "用户@主机", "查询耗时", "锁等待", "扫描行数", "返回行数", "SQL"].map(
                  (h) => (
                    <th
                      key={h}
                      className="sticky top-0 z-10 bg-muted px-2.5 py-1.5 text-left text-micro font-semibold uppercase tracking-wider text-muted-foreground"
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
                  <td className="whitespace-nowrap px-2.5 py-1 text-muted-foreground">
                    {row.start_time}
                  </td>
                  <td className="max-w-[150px] truncate px-2.5 py-1">
                    {row.user_host}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1">
                    <span className="rounded-xs bg-warning/15 px-1 py-0.5 text-micro font-medium text-warning">
                      {row.query_time}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1 text-muted-foreground">
                    {row.lock_time}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1 text-right">
                    {row.rows_examined}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-1 text-right">
                    {row.rows_sent}
                  </td>
                  <td className="max-w-[300px] px-2.5 py-1">
                    {expandedIdx === idx ? (
                      <pre className="whitespace-pre-wrap font-mono text-micro text-foreground/80">
                        {row.sql_text}
                      </pre>
                    ) : (
                      <span className="truncate font-mono text-micro text-foreground/70">
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
          <EmptyState
            title={search ? "没有匹配的慢查询" : "暂无慢查询记录"}
          />
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-card px-3.5 py-1 text-micro text-muted-foreground">
        共 {filtered.length} 条慢查询
      </div>
    </div>
  );
}
