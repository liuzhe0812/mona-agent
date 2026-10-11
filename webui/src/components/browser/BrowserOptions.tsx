import { useEffect, useState } from "react";
import { ArrowLeft, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { browserClearHistory, browserGetZoom, browserOpenDevtools, browserPageAction, browserPrintPage, browserSetZoom } from "@/lib/browser-ipc";
import { isTauri } from "@/lib/tauri";
import type { Tab } from "@/hooks/useBrowserTabs";

export type BrowserUtility = "extensions" | "history" | "downloads" | "settings";

export function BrowserOptionsButton({ tab, deviceActive, onFind, onDevice, onOpen, onError }: {
  tab: Tab | null; onFind: () => void; onDevice: () => void; onOpen: (panel: BrowserUtility) => void; onError: (message: string) => void;
  deviceActive?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<unknown>) => { onError(""); void action().catch((error) => onError(error instanceof Error ? error.message : String(error))); };
  const screenshot = async () => {
    if (!tab) return;
    const { data } = await browserPageAction(tab.id, "capture");
    if (!data) throw new Error("网页截图失败");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ title: "保存网页截图", defaultPath: "网页截图.png", filters: [{ name: "PNG 图片", extensions: ["png"] }] });
    if (path) {
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, Uint8Array.from(atob(data), (character) => character.charCodeAt(0)));
    }
  };
  const open = async () => {
    if (busy) return;
    if (!isTauri()) { onError("请在 Mona 桌面端使用浏览器选项。"); return; }
    setBusy(true); onError("");
    try {
      const { Menu } = await import("@tauri-apps/api/menu");
      const ready = !!tab?.webviewCreated;
      const zoom = ready ? await browserGetZoom(tab!.id) : 1;
      const menu = await Menu.new({ items: [
        { text: "在页面中查找", enabled: ready, action: onFind },
        { text: "打印", enabled: ready, action: () => run(() => browserPrintPage(tab!.id)) },
        { item: "Separator" },
        { text: `缩放（${Math.round(zoom * 100)}%）`, enabled: ready, items: [
          { text: "放大", enabled: ready && zoom < 5, action: () => run(() => browserSetZoom(tab!.id, Math.min(5, Math.round((zoom + 0.1) * 10) / 10))) },
          { text: "缩小", enabled: ready && zoom > 0.25, action: () => run(() => browserSetZoom(tab!.id, Math.max(0.25, Math.round((zoom - 0.1) * 10) / 10))) },
          { text: "重置为 100%", enabled: ready, action: () => run(() => browserSetZoom(tab!.id, 1)) },
        ] },
        { item: "Separator" },
        { text: deviceActive ? "隐藏设备工具栏" : "显示设备工具栏", enabled: ready, action: onDevice },
        { text: "截取网页截图", enabled: ready, action: () => run(screenshot) },
        { text: "开发者工具", enabled: ready, action: () => run(() => browserOpenDevtools(tab!.id)) },
        { item: "Separator" },
        { text: "下载", action: () => onOpen("downloads") },
        { text: "历史记录", action: () => onOpen("history") },
        { text: "清除浏览数据", action: () => onOpen("settings") },
        { item: "Separator" },
        { text: "浏览器设置", action: () => onOpen("settings") },
      ] });
      try { await menu.popup(); } finally { await menu.close(); }
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground" aria-label="浏览器选项" title="浏览器选项" disabled={busy} onClick={() => void open()}><MoreHorizontal className="h-4 w-4" /></Button>;
}

export function BrowserSettingsPanel({ tabId, onClose }: { tabId?: string; onClose: () => void }) {
  const [zoom, setZoom] = useState("1");
  const [history, setHistory] = useState(false);
  const [cache, setCache] = useState(false);
  const [cookies, setCookies] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true;
    if (tabId) void browserGetZoom(tabId).then((value) => { if (alive) setZoom(String(value)); }).catch((cause) => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [tabId]);
  const clear = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      if (history) await browserClearHistory();
      if (cache && tabId) await browserPageAction(tabId, "clear_cache");
      if (cookies && tabId) await browserPageAction(tabId, "clear_cookies");
      setNotice("已清除所选数据"); setConfirm(false);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="scrollbar-thin h-full overflow-y-auto bg-background p-4 text-ui">
    <header className="mb-6 flex items-center gap-2"><Button variant="ghost" size="icon" className="h-8 w-8" aria-label="返回网页" onClick={onClose}><ArrowLeft className="h-4 w-4" /></Button><h3 className="font-medium">浏览器设置</h3></header>
    <label className="mb-6 flex items-center justify-between gap-3">网页缩放<Select aria-label="网页缩放" value={zoom} disabled={!tabId || busy} className="w-28" options={[...new Set(["0.5", "0.75", "1", "1.25", "1.5", "2", zoom])].sort((a, b) => Number(a) - Number(b)).map((value) => ({ value, label: `${Math.round(Number(value) * 100)}%` }))} onValueChange={(value) => {
      if (tabId) { setBusy(true); setError(""); void browserSetZoom(tabId, Number(value)).then(() => setZoom(value)).catch((cause) => setError(String(cause))).finally(() => setBusy(false)); }
    }} /></label>
    <h4 className="mb-3 font-medium">清除浏览数据</h4>
    <div className="space-y-3">
      <label className="flex items-center gap-2"><Checkbox checked={history} disabled={busy} onCheckedChange={(value) => setHistory(value === true)} />浏览历史</label>
      <label className="flex items-center gap-2"><Checkbox checked={cache} disabled={!tabId || busy} onCheckedChange={(value) => setCache(value === true)} />缓存</label>
      <label className="flex items-center gap-2"><Checkbox checked={cookies} disabled={!tabId || busy} onCheckedChange={(value) => setCookies(value === true)} />Cookie</label>
      <Button variant="outline" disabled={busy || !(history || cache || cookies)} onClick={() => setConfirm(true)}>清除所选数据</Button>
    </div>
    {error && <p role="alert" className="mt-3 text-caption text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-3 text-caption text-muted-foreground">{notice}</p>}
    <AlertDialog open={confirm} onOpenChange={(value) => !busy && setConfirm(value)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>清除所选浏览数据？</AlertDialogTitle><AlertDialogDescription>{cookies ? "清除 Cookie 会退出网站登录。此操作无法撤销。" : "所选数据将被删除，此操作无法撤销。"}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>取消</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void clear(); }}>清除</AlertDialogAction></AlertDialogFooter>{error && <p role="alert" className="text-caption text-destructive">{error}</p>}</AlertDialogContent></AlertDialog>
  </section>;
}
