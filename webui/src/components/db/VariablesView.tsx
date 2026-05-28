import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDbStore } from "./store/dbStore";
import { displayCellValue } from "./types";

type VarTab = "variables" | "status" | "charset";

interface VarRow {
  name: string;
  value: string;
}

export function VariablesView() {
  const selectedConnectionId = useDbStore((s) => s.selectedConnectionId);
  const [tab, setTab] = useState<VarTab>("variables");
  const [rows, setRows] = useState<VarRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (!selectedConnectionId) return;
    setLoading(true);
    setError(null);
    try {
      const ipc = await import("./ipc");
      const sql = tab === "variables"
        ? "SHOW VARIABLES"
        : tab === "status"
          ? "SHOW STATUS"
          : "SHOW CHARACTER SET";
      const result = await ipc.dbExecuteQuery(selectedConnectionId, sql);
      const parsed: VarRow[] = result.rows.map((row) => ({
        name: displayCellValue(row[0]),
        value: row.length > 1 ? displayCellValue(row[1]) : "",
      }));
      setRows(parsed);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedConnectionId, tab]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = search
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(search.toLowerCase()) ||
          r.value.toLowerCase().includes(search.toLowerCase()),
      )
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
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-0.5">
          {(["variables", "status", "charset"] as VarTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { setTab(t); setSearch(""); }}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                tab === t
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "variables" ? "变量" : t === "status" ? "状态" : "字符集"}
            </button>
          ))}
        </div>
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索变量名或值..."
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
                <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  变量名
                </th>
                <th className="sticky top-0 z-10 bg-muted px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  值
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.name}
                  className="border-b border-border/50 hover:bg-accent"
                >
                  <td className="max-w-[300px] truncate px-3 py-1 font-mono text-[11px]">
                    {row.name}
                  </td>
                  <td className="px-3 py-1 font-mono text-[11px] text-foreground/80">
                    {row.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && filtered.length === 0 && !error && (
          <div className="p-5 text-sm text-muted-foreground">
            {search ? "没有匹配的变量" : "暂无数据"}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-card px-3.5 py-1 text-[11px] text-muted-foreground">
        共 {filtered.length} 条{search ? ` (筛选自 ${rows.length})` : ""}
      </div>
    </div>
  );
}
