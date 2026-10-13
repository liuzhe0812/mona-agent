import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cloudSyncApi, type CloudCleanupPreview, type CloudCleanupResult } from "@/lib/cloud-sync";

function size(bytes: number): string {
  return bytes < 1_000_000 ? `${(bytes / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} KB`
    : `${(bytes / 1_000_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MB`;
}

export function CloudCleanupDialog({ disabled = false, onCleaned }: { disabled?: boolean; onCleaned: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<CloudCleanupPreview | null>(null);
  const [result, setResult] = useState<CloudCleanupResult | null>(null);
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
    running.current = true;
    const current = ++generation.current;
    const controller = new AbortController();
    readAbort.current = controller;
    setBusy(true); setError(""); setResult(null); setPlan(null); setExpired(false);
    try {
      const next = await cloudSyncApi.cleanupPreview(controller.signal);
      if (alive.current && current === generation.current) setPlan(next);
    } catch (cause) {
      if (alive.current && current === generation.current && !(cause instanceof Error && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "暂时无法检查云空间，请稍后重试。");
      }
    } finally {
      running.current = false;
      if (alive.current && current === generation.current) setBusy(false);
    }
  };
  const apply = async () => {
    if (running.current || !plan?.draft_id) return;
    running.current = true;
    const current = generation.current;
    setBusy(true); setError("");
    try {
      const next = await cloudSyncApi.cleanup(plan.draft_id);
      if (!alive.current || current !== generation.current) return;
      setResult(next);
      onCleaned();
    } catch (cause) {
      if (alive.current && current === generation.current) {
        setError(cause instanceof Error ? cause.message : "清理结果尚未确认，请重试核对。");
        const code = cause && typeof cause === "object" && "code" in cause ? cause.code : "";
        if (code === "cleanup_preview_expired" || code === "cloud_cleanup_preview_expired" || code === "account_changed") setExpired(true);
      }
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const close = () => { if (!running.current) { generation.current += 1; setOpen(false); setPlan(null); setResult(null); setError(""); } };

  return <>
    <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => { setOpen(true); void preview(); }}>清理上传残留</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }}>
      <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>清理上传残留</DialogTitle>
          <DialogDescription>仅清理已过保护期、未被任何会话或历史版本使用的上传文件。本地资料、云端会话及历史版本不会删除。</DialogDescription>
        </DialogHeader>
        {busy && <p className="flex items-center gap-2 text-caption text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" />{plan ? "正在清理并核对空间…" : "正在检查可释放空间…"}</p>}
        {!busy && plan && !result && <div className="space-y-2 text-body">
          <p>{plan.count ? `本批可清理 ${plan.count} 个上传残留，最多释放 ${size(plan.bytes)}。` : "暂无可清理的上传残留。"}</p>
          <p className="text-caption text-muted-foreground">新上传文件至少保留 {Math.ceil(plan.minimum_age_seconds / 3600)} 小时。{plan.has_more ? "还有更多残留，完成本批后可继续检查。" : ""}</p>
        </div>}
        {!busy && result && <div className="space-y-2 text-body" role="status">
          <p>{result.released_bytes ? `本次已释放 ${size(result.released_bytes)}。` : result.complete ? "本批清理已核对完成。" : "清理尚未全部完成。"}</p>
          {result.retained > 0 && <p className="text-caption text-muted-foreground">{result.retained} 个文件已被重新使用，已保留。</p>}
          {!result.complete && <p className="text-caption text-muted-foreground">尚有 {result.failed + result.pending} 项等待核对，未确认释放的空间仍计入占用。重试只处理本次确认范围。</p>}
        </div>}
        {error && <p className="text-caption text-destructive" role="alert">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>{result || plan?.count === 0 ? "关闭" : "取消"}</Button>
          {!plan || expired || result?.complete ? <Button variant="outline" disabled={busy} onClick={() => void preview()}>重新检查</Button>
            : plan.count > 0 && <Button variant="destructive" disabled={busy} onClick={() => void apply()}>{result || error ? "重试核对" : "确认清理"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
