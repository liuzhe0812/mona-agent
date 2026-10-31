import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipButton } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cloudSyncApi, type CloudCleanupPreview, type CloudCleanupResult, type CloudRetentionPreview, type CloudRetentionResult } from "@/lib/cloud-sync";

type CleanupPlan = { history: CloudRetentionPreview; files: CloudCleanupPreview };
type CleanupResult = { history?: CloudRetentionResult; files?: CloudCleanupResult };

function size(bytes: number): string {
  return bytes < 1_000_000 ? `${(bytes / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} KB`
    : `${(bytes / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MB`;
}

export function CloudCleanupDialog({ disabled = false, onCleaned }: { disabled?: boolean; onCleaned: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const running = useRef(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current += 1; readAbort.current?.abort(); };
  }, []);

  const preview = async () => {
    if (running.current) return;
    const current = ++generation.current;
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    setBusy(true); setError(""); setResult(null); setPlan(null); setExpired(false);
    try {
      const [history, files] = await Promise.all([
        cloudSyncApi.retentionPreview(controller.signal), cloudSyncApi.cleanupPreview(controller.signal),
      ]);
      if (alive.current && current === generation.current) setPlan({ history, files });
    } catch (cause) {
      if (alive.current && current === generation.current && !(cause instanceof Error && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "暂时无法检查云空间，请稍后重试。");
      }
    } finally {
      if (alive.current && current === generation.current) setBusy(false);
    }
  };
  const apply = async () => {
    if (running.current || !plan || !plan.history.draft_id && !plan.files.draft_id) return;
    running.current = true;
    setBusy(true); setError("");
    const next = { ...result };
    let changed = false;
    try {
      if (plan.history.draft_id && !next.history) {
        next.history = await cloudSyncApi.retireHistory(plan.history.draft_id);
        changed = true;
        if (!alive.current) return;
        setResult({ ...next });
      }
      if (plan.files.draft_id && !next.files?.complete) {
        next.files = await cloudSyncApi.cleanup(plan.files.draft_id);
        changed = true;
        if (!alive.current) return;
        setResult({ ...next });
      }
    } catch (cause) {
      if (alive.current) {
        setError(cause instanceof Error ? cause.message : "清理结果尚未确认，请重试核对。");
        const code = cause && typeof cause === "object" && "code" in cause ? cause.code : "";
        if (["cleanup_preview_expired", "cloud_cleanup_preview_expired", "retention_preview_expired",
          "cloud_retention_preview_expired", "account_changed"].includes(String(code))) setExpired(true);
      }
    } finally {
      running.current = false;
      if (alive.current) { setBusy(false); if (changed) onCleaned(); }
    }
  };
  const close = () => { if (!running.current) { generation.current += 1; readAbort.current?.abort(); setOpen(false); setBusy(false); setPlan(null); setResult(null); setError(""); } };
  const empty = !!plan && !plan.history.draft_id && !plan.files.draft_id;
  const complete = !!plan && !!result && (!plan.history.draft_id || !!result.history)
    && (!plan.files.draft_id || result.files?.complete === true);
  const retired = (result?.history?.retired ?? 0) + (result?.history?.already_retired ?? 0);

  return <>
    <TooltipButton size="xs" variant="ghost" title="检查过期旧版本和可释放空间，确认后清理" aria-label="清理空间" disabled={disabled || busy} onClick={() => { setOpen(true); void preview(); }}>清理空间</TooltipButton>
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }}>
      <DialogContent className="relative max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md" showCloseButton={!running.current}>
        <DialogHeader>
          <DialogTitle>清理空间</DialogTitle>
          <DialogDescription>清理过期旧版本和可回收空间，保留最新内容、回收站及本机资料。清理后的旧版本无法恢复。</DialogDescription>
        </DialogHeader>
        {busy && <p className="flex items-center gap-2 text-caption text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" />{plan ? "正在清理云空间…" : "正在检查可清理内容…"}</p>}
        {!busy && plan && !result && <div className="space-y-2 text-body">
          <p>{empty ? "暂无可清理内容。" : `本次清理 ${plan.history.count} 个过期旧版本，预计最多释放 ${size(plan.files.bytes)}。`}</p>
          <p className="text-caption text-muted-foreground">保留最近 {plan.history.retention_days} 天的历史，最新内容始终保留。</p>
          {(plan.history.has_more || plan.files.has_more) && <p className="text-caption text-muted-foreground">还有更多可清理内容，本次只处理上述范围。</p>}
        </div>}
        {!busy && result && <div className="space-y-2 text-body" role="status">
          <p>已清理 {retired} 个旧版本{plan?.files.draft_id && !result.files ? "；空间清理结果尚未确认。" : `，已释放 ${size(result.files?.released_bytes ?? 0)}。`}</p>
          {((result.history?.retained ?? 0) > 0 || (result.files?.retained ?? 0) > 0) && <p className="text-caption text-muted-foreground">部分内容因状态变化已保留。</p>}
          {!complete && <p className="text-caption text-muted-foreground">清理尚未全部完成，可重试核对本次已确认的范围。</p>}
        </div>}
        {error && <p className="text-caption text-destructive" role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={running.current} onClick={close}>{result || empty ? "关闭" : "取消"}</Button>
          {!plan || expired || complete || empty ? <Button variant="outline" disabled={busy} onClick={() => void preview()}>重新检查</Button>
            : <Button variant="destructive" disabled={busy} onClick={() => void apply()}>{busy ? "清理中…" : result || error ? "重试清理" : "确认清理"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
