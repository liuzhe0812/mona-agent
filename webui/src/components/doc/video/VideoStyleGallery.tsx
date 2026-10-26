import { useEffect, useState } from "react";
import { Check, ImageOff, Maximize2, MoreHorizontal, Play, Sparkles } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getServicesHttpBase, type VideoStyleTemplate } from "@/lib/api";
import { cn } from "@/lib/utils";

function StylePreviewCard({ style, base, selected, disabled, onSelect, onExpand, onCreateFrom }: {
  style: VideoStyleTemplate;
  base: string | null;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onExpand: () => void;
  onCreateFrom?: () => void;
}) {
  const [active, setActive] = useState(false);
  const [failed, setFailed] = useState<"motion" | "poster" | null>(null);
  const animate = active && failed !== "motion" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  return (
    <div className="group relative min-w-0" onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}>
      <Button
        type="button" variant="outline" aria-label={`选择${style.name}`} aria-pressed={selected} disabled={disabled}
        onClick={onSelect} onFocus={() => setActive(true)} onBlur={() => setActive(false)}
        className={cn("h-auto w-full flex-col items-stretch gap-0 overflow-hidden p-0 text-left whitespace-normal", selected && "border-foreground/60 ring-1 ring-foreground/30")}
      >
        <span className="relative block aspect-video w-full overflow-hidden bg-muted">
          {base === null ? <span className="block h-full w-full animate-pulse bg-muted" /> : style.preview && failed !== "poster" ? (
            <img
              src={`${base}${animate ? style.preview.motion : style.preview.poster}`} alt={`${style.name}风格样片`}
              loading="lazy" decoding="async" className="h-full w-full object-cover"
              onError={() => { setFailed(animate ? "motion" : "poster"); setActive(false); }}
            />
          ) : <span className="flex h-full items-center justify-center gap-2 text-caption text-muted-foreground"><ImageOff className="h-4 w-4" />预览暂不可用</span>}
          <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-background/90 px-1.5 py-0.5 text-micro text-foreground"><Play className="h-3 w-3" />动态样片</span>
          {selected ? <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-info text-white"><Check className="h-3.5 w-3.5" /></span> : null}
        </span>
        <span className="block px-3 py-2.5">
          <span className="block text-ui font-medium">{style.name}</span>
          <span className="mt-1 block truncate text-caption font-normal text-muted-foreground" title={style.description}>{style.description}</span>
        </span>
      </Button>
      {onCreateFrom ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="icon" className="absolute bottom-2 right-2 h-7 w-7 bg-background/90" aria-label={`管理${style.name}`} disabled={disabled}><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={onCreateFrom}>以此创建</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
      <Button type="button" variant="outline" size="icon" disabled={disabled || failed === "poster"}
        aria-label={`放大预览${style.name}`} title="放大预览" onClick={onExpand}
        className="absolute left-2 top-2 h-7 w-7 bg-background/90 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <Maximize2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function VideoStyleGallery({ templates, selectedId, disabled = false, onSelect, showHeader = true, onCreateFrom }: {
  templates: VideoStyleTemplate[];
  selectedId: string | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
  showHeader?: boolean;
  onCreateFrom?: (style: VideoStyleTemplate) => void;
}) {
  const [base, setBase] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<VideoStyleTemplate | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    let active = true;
    void getServicesHttpBase().then((value) => { if (active) setBase(value); });
    setReducedMotion(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    return () => { active = false; };
  }, []);
  return (
    <section aria-label="视频风格" className="space-y-3">
      {showHeader ? <div className="flex items-center justify-between gap-3">
        <h3 className="text-ui font-medium">选择风格</h3>
        <Button type="button" variant="outline" size="sm" disabled={disabled} aria-pressed={selectedId === "auto"}
          className={cn(selectedId === "auto" && "border-foreground/50 bg-accent")} onClick={() => onSelect("auto")}>
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />由 Mona 推荐{selectedId === "auto" ? <Check className="ml-1.5 h-3.5 w-3.5" /> : null}
        </Button>
      </div> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {templates.map((style) => <StylePreviewCard key={style.id} style={style} base={base} selected={selectedId === style.id} disabled={disabled}
          onSelect={() => onSelect(style.id)} onExpand={() => { setPreviewFailed(false); setExpanded(style); }} onCreateFrom={onCreateFrom ? () => onCreateFrom(style) : undefined} />)}
      </div>
      <Dialog open={expanded !== null} onOpenChange={(open) => { if (!open) setExpanded(null); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>{expanded?.name}</DialogTitle><DialogDescription>{expanded?.description}</DialogDescription></DialogHeader>
          <div className="aspect-video overflow-hidden rounded-md bg-muted">
            {base !== null && expanded?.preview && !previewFailed ? <img src={`${base}${reducedMotion ? expanded.preview.poster : expanded.preview.motion}`} alt={`${expanded.name}动态样片`}
              className="h-full w-full object-contain" onError={() => setPreviewFailed(true)} />
              : <div className="flex h-full items-center justify-center text-caption text-muted-foreground">样片暂时无法显示，请关闭后重试。</div>}
          </div>
          <div className="flex justify-end"><Button type="button" size="sm" disabled={disabled} onClick={() => { if (expanded) onSelect(expanded.id); setExpanded(null); }}>使用这个风格</Button></div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
