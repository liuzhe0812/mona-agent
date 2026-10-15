import { useEffect, useRef, useState } from "react";
import { History, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipButton } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cloudSyncApi, type CloudRetentionPreview, type CloudRetentionResult } from "@/lib/cloud-sync";

export function CloudHistoryRetentionDialog({ disabled, onChanged }: { disabled?: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CloudRetentionPreview | null>(null);
  const [result, setResult] = useState<CloudRetentionResult | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(false);
  const mutation = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; abort.current?.abort(); };
  }, []);
  const read = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const current = ++generation.current;
    setLoading(true); setPreview(null); setResult(null); setError("");
    try {
      const data = await cloudSyncApi.retentionPreview(controller.signal);
      if (alive.current && current === generation.current) setPreview(data);
    } catch (cause) {
      if (alive.current && current === generation.current && !(cause instanceof Error && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "历史检查未完成，请重试。");
      }
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  };
  const close = () => {
    if (mutation.current) return;
    generation.current++; abort.current?.abort(); setOpen(false); setPreview(null); setResult(null); setError("");
  };
  const confirm = async () => {
    if (mutation.current || !preview?.draft_id) return;
    mutation.current = true; setBusy(true); setError("");
    try {
      const value = await cloudSyncApi.retireHistory(preview.draft_id);
      if (!alive.current) return;
      setResult(value); onChanged();
    } catch (cause) {
      if (alive.current) {
        setError(cause instanceof Error ? cause.message : "清理结果尚未确认，请重试核对。");
        if (cause && typeof cause === "object" && "code" in cause && ["account_changed", "retention_preview_expired", "cloud_retention_preview_expired"].includes(String(cause.code))) setPreview(null);
      }
    } finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  return <>
    <TooltipButton size="xs" variant="ghost" title="清理过期旧版本，保留最新内容" aria-label="清理过期历史" disabled={disabled} onClick={() => { setOpen(true); void read(); }}><History className="mr-1.5 h-3.5 w-3.5" />清理过期历史</TooltipButton>
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader><DialogTitle>清理过期历史</DialogTitle>
          <DialogDescription>仅清理保留期外的旧版本，最新内容、已删除资料的历史和本地文件保持不变。此操作不能撤销。</DialogDescription>
        </DialogHeader>
        {loading && <p role="status" className="flex items-center gap-2 text-caption"><Loader2 className="h-4 w-4 animate-spin" />正在检查历史版本…</p>}
        {preview && !result && <div className="space-y-2 text-body">
          <p>保留最近 {preview.retention_days} 天的历史，最新版本不受时间限制。</p>
          <p>{preview.count ? `本批将清理 ${preview.count} 个旧版本。` : "暂无可清理的过期历史。"}</p>
          {preview.has_more && <p className="text-caption text-muted-foreground">还有更早版本，本次不会自动继续下一批。</p>}
          <p className="text-caption text-muted-foreground">历史清理后，可通过“清理上传残留”回收不再使用的云文件；文件实际删除后才释放空间。</p>
        </div>}
        {result && <p role="status" className="text-body">已清理 {result.retired + result.already_retired} 个旧版本，保留 {result.retained} 个状态已变化的版本。本地数据未修改。</p>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>{result ? "关闭" : "取消"}</Button>
          {!loading && (result || !preview) && <Button variant="outline" disabled={busy} onClick={() => void read()}>重新检查</Button>}
          {!result && !!preview?.draft_id && <Button variant="destructive" disabled={busy || loading} onClick={() => void confirm()}>{busy ? "清理中…" : "确认清理旧版本"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
