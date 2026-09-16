import { useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { DbIcon } from "./DbIcon";

export function QueryDatabaseSelect({
  databases,
  value,
  disabled,
  onSelect,
}: {
  databases: string[];
  value: string | null;
  disabled?: boolean;
  onSelect: (database: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value ?? "");
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? databases.filter((database) => database.toLocaleLowerCase().includes(query)) : databases;
  }, [databases, search]);

  useEffect(() => {
    if (!open) setInputValue(value ?? "");
  }, [open, value]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function openList(selectText = false) {
    if (disabled) return;
    setSearch("");
    setInputValue(value ?? "");
    setOpen(true);
    if (selectText) requestAnimationFrame(() => inputRef.current?.select());
  }

  function choose(database: string) {
    onSelect(database);
    setInputValue(database);
    setSearch("");
    setOpen(false);
  }

  return <div ref={rootRef} className="relative z-30 w-48 shrink-0">
    <div className={cn("flex h-8 overflow-hidden rounded-md bg-muted/70", disabled && "cursor-not-allowed opacity-50")}>
      <input
        ref={inputRef}
        role="combobox"
        aria-label="查询数据库"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls="query-database-options"
        autoComplete="off"
        disabled={disabled}
        value={inputValue}
        placeholder="选择或输入数据库"
        className="min-w-0 flex-1 border-0 bg-transparent px-2 font-mono text-caption outline-none disabled:cursor-not-allowed"
        onFocus={(event) => { openList(); event.currentTarget.select(); }}
        onChange={(event) => { setInputValue(event.target.value); setSearch(event.target.value); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
          else if (event.key === "Enter" && open) {
            event.preventDefault();
            const exact = databases.find((database) => database.toLocaleLowerCase() === inputValue.trim().toLocaleLowerCase());
            const database = exact ?? filtered[0];
            if (database) choose(database);
          } else if (event.key === "Escape") { event.preventDefault(); setOpen(false); setInputValue(value ?? ""); }
        }}
      />
      <button type="button" aria-label={open ? "收起数据库列表" : "展开数据库列表"} aria-expanded={open} disabled={disabled}
        className="flex w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent disabled:cursor-not-allowed"
        onClick={() => { if (open) setOpen(false); else openList(true); }}>
        <DbIcon name="chevronRight" className={cn("h-3.5 w-3.5 transition-transform", open ? "-rotate-90" : "rotate-90")} />
      </button>
    </div>
    {open && <div id="query-database-options" role="listbox" aria-label="数据库列表" className="absolute left-0 top-full z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1.5 shadow-float">
      {filtered.length ? filtered.map((database) => <button key={database} type="button" role="option" aria-selected={database === value}
        className={cn("flex h-9 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-caption focus-visible:outline-none", database === value ? "bg-info/25" : "hover:bg-accent focus-visible:bg-accent")}
        onClick={() => choose(database)}>
        <DbIcon name="database" className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate">{database}</span>
        {database === value && <Check className="h-4 w-4 shrink-0 text-info" aria-label="当前数据库" />}
      </button>) : <p className="px-2 py-3 text-center text-caption text-muted-foreground">没有匹配的数据库</p>}
    </div>}
  </div>;
}
