import { useEffect, useState } from "react";
import { Check, Maximize2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { fetchVideoStyleVersions, getServicesHttpBase, previewVideoStyle, type VideoSeries } from "@/lib/api";
import { fetchVideoStyleSample } from "@/lib/video-style-api";
import { httpFetch } from "@/lib/tauri";
import { cn } from "@/lib/utils";

function SavedStyleCard({ token, item, selected, disabled, visible, onSelect, onEdit, onCopy, onRename, onDelete }: {
  token: string; item: VideoSeries; selected: boolean; disabled?: boolean; visible: boolean;
  onSelect: () => void; onEdit: () => void; onCopy: () => void; onRename: () => void; onDelete: () => void;
}) {
  const [poster, setPoster] = useState<string>();
  const [legacyHtml, setLegacyHtml] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [failure, setFailure] = useState(false);
  const [active, setActive] = useState(false);
  const [motion, setMotion] = useState<string>();
  useEffect(() => {
    if (!visible) {
      setExpanded(false);
      setPoster(undefined);
      setLegacyHtml(undefined);
      setPreview(undefined);
    }
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    let url: string | undefined;
    setPoster(undefined); setLegacyHtml(undefined); setFailure(false);
    void (async () => {
      if (item.styleSummary?.preview) {
        const base = await getServicesHttpBase();
        const response = await httpFetch(`${base}${item.styleSummary.preview.poster}`, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
        if (!response.ok) throw new Error("preview unavailable");
        const blob = await response.blob();
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setPoster(url);
      } else {
        const versions = await fetchVideoStyleVersions(token, item.id);
        if (abort.signal.aborted) return;
        const style = versions.styles.find((v) => v.version === item.latestStyleVersion);
        if (!style) throw new Error("style unavailable");
        const result = await previewVideoStyle(token, item.id, style, "cover", "16:9");
        if (!abort.signal.aborted) setLegacyHtml(result.html);
      }
    })().catch(() => { if (!abort.signal.aborted) setFailure(true); });
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [item.id, item.latestStyleVersion, item.styleSummary?.preview?.poster, token, visible]);
  useEffect(() => {
    if (!visible || !active || !item.styleSummary?.preview?.motion || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const abort = new AbortController();
    let url: string | undefined;
    void (async () => {
      const base = await getServicesHttpBase();
      const response = await httpFetch(`${base}${item.styleSummary!.preview!.motion}`, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
      if (!response.ok) return;
      const blob = await response.blob();
      if (abort.signal.aborted) return;
      url = URL.createObjectURL(blob); setMotion(url);
    })().catch(() => {});
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); setMotion(undefined); };
  }, [active, item.styleSummary?.preview?.motion, token, visible]);
  useEffect(() => {
    if (!visible || !expanded) return;
    const abort = new AbortController();
    setPreview(undefined); setFailure(false);
    if (!item.styleSummary?.preview) { setPreview(legacyHtml); return; }
    void fetchVideoStyleSample(token, item.id, { version: item.latestStyleVersion ?? undefined, signal: abort.signal })
      .then((result) => { if (!abort.signal.aborted) setPreview(result.html); })
      .catch(() => { if (!abort.signal.aborted) setFailure(true); });
    return () => abort.abort();
  }, [expanded, item.id, item.latestStyleVersion, item.styleSummary?.preview, legacyHtml, token, visible]);
  return <div className="group relative min-w-0" onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}>
    <Button type="button" variant="outline" disabled={disabled} aria-label={`选择${item.name}`} aria-pressed={selected} onClick={onSelect}
      onFocus={() => setActive(true)} onBlur={() => setActive(false)} className={cn("h-auto w-full flex-col items-stretch gap-0 overflow-hidden p-0 text-left whitespace-normal", selected && "border-foreground/60 ring-1 ring-foreground/30")}>
      <span className="relative block aspect-video w-full overflow-hidden bg-muted">
        {poster ? <img src={active && motion ? motion : poster} alt={`${item.name}风格样片`} className="h-full w-full object-contain" /> : legacyHtml ? visible && <iframe srcDoc={legacyHtml} title={`${item.name}样式预览`} sandbox="allow-scripts" tabIndex={-1} className="pointer-events-none h-full w-full border-0" /> : <span className="flex h-full items-center justify-center text-caption text-muted-foreground">{failure ? "预览暂不可用" : "正在准备预览…"}</span>}
        {selected ? <span className="absolute right-2 top-2 rounded-full bg-info p-1 text-white"><Check className="h-3 w-3" /></span> : null}
      </span>
      <span className="block truncate px-3 py-2 text-ui font-medium">{item.name}</span>
    </Button>
    <div className="absolute left-2 top-2 flex gap-1">
      <Button variant="outline" size="icon" className="h-7 w-7 bg-background/90" aria-label={`预览${item.name}`} onClick={() => setExpanded(true)}><Maximize2 className="h-3.5 w-3.5" /></Button>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="icon" className="h-7 w-7 bg-background/90" aria-label={`管理${item.name}`}><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={onEdit}>编辑</DropdownMenuItem><DropdownMenuItem onSelect={onCopy}>复制</DropdownMenuItem><DropdownMenuItem onSelect={onRename}>重命名</DropdownMenuItem><DropdownMenuItem onSelect={onDelete}>删除</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
    </div>
    <Dialog open={visible && expanded} onOpenChange={setExpanded}><DialogContent className="max-w-4xl"><DialogHeader><DialogTitle>{item.name}</DialogTitle><DialogDescription>查看风格样片。</DialogDescription></DialogHeader>
      <div className="aspect-video overflow-hidden bg-muted">{visible && (preview ? <iframe title={`${item.name}完整样片`} srcDoc={preview} sandbox="allow-scripts" className="h-full w-full border-0" /> : <p className="p-4 text-caption text-muted-foreground">{failure ? "样片未能打开，请关闭后重试。" : "正在准备样片…"}</p>)}</div>
      <div className="flex justify-end"><Button size="sm" onClick={() => { onSelect(); setExpanded(false); }}>使用这个风格</Button></div>
    </DialogContent></Dialog>
  </div>;
}

export function SavedVideoStyleGallery({ token, series, selectedId, loading, disabled, visible = true, onSelect, onEdit, onCopy, onRename, onDelete, onCreate }: {
  token: string; series: VideoSeries[]; selectedId: string | null; loading?: boolean; disabled?: boolean; visible?: boolean;
  onSelect: (item: VideoSeries) => void; onEdit: (item: VideoSeries) => void; onCopy: (item: VideoSeries) => void; onRename: (item: VideoSeries) => void; onDelete: (item: VideoSeries) => void; onCreate: () => void;
}) {
  const saved = series.filter((item) => (item.latestStyleVersion ?? 0) > 0 && !item.archivedAt);
  const drafts = series.filter((item) => !(item.latestStyleVersion ?? 0) && !item.archivedAt);
  return <div className="space-y-3" aria-label="我的风格">
    {loading ? <p className="text-caption text-muted-foreground">正在读取风格…</p> : saved.length ? <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{saved.map((item) => <SavedStyleCard key={item.id} token={token} item={item} selected={item.id === selectedId} disabled={disabled} visible={visible} onSelect={() => onSelect(item)} onEdit={() => onEdit(item)} onCopy={() => onCopy(item)} onRename={() => onRename(item)} onDelete={() => onDelete(item)} />)}</div> : <div className="flex items-center gap-3 py-4 text-caption text-muted-foreground">还没有自己的风格。<Button variant="outline" size="sm" onClick={onCreate}>创建风格</Button></div>}
    {drafts.length ? <details><summary className="cursor-pointer text-caption text-muted-foreground">未完成（{drafts.length}）</summary><div className="mt-2 space-y-1">{drafts.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 border-b border-border/50 py-2 text-caption"><span className="truncate">{item.name}</span><div className="flex gap-1"><Button variant="ghost" size="xs" onClick={() => onEdit(item)}>继续编辑</Button><Button variant="ghost" size="xs" onClick={() => onDelete(item)}>删除</Button></div></div>)}</div></details> : null}
  </div>;
}
