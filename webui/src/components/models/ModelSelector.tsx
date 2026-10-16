import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Cpu, LayoutGrid, Loader2, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ApiError } from "@/lib/api";
import { DevelopmentApiError } from "@/lib/development-api";
import { cn } from "@/lib/utils";
import { ProviderMark } from "./ProviderMark";
import { EffortSlider } from "./EffortSlider";
import { PRIMARY_SOURCES, contextLabel, effortLabel, modelEffort, modelKey, orderedSources, sourceId, sourceLabel, useModelPreferences, type ModelOption } from "./model-sources";

function selectionErrorMessage(error: unknown, option: ModelOption, close: boolean): string {
  const changesModelAndEffort = !close && !option.active;
  const actionMessage = changesModelAndEffort
    ? "模型未切换，思考强度未保存。"
    : close ? "" : "思考强度未保存。";
  const apiMessage = error instanceof DevelopmentApiError || error instanceof ApiError
    ? error.message.trim()
    : "";
  if (apiMessage) return actionMessage ? actionMessage + apiMessage : apiMessage;
  if (changesModelAndEffort) return actionMessage + "请稍后重试。";
  return close ? "模型未切换，设置未保存。请稍后重试。" : "思考强度未保存。请稍后重试。";
}

export function ModelSelector({ options, label, disabled, onSelect, onManage, className }: {
  options: ModelOption[]; label?: string | null; disabled?: boolean;
  onSelect: (option: ModelOption, effort?: string | null) => void | Promise<void>;
  onManage?: () => void; currentExecutor?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectionError, setSelectionError] = useState("");
  const [selectionPending, setSelectionPending] = useState(false);
  const selectionPendingRef = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const modelList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const focusModel = (last = false) => {
    const choices = modelList.current?.querySelectorAll<HTMLElement>("[data-model-choice]:not([data-disabled])");
    (last ? choices?.[choices.length - 1] : choices?.[0])?.focus();
  };
  const { hiddenNative, providerOrder } = useModelPreferences();
  const selected = options.find((option) => option.active);
  const selectedEffort = selected ? modelEffort(selected) : null;
  const sources = useMemo(() => orderedSources([...PRIMARY_SOURCES, ...options.map((o) => sourceId(o.provider, o.isBuiltin))], providerOrder), [options, providerOrder]);
  const names = new Map(options.map((o) => [sourceId(o.provider, o.isBuiltin), sourceLabel(sourceId(o.provider, o.isBuiltin), o.providerLabel)]));
  const normalized = query.trim().toLocaleLowerCase();
  const visible = options.filter((option) => {
    const key = modelKey(option);
    if (option.executor && option.executor !== "mona" && hiddenNative.includes(key) && !option.active) return false;
    if (filter !== "all" && sourceId(option.provider, option.isBuiltin) !== filter) return false;
    return !normalized || `${option.providerLabel} ${option.label} ${option.model} ${option.description ?? ""} ${(option.tags ?? []).join(" ")}`.toLocaleLowerCase().includes(normalized);
  });
  const groups = sources.map((id) => ({ id, label: names.get(id) ?? sourceLabel(id), options: visible.filter((o) => sourceId(o.provider, o.isBuiltin) === id) })).filter((g) => g.options.length);
  const choose = async (option: ModelOption, effort = modelEffort(option), close = true): Promise<void> => {
    if (disabled || selectionPendingRef.current || option.disabledReason) return;
    selectionPendingRef.current = true;
    setSelectionPending(true);
    try {
      await onSelect(option, effort);
      if (close) setOpen(false);
    } catch (error) {
      setSelectionError(selectionErrorMessage(error, option, close));
      throw error;
    } finally {
      selectionPendingRef.current = false;
      setSelectionPending(false);
    }
  };
  return <><DropdownMenu open={open} onOpenChange={(value) => { setOpen(value); if (value) setQuery(""); }}>
    <DropdownMenuTrigger asChild><button type="button" disabled={disabled || selectionPending} aria-label={label ?? selected?.model ?? "选择模型"} title={label ?? selected?.model ?? "选择模型"}
      className={cn("inline-flex h-8 min-w-0 max-w-72 items-center gap-2 rounded-full border border-border/70 bg-background px-3 text-caption font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50", className)}>
      {selected && <ProviderMark provider={sourceId(selected.provider, selected.isBuiltin)} label={selected.providerLabel} className="h-4 w-4" />}
      <span className="truncate">{label ?? selected?.model ?? "选择模型"}</span>
      {selectedEffort && <span aria-hidden className="hidden shrink-0 items-center gap-1 text-muted-foreground sm:inline-flex"><Cpu className="h-3 w-3" />{effortLabel(selectedEffort)}</span>}
      {selectionPending ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="正在切换模型" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
    </button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" side="top" sideOffset={8} className="flex w-[350px] max-w-[calc(100vw-48px)] min-w-0 max-h-[min(560px,calc(100vh-120px))] min-h-0 flex-col overflow-hidden rounded-lg p-0">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3.5 py-3">
        <Search className="pointer-events-none h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Input ref={search} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") return;
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusModel(event.key === "ArrowUp"); }
        }}
          placeholder="搜索模型…" aria-label="搜索模型" className="h-5 min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-ui shadow-none focus-visible:ring-0" />
      </div>
      <div className="flex h-[428px] min-h-0">
        <nav role="tablist" aria-label="模型来源分类" aria-orientation="vertical"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            if (event.key === "ArrowRight") { focusModel(); return; }
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")];
            const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next]?.click(); tabs[next]?.focus();
          }} className="scrollbar-thin flex min-h-0 w-12 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-border/70 px-1.5 py-2">
          {[{ id: "all", name: "全部模型", icon: <LayoutGrid className="h-4 w-4" /> },
            ...sources.map((id) => ({ id, name: names.get(id) ?? sourceLabel(id), icon: <ProviderMark provider={id} label={names.get(id)} className="h-3.5 w-3.5" /> }))].map((item) =>
            <button key={item.id} type="button" role="tab" tabIndex={filter === item.id ? 0 : -1} aria-selected={filter === item.id} aria-label={item.name} title={item.name}
              onClick={() => setFilter(item.id)} className={cn("flex h-[38px] w-[34px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", filter === item.id ? "bg-muted" : "hover:bg-muted")}>{item.icon}</button>)}
        </nav>
        <div ref={modelList} className="scrollbar-thin min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-2 pb-3 [scrollbar-gutter:stable]">
          {groups.map((group) => <div key={group.id} role="group" aria-label={group.label}>
            <p className="px-2.5 pb-1 pt-2 !text-micro text-muted-foreground">{group.label}</p>
            {group.options.map((option) => {
              const key = modelKey(option);
              const effort = modelEffort(option);
              return <div key={key} title={option.disabledReason || undefined} className={cn("flex items-center rounded-md [&+div]:mt-1", option.active && "bg-muted/80")}>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-model-choice aria-label={`${option.providerLabel} · ${option.label}`} aria-description={option.disabledReason || undefined} aria-current={option.active ? "true" : undefined} disabled={selectionPending || !!option.disabledReason}
                    className="min-w-0 flex-1 gap-2 rounded-md px-3 py-2 text-body leading-5 [&>svg:last-child]:hidden"
                    onClick={() => { void choose(option).catch(() => undefined); }}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void choose(option).catch(() => undefined); } }}>
                    <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate font-medium">{option.label}</span>
                      {option.promotionLabel && <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 !text-micro text-success">{option.promotionLabel}</span>}
                      {option.priceTier && <span className="shrink-0 text-caption text-muted-foreground">{option.priceTier}</span>}
                      {option.tags?.map((tag) => <span key={tag} className="shrink-0 rounded-full bg-muted px-2 py-0.5 !text-micro font-normal text-muted-foreground">{tag}</span>)}</span>
                    </span>
                    {effort ? <span className="flex shrink-0 items-center gap-1 text-caption text-muted-foreground"><Cpu className="h-3.5 w-3.5" />{effortLabel(effort)}</span>
                      : contextLabel(option.contextWindow) && <span className="shrink-0 text-caption text-muted-foreground">{contextLabel(option.contextWindow)}</span>}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal><DropdownMenuSubContent sideOffset={8} className="scrollbar-thin max-h-[min(70vh,480px)] w-64 overflow-y-auto rounded-xl p-3">
                    <p className="text-ui font-semibold">{option.label}</p>
                    {option.description && <p className="mt-1 text-caption text-muted-foreground">{option.description}</p>}
                    {option.promotionName && <p className="mt-2 text-caption font-medium">{option.promotionName}</p>}
                    {option.discountPercent != null && <p className="mt-1 text-caption text-success">折扣中，较标准价省 {option.discountPercent}%</p>}
                    {option.reasoningEfforts && option.reasoningEfforts.length > 1 ? <div className="mt-2 border-t border-border/70 pt-2"><p className="mb-1 text-caption text-muted-foreground">思考强度</p>
                      <EffortSlider key={`${key}:${option.reasoningEfforts.join(",")}`} stops={option.reasoningEfforts}
                        value={effort} recommended={option.defaultReasoningEffort}
                        labelOf={effortLabel} disabled={disabled || selectionPending || !!option.disabledReason}
                        onChange={(effort) => choose(option, effort, false)} />
                    </div> : null}
                    {(option.inputAmountPerMillion || option.outputAmountPerMillion || option.cachedInputAmountPerMillion) && <div className="mt-3 space-y-1 border-t border-border/70 pt-2 text-caption">
                      <p className="text-muted-foreground">每百万 Token</p>
                      {[["输入", option.inputAmountPerMillion, option.originalInputAmountPerMillion], ["输出", option.outputAmountPerMillion, option.originalOutputAmountPerMillion], ["缓存读取", option.cachedInputAmountPerMillion, option.originalCachedInputAmountPerMillion]].map(([name, amount, original]) => amount ?
                        <p key={name} className="flex justify-between gap-2"><span>{name}</span><span>¥{amount}{original && <span className="ml-1 text-muted-foreground line-through">¥{original}</span>}</span></p> : null)}
                    </div>}
                    <p className="mt-3 border-t border-border/70 pt-2 text-caption text-muted-foreground">来源：{option.providerLabel}{contextLabel(option.contextWindow) ? ` · ${contextLabel(option.contextWindow)} 上下文` : ""}</p>
                  </DropdownMenuSubContent></DropdownMenuPortal>
                </DropdownMenuSub>
              </div>;
            })}
          </div>)}
          {!visible.length && <div className="px-6 py-12 text-center text-caption text-muted-foreground"><p>暂无可选择的模型</p><p className="mt-2">{normalized ? "试试其他名称，或切换来源分类。" : "在模型供应商设置中连接来源并启用模型。"}</p></div>}
        </div>
      </div>
      {onManage && <div className="shrink-0 border-t border-border/70 px-3.5 py-[9px]"><button type="button" onClick={() => { setOpen(false); onManage(); }} className="flex items-center gap-1.5 text-ui text-muted-foreground hover:text-foreground"><Plus className="h-3.5 w-3.5" />添加模型</button></div>}
    </DropdownMenuContent>
  </DropdownMenu>
    <AlertDialog open={!!selectionError} onOpenChange={(value) => { if (!value) setSelectionError(""); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>设置未保存</AlertDialogTitle><AlertDialogDescription>{selectionError}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>知道了</AlertDialogCancel></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
