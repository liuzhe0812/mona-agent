import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronUp, LoaderCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DevelopmentTurn } from "./development-turns";
import "./development-turn-navigator.css";

interface Props {
  items: DevelopmentTurn[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onJump: (id: string) => void;
  hasOlder: boolean;
  loadOlder: () => Promise<void>;
}

/** Same rail/preview interaction as ZCode; anchors belong to Mona's shared transcript. */
export function DevelopmentTurnNavigator({ items, scrollRef, contentRef, onJump, hasOlder, loadOlder }: Props) {
  const [active, setActive] = useState<string>();
  const [hover, setHover] = useState<number>();
  const [loading, setLoading] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const loadPending = useRef(false);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    const ids = new Set(items.map((item) => item.id));
    const measure = () => {
      frame = 0;
      const top = scroll.getBoundingClientRect().top;
      const anchors = [...scroll.querySelectorAll<HTMLElement>("[data-message-id]")]
        .filter((element) => ids.has(element.dataset.messageId!));
      // During an answer, its user question can already be above the viewport.
      const visible = anchors.filter((element) => element.getBoundingClientRect().bottom >= top
        && element.getBoundingClientRect().top < top + scroll.clientHeight);
      const target = visible.length ? visible.reduce((near, element) =>
        Math.abs(element.getBoundingClientRect().top - top) < Math.abs(near.getBoundingClientRect().top - top) ? element : near)
        : anchors.filter((element) => element.getBoundingClientRect().top <= top).at(-1) ?? anchors[0];
      setActive(target?.dataset.messageId);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    scroll.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(scroll);
    if (contentRef.current) observer?.observe(contentRef.current);
    schedule();
    return () => { scroll.removeEventListener("scroll", schedule); observer?.disconnect(); cancelAnimationFrame(frame); };
  }, [items, scrollRef, contentRef]);

  useEffect(() => {
    const button = active ? itemRefs.current.get(active) : null;
    const container = rail.current;
    if (!button || !container) return;
    const align = () => {
      const top = button.offsetTop;
      if (top < container.scrollTop) container.scrollTop = top;
      else if (top + button.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = top + button.offsetHeight - container.clientHeight;
    };
    align();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    observer?.observe(container);
    return () => observer?.disconnect();
  }, [active, items.length]);

  const readOlder = async () => {
    if (loadPending.current) return;
    loadPending.current = true; setLoading(true);
    try { await loadOlder(); }
    finally { loadPending.current = false; setLoading(false); }
  };
  if (items.length < 2 && !hasOlder) return null;
  return <nav aria-label="会话轮次导航" aria-busy={loading} className="development-turn-navigator pointer-events-none absolute bottom-44 left-0 top-4 z-20 w-12 items-center">
    <TooltipProvider delayDuration={120} skipDelayDuration={80}>
      <div ref={rail} className="pointer-events-auto relative ml-2 max-h-full w-10 overflow-y-auto overflow-x-hidden py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" onPointerLeave={() => setHover(undefined)}>
        {hasOlder && <button type="button" aria-label="加载更早轮次" disabled={loading} onClick={() => void readOlder()} className="mb-2 flex h-6 w-9 items-center justify-start text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {loading ? <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" /> : <ChevronUp className="h-3 w-3" />}
        </button>}
        {items.map((item, index) => {
          const distance = hover === undefined ? Infinity : Math.abs(index - hover);
          const scale = distance === 0 ? 2.6 : distance === 1 ? 1.7 : distance === 2 ? 1.25 : 1;
          const selected = active === item.id;
          return <Tooltip key={item.id}>
            <TooltipTrigger asChild><button type="button"
              ref={(element) => { if (element) itemRefs.current.set(item.id, element); else itemRefs.current.delete(item.id); }}
              aria-label={`跳转到${hasOlder ? "已加载" : ""}第 ${index + 1} 轮：${item.userPreview}`}
              aria-current={selected ? "location" : undefined}
              onPointerEnter={() => setHover(index)} onFocus={() => setHover(index)} onBlur={() => setHover(undefined)}
              onKeyDown={(event) => {
                const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1
                  : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
                if (next === undefined) return;
                event.preventDefault(); itemRefs.current.get(items[Math.max(0, Math.min(items.length - 1, next))].id)?.focus();
              }}
              onClick={() => onJump(item.id)}
              className="flex h-2.5 w-9 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span aria-hidden className={cn("block h-0.5 w-1.5 origin-left rounded-full transition-[transform,opacity] duration-fast motion-reduce:transition-none", selected || distance === 0 ? "bg-foreground" : "bg-muted-foreground")}
                style={{ transform: `scaleX(${scale})`, opacity: selected || distance === 0 ? 1 : distance === 1 ? .86 : distance === 2 || item.running ? .72 : .5 }} />
            </button></TooltipTrigger>
            <TooltipContent side="right" align="center" sideOffset={8} hideWhenDetached className="w-80 max-w-[calc(100vw-2rem)] border border-border bg-popover p-3 font-normal text-popover-foreground shadow-float [&_svg]:!hidden">
              <p className="line-clamp-2 whitespace-pre-line text-body font-medium leading-relaxed">{item.userPreview}</p>
              <p className="mt-2 line-clamp-3 whitespace-pre-line text-body leading-relaxed text-muted-foreground">{item.assistantPreview}</p>
            </TooltipContent>
          </Tooltip>;
        })}
      </div>
    </TooltipProvider>
  </nav>;
}
