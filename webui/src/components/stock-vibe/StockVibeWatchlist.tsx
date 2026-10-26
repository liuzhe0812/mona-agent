import { useEffect, useId, useRef, useState, type ReactNode, type CompositionEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getStockVibeWorkbenchMarket, searchStockVibeSymbols, type StockVibeWorkbenchMarketData } from "@/lib/stock-vibe-api";
import { stockDirection, stockNumber, stockPrice, workbenchMarket } from "@/lib/stock-vibe-market";
import { saveStockVibeMarketSnapshot } from "@/lib/stock-vibe-market-cache";
import { inferStockVibeExchange } from "@/lib/stock-vibe-symbol";

export interface StockVibeWatchlistProps {
  symbols: string[];
  paperTrading: ReactNode;
  selectedSymbol: string | null;
  currentMarket: StockVibeWorkbenchMarketData | null;
  knownQuotes: Record<string, StockVibeWorkbenchMarketData>;
  onSelect: (symbol: string) => void;
  onAdd: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onReorder: (symbols: string[]) => void;
}

export function StockVibeWatchlist({ symbols, paperTrading, selectedSymbol, currentMarket, knownQuotes,
  onSelect, onAdd, onRemove, onReorder }: StockVibeWatchlistProps) {
  const [pool, setPool] = useState<"watch" | "holdings">("watch");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(""), [error, setError] = useState<string | null>(null), [filter, setFilter] = useState("");
  const [candidates, setCandidates] = useState<Array<{ symbol: string; name: string }>>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<{ symbol: string; name: string } | null>(null);
  const [searching, setSearching] = useState(false), [searchFailed, setSearchFailed] = useState(false), [composing, setComposing] = useState(false);
  const [background, setBackground] = useState<Record<string, { data?: StockVibeWorkbenchMarketData; failed: boolean }>>({});
  const lastRead = useRef<Record<string, number>>({}), pending = useRef(new Set<string>()), mounted = useRef(true);
  const composingRef = useRef(false);
  const dragSymbol = useRef<string | null>(null), dragRow = useRef<HTMLLIElement | null>(null);
  const dropTarget = useRef<{ symbol: string; row: HTMLLIElement } | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const resultsId = `${id}-search-results`;
  const dragType = "application/mona-stock-watch-symbol";
  const items = symbols;
  const quoteFor = (symbol: string) => {
    if (symbol === selectedSymbol && currentMarket?.symbol === symbol) return currentMarket;
    const cached = background[symbol]?.data, known = knownQuotes[symbol];
    return cached && (!known || Date.parse(cached.observed_at) >= Date.parse(known.observed_at)) ? cached : known;
  };
  const filtered = filter.trim()
    ? items.filter((symbol) => `${symbol.slice(0, 6)} ${quoteFor(symbol)?.quote.name ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase())) : items;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const query = draft.trim();
    setCandidates([]);
    setSelectedCandidate(null);
    setSearchFailed(false);
    if (!adding || composing || !query || /^\d{6}$/.test(query)) {
      setSearching(false);
      return;
    }

    let current = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchStockVibeSymbols(query).then((result) => {
        const native = result?.native;
        const found = Array.isArray(native?.candidates) ? native.candidates.filter((candidate) =>
          candidate && typeof candidate.name === "string" && candidate.name.trim()
          && typeof candidate.symbol === "string" && /^\d{6}\.(?:SH|SZ|BJ)$/i.test(candidate.symbol)) : [];
        if (current) setCandidates(found);
      }).catch(() => {
        if (current) setSearchFailed(true);
      }).finally(() => {
        if (current) setSearching(false);
      });
    }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [adding, composing, draft]);
  useEffect(() => {
    if (!selectedSymbol || pool !== "watch") return;
    for (const symbol of filtered) {
      if (pending.current.size >= 2) break;
      const observed = Date.parse(knownQuotes[symbol]?.observed_at ?? "");
      if (symbol === selectedSymbol || pending.current.has(symbol)
        || Date.now() - Math.max(lastRead.current[symbol] ?? 0, Number.isFinite(observed) ? observed : 0) < 60000) continue;
      lastRead.current[symbol] = Date.now();
      pending.current.add(symbol);
      void (async () => {
        let data: StockVibeWorkbenchMarketData | undefined, failed = false;
        try {
          const result = await getStockVibeWorkbenchMarket(symbol, "intraday");
          const native = workbenchMarket(result, symbol);
          if (!native || native.status !== "ok") throw new Error("行情不可用");
          data = native;
          saveStockVibeMarketSnapshot(symbol, "intraday", result);
        } catch { failed = true; }
        finally { pending.current.delete(symbol); }
        if (mounted.current) setBackground((values) => ({ ...values, [symbol]: data ? { data, failed } : { ...values[symbol], failed } }));
      })();
    }
  }, [selectedSymbol, currentMarket?.observed_at, symbols, pool, filter, knownQuotes, background]);

  const clearDropTarget = () => {
    dropTarget.current?.row.removeAttribute("data-drop");
    dropTarget.current = null;
  };
  const clearDrag = () => {
    dragRow.current?.removeAttribute("data-dragging");
    dragRow.current = null;
    dragSymbol.current = null;
    clearDropTarget();
  };
  const changePool = (next: "watch" | "holdings") => { setPool(next); setFilter(""); clearDrag(); };
  const rowDropPosition = (event: DragEvent<HTMLLIElement>) =>
    event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2 ? "before" : "after";
  const reorderVisible = (source: string, target: string, position: "before" | "after") => {
    if (!symbols.includes(source) || !symbols.includes(target) || source === target) return;
    const visible = filtered.filter((symbol) => symbol !== source);
    const targetIndex = visible.indexOf(target);
    if (targetIndex < 0) return;
    visible.splice(targetIndex + (position === "after" ? 1 : 0), 0, source);

    // Reorder visible slots only so filtering never removes or moves hidden rows.
    let visibleIndex = 0;
    const reordered = symbols.map((symbol) => filter.trim() && !filtered.includes(symbol) ? symbol : visible[visibleIndex++]);
    if (reordered.some((symbol, index) => symbol !== symbols[index])) onReorder(reordered);
  };
  const onRowDragStart = (event: DragEvent<HTMLLIElement>, symbol: string) => {
    if (pool !== "watch" || symbols.length < 2) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(dragType, symbol);
    dragSymbol.current = symbol;
    dragRow.current = event.currentTarget;
    event.currentTarget.dataset.dragging = "true";
  };
  const onRowDragOver = (event: DragEvent<HTMLLIElement>, symbol: string) => {
    if (pool !== "watch" || !event.dataTransfer.types.includes(dragType)) return;
    event.preventDefault();
    if (symbol === dragSymbol.current) { clearDropTarget(); return; }
    clearDropTarget();
    event.currentTarget.dataset.drop = rowDropPosition(event);
    dropTarget.current = { symbol, row: event.currentTarget };
  };
  const onRowDrop = (event: DragEvent<HTMLLIElement>, target: string) => {
    const source = event.dataTransfer.getData(dragType);
    if (pool !== "watch" || !event.dataTransfer.types.includes(dragType) || !source || dragSymbol.current !== source || source === target
      || !symbols.includes(source) || !symbols.includes(target)) return;
    event.preventDefault();
    reorderVisible(source, target, rowDropPosition(event));
    clearDrag();
  };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "watch" : event.key === "End" ? "holdings" : pool === "watch" ? "holdings" : "watch";
    changePool(next);
    document.getElementById(`${id}-${next}-tab`)?.focus();
  };
  const addResolvedSymbol = (symbol: string) => {
    const normalized = symbol.toUpperCase();
    if (symbols.some((item) => item.toUpperCase() === normalized)) { setError("这只股票已在自选中。"); return; }
    onAdd(normalized); setDraft(""); setError(null); setCandidates([]); setSelectedCandidate(null); setAdding(false);
  };
  const addSymbol = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (composingRef.current) return;
    if (selectedCandidate) { addResolvedSymbol(selectedCandidate.symbol); return; }
    const code = draft.trim();
    if (!/^\d{6}$/.test(code)) { setError("请选择搜索结果，或输入六位数字代码添加。"); return; }
    const exchange = inferStockVibeExchange(code);
    if (!exchange) { setError("暂无法识别该代码，请核对六位 A 股代码。"); return; }
    addResolvedSymbol(`${code}.${exchange}`);
  };
  const changeDraft = (value: string) => {
    setDraft(value); setError(null); setCandidates([]); setSelectedCandidate(null); setSearching(false); setSearchFailed(false);
  };
  const openAddDialog = () => {
    composingRef.current = false; setComposing(false); changeDraft(""); setAdding(true);
  };
  const searchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && (event.nativeEvent.isComposing || composing || event.nativeEvent.keyCode === 229)) {
      event.preventDefault(); return;
    }
    if (!candidates.length || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const current = candidates.findIndex((candidate) => candidate.symbol === selectedCandidate?.symbol);
    const next = event.key === "ArrowDown"
      ? (current + 1 + candidates.length) % candidates.length
      : current < 0 ? candidates.length - 1 : (current - 1 + candidates.length) % candidates.length;
    setSelectedCandidate(candidates[next]); setError(null);
  };
  const dataDate = [...new Set(filtered.flatMap((symbol) => quoteFor(symbol)?.trading_date ?? []))];

  return <aside className="stock-vibe-watchlist flex min-h-0 min-w-0 flex-col gap-3">
    <div className="flex items-center justify-between gap-1">
      <div className="flex min-w-0 gap-3" role="tablist" aria-label="股票列表">
        {([ ["watch", `自选 ${symbols.length}`], ["holdings", "模拟持仓"] ] as const).map(([value, label]) =>
          <Button key={value} id={`${id}-${value}-tab`} role="tab" aria-selected={pool === value}
            aria-controls={`${id}-panel`} tabIndex={pool === value ? 0 : -1} onKeyDown={tabKey}
            variant="ghost" className="stock-vibe-watch-tab" data-active={pool === value} onClick={() => changePool(value)}>{label}</Button>)}
      </div>
      {pool === "watch" && <div className="flex shrink-0 items-center gap-0.5">
        <Button ref={addButton} variant="ghost" size="icon" className="h-7 w-7" aria-label="添加自选" title="添加自选" onClick={openAddDialog}><Plus size={16} /></Button>
      </div>}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${pool}-tab`} className="flex min-h-0 flex-col gap-2">
      {pool === "holdings" ? paperTrading : <>
      <Input aria-label="筛选自选" placeholder="筛选名称或代码" value={filter} onChange={(event) => setFilter(event.target.value)} />
      {filtered.length > 0 ? <ul className="stock-vibe-watch-items min-h-0 space-y-1 overflow-y-auto" aria-label="自选股票">
        {filtered.map((symbol) => {
          const item = quoteFor(symbol), value = item?.quote, direction = stockDirection(value?.price, value?.previous_close);
          const pct = stockNumber(value?.price) && stockNumber(value?.previous_close) && value.previous_close > 0
            ? (value.price - value.previous_close) / value.previous_close * 100 : null;
          const name = value?.name?.trim(), code = symbol.slice(0, 6);
          const status = background[symbol]?.failed ? item ? "行情更新失败，保留上次行情。" : "行情暂未读取，可选择股票重试。"
            : item?.status === "unavailable" ? "行情暂不可用。" : item ? `行情截至 ${item.quote.as_of ?? item.trading_date ?? item.observed_at}` : "尚未读取行情。";
          const row = <li key={symbol} className="stock-vibe-watch-row flex min-w-0 items-center gap-1" data-selected={symbol === selectedSymbol}
            draggable={pool === "watch" && symbols.length > 1}
            onDragStart={(event) => onRowDragStart(event, symbol)}
            onDragOver={(event) => onRowDragOver(event, symbol)}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              if (dropTarget.current?.symbol === symbol) clearDropTarget();
            }}
            onDrop={(event) => onRowDrop(event, symbol)}
            onDragEnd={clearDrag}>
            <Button variant="ghost"
              draggable={pool === "watch" && symbols.length > 1}
              title={`${name || code} · ${status}${pool === "watch" && symbols.length > 1 ? " · 按 Alt+↑/↓ 调整顺序" : ""}`}
              aria-keyshortcuts={pool === "watch" && symbols.length > 1 ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
              onKeyDown={(event) => {
                if (pool !== "watch" || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                event.preventDefault();
                const index = filtered.indexOf(symbol);
                const target = filtered[index + (event.key === "ArrowUp" ? -1 : 1)];
                if (target) reorderVisible(symbol, target, event.key === "ArrowUp" ? "before" : "after");
              }}
              className="stock-vibe-watch-select h-auto min-w-0 flex-1 justify-between gap-2 px-2 py-2.5 tabular-nums"
              aria-pressed={symbol === selectedSymbol} onClick={() => onSelect(symbol)}>
              <span className="min-w-0 text-left"><span className="block truncate">{name || code}</span>
                {name && <span className="mt-0.5 block text-micro font-normal text-muted-foreground">{code}</span>}</span>
              <span className={`shrink-0 text-right ${direction}`}><span className="block">{stockNumber(value?.price) ? stockPrice(value.price) : "—"}</span>
                <span className="mt-0.5 block text-caption font-normal">{pct === null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`}</span></span>
            </Button>
          </li>;
          return pool === "watch" ? <ContextMenu key={symbol}>
            <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => onRemove(symbol)}>
                <X size={14} aria-hidden="true" />移除自选
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu> : row;
        })}
      </ul> : <div className="space-y-2 px-2 py-4 text-caption text-muted-foreground" role="status">
        <p>{filter ? "没有匹配的股票。" : pool === "watch" ? "还没有自选股票。" : ""}</p>
        {filter ? <Button variant="ghost" size="sm" onClick={() => setFilter("")}>清除筛选</Button>
          : pool === "watch" && <Button variant="secondary" size="sm" onClick={openAddDialog}>添加第一只股票</Button>}
      </div>}
      {dataDate.length > 0 && <p className="px-2 text-micro text-muted-foreground">{dataDate.length === 1 ? `行情日期 ${dataDate[0]}` : "行情时点见各股票详情"}</p>}
      </>}
    </div>
    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent className="scrollbar-scope stock-vibe-workbench max-w-sm" aria-describedby={undefined}
        onCloseAutoFocus={(event) => { event.preventDefault(); addButton.current?.focus(); }}>
        <DialogHeader><DialogTitle>添加自选</DialogTitle></DialogHeader>
        <form className="space-y-4" onSubmit={addSymbol}>
          <div className="space-y-2"><label className="text-caption" htmlFor={`${id}-symbol`}>股票名称或代码</label>
            <Input id={`${id}-symbol`} autoFocus value={draft} onChange={(event) => changeDraft(event.target.value)}
              onCompositionStart={() => { composingRef.current = true; setComposing(true); setSearching(false); }}
              onCompositionEnd={(event: CompositionEvent<HTMLInputElement>) => {
                composingRef.current = false; setComposing(false); changeDraft(event.currentTarget.value);
              }}
              onKeyDown={searchKeyDown} role="combobox" aria-autocomplete="list" aria-controls={resultsId}
              aria-expanded={searching || candidates.length > 0} aria-activedescendant={selectedCandidate ? `${resultsId}-${selectedCandidate.symbol}` : undefined}
              placeholder="输入名称搜索，或输入六位代码" autoComplete="off" spellCheck={false}
              aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined} />
            {searching && <p className="text-caption text-muted-foreground" role="status">正在搜索股票…</p>}
            {searchFailed && <p className="text-caption text-muted-foreground" role="status">搜索暂不可用，可直接输入六位代码添加。</p>}
            {!searching && !searchFailed && draft.trim() && !/^\d{6}$/.test(draft.trim()) && candidates.length === 0
              && !composing && <p className="text-caption text-muted-foreground" role="status">没有找到匹配的股票，可检查名称或改用六位代码。</p>}
            {candidates.length > 0 && <ul id={resultsId} role="listbox" aria-label="股票搜索结果" className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-1">
              {candidates.map((candidate) => {
                const normalized = candidate.symbol.toUpperCase();
                const alreadyAdded = symbols.some((symbol) => symbol.toUpperCase() === normalized);
                const selected = selectedCandidate?.symbol === candidate.symbol;
                return <li key={candidate.symbol}><Button id={`${resultsId}-${candidate.symbol}`} type="button" role="option"
                  aria-selected={selected} disabled={alreadyAdded} variant={selected ? "secondary" : "ghost"}
                  className="h-auto w-full justify-between px-2 py-2 text-left" onClick={() => {
                    setSelectedCandidate(candidate); setError(alreadyAdded ? "这只股票已在自选中。" : null);
                  }}>
                  <span className="truncate">{candidate.name}</span>
                  <span className="ml-3 shrink-0 text-caption text-muted-foreground">{candidate.symbol.slice(0, 6)}{alreadyAdded ? " · 已添加" : ""}</span>
                </Button></li>;
              })}
            </ul>}
            {error && <p id={`${id}-error`} role="alert" className="text-caption text-destructive">{error}</p>}</div>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setAdding(false)}>取消</Button>
            <Button type="submit" className="stock-vibe-primary">{selectedCandidate ? "添加所选股票" : "按代码添加"}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </aside>;
}
