import { useCallback, useEffect, useRef, useState } from "react";
import { Download, History, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cloudSyncApi, type CloudCandidate, type CloudConversation, type CloudFile, type CloudHistoryPage, type CloudHistoryVersion } from "@/lib/cloud-sync";

import { CloudTrashDialog } from "./CloudTrashDialog";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作尚未确认，请稍后重试。";
}
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MB`;
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", hour12: false }).format(new Date(value));
}

export function CloudHistoryDialog({ conversations, candidates, onRestored }: {
  conversations: CloudConversation[];
  candidates: CloudCandidate[];
  onRestored: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [resource, setResource] = useState("");
  const [tab, setTab] = useState<"history" | "files">("history");
  const [page, setPage] = useState<CloudHistoryPage | null>(null);
  const [files, setFiles] = useState<CloudFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{ version: CloudHistoryVersion; requestId: string } | null>(null);
  const [restored, setRestored] = useState(false);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const mutation = useRef(false);
  const known = conversations.filter((item) => item.version > 0 && !item.trashed);
  const selectedConversation = known.find((item) => item.resource_id === resource);
  const titles = new Map(candidates.map((item) => [item.key, item.title]));

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current += 1; abort.current?.abort(); };
  }, []);

  const read = useCallback(async (selected: string, section: "history" | "files", before?: number) => {
    const current = ++generation.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true); setError("");
    try {
      if (section === "history") {
        const next = await cloudSyncApi.history(selected, before, controller.signal);
        if (alive.current && current === generation.current) {
          setPage((existing) => before && existing ? { ...next, items: [...existing.items, ...next.items] } : next);
        }
      } else {
        const next = await cloudSyncApi.files(selected, controller.signal);
        if (alive.current && current === generation.current) setFiles(next);
      }
    } catch (cause) {
      if (alive.current && current === generation.current && !(cause instanceof Error && cause.name === "AbortError")) setError(errorMessage(cause));
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !resource) return;
    setPage(null); setFiles(null); setConfirmation(null); setRestored(false);
    void read(resource, tab);
    return () => { generation.current += 1; abort.current?.abort(); };
  }, [open, resource, tab, read]);

  const close = () => {
    if (mutation.current) return;
    generation.current += 1; abort.current?.abort();
    setOpen(false); setConfirmation(null); setPage(null); setFiles(null); setError(""); setRestored(false);
  };
  const run = async (action: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  const download = (file: CloudFile) => run(async () => {
    await cloudSyncApi.download(resource, file.id);
    if (!alive.current) return;
    setFiles((current) => current?.map((item) => item.id === file.id ? { ...item, local: true } : item) ?? null);
  });
  const restore = () => {
    const selected = confirmation;
    if (!selected) return;
    void run(async () => {
      await cloudSyncApi.restore(resource, selected.version.version, selected.requestId);
      if (!alive.current) return;
      setConfirmation(null); setRestored(true); onRestored();
    });
  };

  return <>
    <Button size="sm" variant="outline" disabled={!known.length} onClick={() => {
      setResource(known[0].resource_id); setTab("history"); setOpen(true);
    }}><History className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />会话与历史</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{confirmation ? `恢复版本 ${confirmation.version.version}？` : "云会话与历史"}</DialogTitle>
          <DialogDescription>{confirmation ? "将恢复为一个新的本地会话，当前会话不会被覆盖，也不会重新执行历史任务。" : "文件可按需下载；历史版本恢复为新会话，不覆盖当前内容。"}</DialogDescription>
        </DialogHeader>
        {!confirmation && <>
          <Select value={resource} disabled={busy} onValueChange={setResource} aria-label="选择云会话"
            options={known.map((item) => ({ value: item.resource_id,
              label: `${titles.get(item.key) || "未命名会话"}${item.conflict_copy ? " · 同步分支" : ""}` }))} />
          <Tabs value={tab} onValueChange={(value) => setTab(value as "history" | "files")}>
            <TabsList><TabsTrigger value="history" disabled={busy}>历史版本</TabsTrigger><TabsTrigger value="files" disabled={busy}>关联文件</TabsTrigger></TabsList>
          </Tabs>
          <div className="max-h-72 overflow-y-auto" aria-busy={loading}>
            {loading && <p role="status" className="flex items-center gap-2 py-4 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取…</p>}
            {tab === "history" && page && <ul aria-label="会话历史版本" className="divide-y divide-border/50">
              {page.items.map((item) => <li key={item.version} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0"><p className="text-body">版本 {item.version}{item.deleted ? " · 已删除记录" : ""}</p><time dateTime={item.created_at} className="text-caption text-muted-foreground">{formatTime(item.created_at)}</time></div>
                <Button size="sm" variant="ghost" disabled={busy || loading || item.deleted} aria-label={`恢复版本 ${item.version}`} onClick={() => {
                  setError(""); setRestored(false); setConfirmation({ version: item, requestId: crypto.randomUUID().replaceAll("-", "") });
                }}><RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />恢复</Button>
              </li>)}
              {!page.items.length && !loading && <li className="py-4 text-caption text-muted-foreground">暂无历史版本</li>}
            </ul>}
            {tab === "files" && files && <ul aria-label="云会话文件" className="divide-y divide-border/50">
              {files.map((file) => <li key={file.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1"><p className="truncate text-body" title={file.name}>{file.name}</p><p className="text-caption text-muted-foreground">{formatSize(file.size)} · {file.local ? "已在本机" : "仅在云端"}</p></div>
                {!file.local && <Button size="sm" variant="ghost" disabled={busy || loading} aria-label={`下载 ${file.name}`} onClick={() => void download(file)}><Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />下载</Button>}
              </li>)}
              {!files.length && !loading && <li className="py-4 text-caption text-muted-foreground">此会话没有关联文件</li>}
            </ul>}
          </div>
          {tab === "history" && page?.has_more && <Button variant="ghost" disabled={loading || busy} onClick={() => void read(resource, tab, page.next_before)}>更早版本</Button>}
          {restored && <p role="status" className="text-caption">已恢复为新会话，可在会话列表中查看。</p>}
        </>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <DialogFooter>
          {confirmation ? <>
            <Button variant="outline" disabled={busy} onClick={() => { setConfirmation(null); setError(""); }}>取消</Button>
            <Button disabled={busy} onClick={restore}>{busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}{busy ? "恢复中…" : "确认恢复"}</Button>
          </> : <>
            {error && <Button variant="outline" disabled={busy || loading} onClick={() => void read(resource, tab)}>重新读取</Button>}
            {selectedConversation && <CloudTrashDialog disabled={busy || loading} onChanged={onRestored} target={{ resource_id: resource,
              version: selectedConversation.version, title: titles.get(selectedConversation.key) || "未命名会话" }} />}
            <Button variant="outline" disabled={busy} onClick={close}>关闭</Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
