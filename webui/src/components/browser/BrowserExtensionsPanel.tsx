import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { browserInstallExtension, browserListExtensions, browserRemoveExtension, browserSetExtensionEnabled, type BrowserExtension } from "@/lib/browser-ipc";

type Confirmation = { kind: "install"; path: string } | { kind: "remove"; extension: BrowserExtension };
type RetryAction =
  | { kind: "load" }
  | { kind: "choose" }
  | { kind: "install"; path: string }
  | { kind: "toggle"; extensionId: string; name: string; enabled: boolean }
  | { kind: "remove"; extensionId: string; name: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function BrowserExtensionsPanel({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const [extensions, setExtensions] = useState<BrowserExtension[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState("");
  const [retryAction, setRetryAction] = useState<RetryAction | null>(null);
  const loadRequest = useRef(0);

  const fail = (label: string, cause: unknown, retry: RetryAction) => {
    setError(`${label}：${errorText(cause)}`);
    setRetryAction(retry);
  };

  const loadExtensions = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    try {
      const rows = await browserListExtensions(tabId);
      if (loadRequest.current !== request) return;
      setExtensions(rows);
      setHasLoaded(true);
      setError("");
      setRetryAction(null);
    } catch (cause) {
      if (loadRequest.current === request) fail("读取扩展列表失败", cause, { kind: "load" });
    } finally {
      if (loadRequest.current === request) setLoading(false);
    }
  }, [tabId]);

  useEffect(() => {
    setExtensions([]);
    setHasLoaded(false);
    setError("");
    setRetryAction(null);
    void loadExtensions();
    return () => { loadRequest.current += 1; };
  }, [loadExtensions]);

  const chooseDirectory = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false, title: "选择扩展目录" });
      if (typeof selected !== "string" || !selected) return;
      setError("");
      setRetryAction(null);
      setConfirmation({ kind: "install", path: selected });
    } catch (cause) {
      fail("选择扩展目录失败", cause, { kind: "choose" });
    }
  };

  const install = async (path: string) => {
    setBusy(true);
    setError("");
    setRetryAction(null);
    try {
      await browserInstallExtension(tabId, path);
      setConfirmation(null);
      await loadExtensions();
    } catch (cause) {
      setConfirmation(null);
      fail("加载扩展失败", cause, { kind: "install", path });
    } finally { setBusy(false); }
  };

  const toggle = async (extension: BrowserExtension, enabled: boolean) => {
    setBusy(true);
    setError("");
    setRetryAction(null);
    try {
      await browserSetExtensionEnabled(tabId, extension.id, enabled);
      setExtensions((current) => current.map((item) => item.id === extension.id ? { ...item, enabled } : item));
    } catch (cause) {
      fail(`切换扩展“${extension.name}”状态失败`, cause, { kind: "toggle", extensionId: extension.id, name: extension.name, enabled });
    } finally { setBusy(false); }
  };

  const remove = async (extension: BrowserExtension) => {
    setBusy(true);
    setError("");
    setRetryAction(null);
    try {
      await browserRemoveExtension(tabId, extension.id);
      setExtensions((current) => current.filter((item) => item.id !== extension.id));
      setConfirmation(null);
    } catch (cause) {
      setConfirmation(null);
      fail(`删除扩展“${extension.name}”失败`, cause, { kind: "remove", extensionId: extension.id, name: extension.name });
    } finally { setBusy(false); }
  };

  const confirm = () => {
    if (!confirmation) return;
    if (confirmation.kind === "install") void install(confirmation.path);
    else void remove(confirmation.extension);
  };

  const retry = () => {
    if (!retryAction || busy) return;
    const action = retryAction;
    setError("");
    setRetryAction(null);
    if (action.kind === "load") void loadExtensions();
    else if (action.kind === "choose") void chooseDirectory();
    else if (action.kind === "install") void install(action.path);
    else if (action.kind === "toggle") void toggle({ id: action.extensionId, name: action.name, enabled: !action.enabled }, action.enabled);
    else void remove({ id: action.extensionId, name: action.name, enabled: false });
  };

  return <section className="flex h-full min-h-0 flex-col bg-background" aria-label="浏览器扩展程序">
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 px-3">
      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="返回" onClick={onClose}><ArrowLeft className="h-4 w-4" /></Button>
      <h2 className="min-w-0 flex-1 truncate text-ui font-medium">扩展程序</h2>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {error && <div role="alert" className="mb-3 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/[0.04] p-3 text-caption text-destructive">
        <p className="min-w-0 flex-1 break-words">{error}</p>
        {retryAction && <Button variant="outline" size="sm" className="shrink-0" disabled={busy || loading} onClick={retry}>重试</Button>}
      </div>}
      {loading && !hasLoaded ? <p role="status" className="py-8 text-center text-caption text-muted-foreground">正在读取扩展…</p>
        : hasLoaded && extensions.length === 0 ? <div className="flex flex-col items-center gap-3 py-12 text-center">
          <p className="text-ui text-muted-foreground">暂无扩展</p>
          <Button disabled={busy || loading} onClick={() => void chooseDirectory()}><Plus className="mr-2 h-4 w-4" />加载扩展</Button>
        </div> : hasLoaded && <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-caption font-medium text-muted-foreground">已安装扩展</h3>
            <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => void chooseDirectory()}><Plus className="mr-2 h-3.5 w-3.5" />加载扩展</Button>
          </div>
          <ul className="divide-y divide-border rounded-md border border-border/60">
            {extensions.map((extension) => <li key={extension.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-ui" title={extension.name}>{extension.name}</span>
              <Switch aria-label={`启用扩展 ${extension.name}`} checked={extension.enabled} disabled={busy} onCheckedChange={(enabled) => void toggle(extension, enabled)} />
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label={`删除扩展 ${extension.name}`} disabled={busy} onClick={() => setConfirmation({ kind: "remove", extension })}><Trash2 className="h-4 w-4" /></Button>
            </li>)}
          </ul>
        </div>}
    </div>
    <AlertDialog open={!!confirmation} onOpenChange={(open) => { if (!open && !busy) setConfirmation(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.kind === "install" ? "确认加载扩展" : `删除扩展“${confirmation?.kind === "remove" ? confirmation.extension.name : ""}”？`}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation?.kind === "install" ? "此扩展可以读取和修改网页内容。" : "确定从此浏览器中删除此扩展吗？"}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); confirm(); }}>{busy ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" /> : null}{confirmation?.kind === "install" ? "确认加载" : "删除"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
