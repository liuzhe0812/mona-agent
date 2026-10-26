import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeftRight, ChevronLeft, ChevronRight, LineChart, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { StockVibeOpportunityCandidate } from "@/lib/stock-vibe-opportunity-api";
import { candidateRisks, candidateSupport } from "./stock-vibe-opportunity-display";

interface StockVibeOpportunityCandidatesProps {
  candidates: StockVibeOpportunityCandidate[];
  selectedSymbol?: string | null;
  comparisonSymbols: string[];
  symbols: string[];
  onSelect: (symbol: string) => void;
  onCompare: (symbol: string) => void;
  onMarket: (symbol: string) => void;
  onAdd: (symbol: string) => void;
}

const QUOTE_NUMBER = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, useGrouping: false });

export function StockVibeOpportunityCandidates({
  candidates, selectedSymbol, comparisonSymbols, symbols, onSelect, onCompare, onMarket, onAdd,
}: StockVibeOpportunityCandidatesProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [{ index: pageIndex, size: pageSize }, setPagination] = useState({ index: 0, size: 4 });
  const pageCount = Math.max(1, Math.ceil(candidates.length / pageSize));
  const page = Math.min(pageIndex, pageCount - 1);
  const start = page * pageSize;

  useLayoutEffect(() => {
    const list = listRef.current;
    const card = list?.querySelector<HTMLElement>(".stock-vibe-opportunity-candidate");
    if (!list || !card) return;
    const measure = () => {
      const height = list.getBoundingClientRect().height;
      const cardHeight = card.getBoundingClientRect().height;
      if (height <= 0 || cardHeight <= 0) return;
      const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 0;
      const size = Math.max(1, Math.floor((height + gap) / (cardHeight + gap)));
      setPagination((previous) => {
        if (previous.size === size) return previous;
        const first = previous.index * previous.size;
        const selected = candidates.findIndex((item) => item.symbol === selectedSymbol);
        const anchor = selected >= first && selected < first + previous.size ? selected : first;
        return { index: Math.floor(anchor / size), size };
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    observer.observe(card);
    return () => observer.disconnect();
  }, [candidates, selectedSymbol, start]);

  useEffect(() => {
    if (pageIndex !== page) {
      setPagination((previous) => ({ ...previous, index: page }));
      if (candidates[start]) onSelect(candidates[start].symbol);
    }
  }, [candidates, onSelect, page, pageIndex, start]);

  function changePage(nextPage: number) {
    const next = Math.max(0, Math.min(nextPage, pageCount - 1));
    if (next === page) return;
    setPagination((previous) => ({ ...previous, index: next }));
    onSelect(candidates[next * pageSize].symbol);
  }

  if (!candidates.length) return null;

  return <TooltipProvider delayDuration={250}>
    <div className="stock-vibe-opportunity-candidates">
      <div className="stock-vibe-opportunity-candidate-head text-caption text-muted-foreground" aria-hidden="true">
        <span className="stock-vibe-opportunity-candidate-rank">#</span>
        <span className="stock-vibe-opportunity-candidate-identity">候选</span>
        <span className="stock-vibe-opportunity-candidate-quote">现价 / 涨跌</span>
        <span className="stock-vibe-opportunity-candidate-reason">入选依据与风险</span>
      </div>
      <div ref={listRef} className="stock-vibe-opportunity-candidates-list">
        {candidates.slice(start, start + pageSize).map((item) => {
          const compared = comparisonSymbols.includes(item.symbol);
          const added = symbols.includes(item.symbol);
          const compareLabel = compared ? "移出对比" : "加入对比";
          const name = item.name || item.symbol.split(".")[0];
          return <article key={item.symbol} className="stock-vibe-opportunity-candidate" data-selected={item.symbol === selectedSymbol}>
            <button type="button" className="stock-vibe-opportunity-candidate-select"
              aria-label={`查看${name}的入选依据`} aria-pressed={item.symbol === selectedSymbol}
              onClick={() => onSelect(item.symbol)}>
              <span className="stock-vibe-opportunity-candidate-rank text-caption">
                {typeof item.rank === "number" ? `第${item.rank}名` : ""}
              </span>
              <span className="stock-vibe-opportunity-candidate-identity">
                <strong className="stock-vibe-opportunity-candidate-name text-ui">{name}</strong>
                {item.name && <span className="text-caption text-muted-foreground">{item.symbol.split(".")[0]}</span>}
              </span>
              {(typeof item.price === "number" && Number.isFinite(item.price)
                || typeof item.change_pct === "number" && Number.isFinite(item.change_pct)) && <span className="stock-vibe-opportunity-candidate-quote text-caption">
                {typeof item.price === "number" && Number.isFinite(item.price) && <span>{QUOTE_NUMBER.format(item.price)}</span>}
                {typeof item.change_pct === "number" && Number.isFinite(item.change_pct) && <span className={`ml-2 ${item.change_pct > 0 ? "stock-vibe-opportunity-up" : item.change_pct < 0 ? "stock-vibe-opportunity-down" : ""}`}>
                  {item.change_pct > 0 ? "+" : ""}{QUOTE_NUMBER.format(item.change_pct)}%
                </span>}
              </span>}
              <span className="stock-vibe-opportunity-candidate-reason">
                <span className="stock-vibe-opportunity-candidate-summary text-caption">{candidateSupport(item)[0] || "入选原因待补充"}</span>
                <span className="stock-vibe-opportunity-candidate-risk text-caption text-muted-foreground">留意：{candidateRisks(item)[0] || "风险资料待补充"}</span>
              </span>
            </button>
            <div className="stock-vibe-opportunity-candidate-actions">
              <Tooltip><TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="xs" className="w-6 px-0" aria-label={compareLabel} aria-pressed={compared}
                  disabled={!compared && comparisonSymbols.length >= 3} onClick={() => onCompare(item.symbol)}>
                  <ArrowLeftRight className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger><TooltipContent>{compareLabel}</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="xs" className="w-6 px-0" aria-label="看行情" onClick={() => onMarket(item.symbol)}>
                  <LineChart className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger><TooltipContent>看行情</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="xs" className="w-6 px-0" aria-label={added ? "已加自选" : "加自选"}
                  disabled={added} onClick={() => onAdd(item.symbol)}>
                  <Star className="size-4" fill={added ? "currentColor" : "none"} aria-hidden="true" />
                </Button>
              </TooltipTrigger><TooltipContent>{added ? "已加自选" : "加自选"}</TooltipContent></Tooltip>
            </div>
          </article>;
        })}
      </div>
      <nav className="stock-vibe-opportunity-pagination" aria-label="选股结果分页">
        <span className="text-caption text-muted-foreground">{start + 1}–{Math.min(start + pageSize, candidates.length)} / {candidates.length} 只</span>
        <div className="stock-vibe-opportunity-pagination-controls">
          <Button type="button" variant="ghost" size="icon" aria-label="上一页" disabled={page === 0} onClick={() => changePage(page - 1)}>
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <label className="stock-vibe-opportunity-pagination-page text-caption">
            <select aria-label="跳转到页" value={page} onChange={(event) => changePage(Number(event.target.value))}>
              {Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}
            </select>
            <span>/ {pageCount} 页</span>
          </label>
          <Button type="button" variant="ghost" size="icon" aria-label="下一页" disabled={page === pageCount - 1} onClick={() => changePage(page + 1)}>
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </nav>
    </div>
  </TooltipProvider>;
}
