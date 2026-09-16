import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DbIcon } from "./DbIcon";

export function QueryTableSelect({ database, tables, value, disabled, onSelect }: {
  database: string | null;
  tables: string[];
  value: string | null;
  disabled?: boolean;
  onSelect: (table: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? tables.filter((table) => table.toLocaleLowerCase().includes(query)) : tables;
  }, [search, tables]);

  return <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(""); }}>
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="outline" aria-label="选择表" disabled={disabled || !database}
        className="h-8 w-56 shrink-0 justify-between gap-2 px-2 text-caption font-normal">
        <span className="min-w-0 truncate">{value ?? (database ? `在 ${database} 中选择表` : "未绑定数据库")}</span>
        <DbIcon name="chevronRight" className="h-3.5 w-3.5 rotate-90 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-64 p-1">
      <div className="p-1" onKeyDown={(event) => event.stopPropagation()}>
        <Input autoFocus aria-label="筛选表" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入表名筛选" className="h-8 text-caption" />
      </div>
      <div className="max-h-64 overflow-auto">
        {filtered.length ? filtered.map((table) => <DropdownMenuItem key={table} className="text-caption" onSelect={() => { onSelect(table); setOpen(false); }}>
          <DbIcon name="table" className="h-4 w-4" /><span className="truncate">{table}</span>
        </DropdownMenuItem>) : <p className="px-2 py-3 text-center text-caption text-muted-foreground">没有匹配的表</p>}
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
}
