import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipButton } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cloudSyncApi, type CloudTrashAction, type CloudTrashDraft, type CloudTrashItem, type CloudTrashPage } from "@/lib/cloud-sync";

type Target = { resource_id: string; version: number; title: string };
const kinds = { work_conversation: "工作会话", note: "笔记", todo: "待办", calendar_event: "日程" };
const names = { trash: "移至云回收站", restore: "恢复", purge: "彻底删除" };
const descriptions = {
  trash: "仅移动云端副本，暂停该会话的云端更新；本地会话、文件和运行任务保持不变。",
  restore: "恢复到云空间。已开启对应内容同步的设备会接收更新，不自动执行历史任务。",
  purge: "移除这项云记录及其全部可恢复历史，此操作不可撤销。本地副本不删除；无其他引用的文件可通过“清理上传残留”释放空间。",
};
function errorText(error: unknown) { return error instanceof Error ? error.message : "操作尚未确认，请稍后重试。"; }

export function CloudTrashDialog({ disabled, target, onChanged }: { disabled?: boolean; target?: Target; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<CloudTrashPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<(Target & { action: CloudTrashAction }) | null>(null);
  const [draft, setDraft] = useState<CloudTrashDraft | null>(null);
  const [done, setDone] = useState<CloudTrashAction | null>(null);
  const alive = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current += 1; abort.current?.abort(); };
  }, []);

  const read = async (before?: number) => {
    const revision = ++generation.current;
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    setLoading(true); setError("");
    try {
      const next = await cloudSyncApi.trash(before, controller.signal);
      if (alive.current && revision === generation.current) setPage((old) => before && old ? { ...next, items: [...old.items, ...next.items] } : next);
    } catch (cause) {
      if (alive.current && revision === generation.current && !(cause instanceof Error && cause.name === "AbortError")) setError(errorText(cause));
    } finally { if (alive.current && revision === generation.current) setLoading(false); }
  };
  const select = async (item: Target, action: CloudTrashAction) => {
    const revision = ++generation.current;
    abort.current?.abort();
    setSelection({ ...item, action }); setDraft(null); setError(""); setDone(null); setLoading(true);
    try {
      const value = await cloudSyncApi.previewTrash(item.resource_id, item.version, action);
      if (alive.current && revision === generation.current) setDraft(value);
    } catch (cause) { if (alive.current && revision === generation.current) setError(errorText(cause)); }
    finally { if (alive.current && revision === generation.current) setLoading(false); }
  };
  const close = () => {
    if (writing.current) return;
    generation.current += 1; abort.current?.abort(); setOpen(false); setPage(null); setSelection(null); setDraft(null); setError(""); setDone(null);
  };
  const confirm = async () => {
    if (!draft || writing.current) return;
    writing.current = true; setBusy(true); setError("");
    try {
      const result = await cloudSyncApi.applyTrash(draft);
      if (!alive.current) return;
      setDone(result.action); setSelection(null); setDraft(null);
      setPage((current) => current ? { ...current, items: current.items.filter((item) => item.resource_id !== result.resource_id) } : null);
      onChanged();
    } catch (cause) {
      if (alive.current) {
        setError(errorText(cause));
        if (cause instanceof Error && "code" in cause && ["account_changed", "trash_preview_expired", "cloud_trash_preview_expired", "cloud_trash_changed"].includes(String(cause.code))) setDraft(null);
      }
    } finally { writing.current = false; if (alive.current) setBusy(false); }
  };
  const begin = () => {
    setOpen(true); setDone(null); setSelection(null); setError("");
    if (target) void select(target, "trash"); else void read();
  };
  return <>
    <TooltipButton size={target ? "sm" : "xs"} variant="ghost" title={target ? "将云端副本移至回收站，保留本地资料" : "找回或管理已删除的云内容"} aria-label={target ? "移至云回收站" : "回收站"} disabled={disabled} onClick={begin}>
      <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{target ? "移至云回收站" : "回收站"}
    </TooltipButton>
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!busy}>
        <DialogHeader><DialogTitle>{selection ? `${names[selection.action]}？` : "云回收站"}</DialogTitle>
          <DialogDescription>{selection ? descriptions[selection.action] : "查看和恢复已删除的云记录。不会自动清空，也不删除本机已有副本。"}</DialogDescription></DialogHeader>
        {selection && <p className="break-words text-body font-medium">{selection.title}</p>}
        {loading && <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取…</p>}
        {!selection && !target && page && <ul aria-label="云回收站记录" className="max-h-72 divide-y divide-border/50 overflow-y-auto">
          {page.items.map((item: CloudTrashItem) => <li key={item.resource_id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1"><p className="truncate text-body" title={item.title}>{item.title}</p>
              <p className="text-caption text-muted-foreground">{kinds[item.kind]} · {new Date(item.deleted_at).toLocaleString("zh-CN")}</p></div>
            <Button size="sm" variant="ghost" disabled={busy || loading || !item.recoverable} aria-label={`恢复 ${item.title}`} onClick={() => void select(item, "restore")}><RotateCcw className="mr-1 h-3.5 w-3.5" />恢复</Button>
            <Button size="sm" variant="ghost" className="text-destructive" disabled={busy || loading} aria-label={`彻底删除 ${item.title}`} onClick={() => void select(item, "purge")}>彻底删除</Button>
          </li>)}
          {!page.items.length && !loading && <li className="py-4 text-caption text-muted-foreground">回收站为空</li>}
        </ul>}
        {!selection && !target && page?.has_more && <Button variant="ghost" disabled={busy || loading} onClick={() => void read(page.next_before)}>更早记录</Button>}
        {done && <p role="status" className="text-caption">{done === "restore" ? "已恢复到云空间，开启对应同步后可在原模块查看。" : done === "trash" ? "已移至云回收站，本地资料仍保留。" : "已彻底移除云恢复记录。可清理上传残留以释放无引用文件占用。"}</p>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <DialogFooter>
          {selection ? <>
            <Button variant="outline" disabled={busy} onClick={() => { if (target) close(); else { generation.current += 1; setSelection(null); setDraft(null); setError(""); setLoading(false); } }}>取消</Button>
            {error && !draft && <Button variant="outline" disabled={busy || loading} onClick={() => void select(selection, selection.action)}>重新核对</Button>}
            <Button variant={selection.action === "purge" ? "destructive" : "outline"} disabled={busy || loading || !draft} onClick={() => void confirm()}>{busy ? "处理中…" : `确认${names[selection.action]}`}</Button>
          </> : <>
            {!target && <Button variant="outline" disabled={busy || loading} onClick={() => void read()}>刷新回收站</Button>}
            <Button variant="outline" disabled={busy} onClick={close}>关闭</Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
