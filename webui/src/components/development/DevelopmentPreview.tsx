import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, RotateCw, Puzzle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { normalizeUrlOrSearch } from "@/components/browser/browser-navigation";
import { SidebarBrowserPanel } from "@/components/deliver/SidebarBrowserPanel";
import { BrowserExtensionsPanel } from "@/components/browser/BrowserExtensionsPanel";
import { BrowserOptionsButton, BrowserSettingsPanel, type BrowserUtility } from "@/components/browser/BrowserOptions";
import { HistoryPage } from "@/components/browser/HistoryPage";
import { DownloadsPage } from "@/components/browser/DownloadsPage";
import { browserPageAction } from "@/lib/browser-ipc";
import type { DevSession } from "@/lib/development-api";
import { isTauri } from "@/lib/tauri";
import { DevelopmentBrowserBinding } from "./DevelopmentBrowserBinding";
import type { DevelopmentBrowserHost } from "./DevelopmentSidebar";
import { useDevelopmentStore } from "./store";

export function openDevelopmentPreview(sessionId: string, host?: DevelopmentBrowserHost) {
  if (!host) return;
  const state = useDevelopmentStore.getState();
  const existing = state.browserTabs[sessionId] ?? state.snapshots[sessionId]?.browserBinding?.tabId;
  // A missing old page is not permission to create a replacement.
  if (!existing) state.setBrowser(sessionId, host.create());
}

export function DevelopmentPreview({ session, host, visible, layoutVersion, children }: {
  session: DevSession; host?: DevelopmentBrowserHost; visible: boolean; layoutVersion: string;
  children?: ReactNode;
}) {
  const selected = useDevelopmentStore((s) => s.browserTabs[session.id]);
  const binding = useDevelopmentStore((s) => s.snapshots[session.id]?.browserBinding);
  const id = selected ?? binding?.tabId;
  const tab = host?.tabs.find((candidate) => candidate.id === id) ?? null;
  const pending = useRef<string | null>(null);
  const pendingUrl = useRef("");
  const [address, setAddress] = useState(tab?.url ?? "");
  const [error, setError] = useState("");
  const [utility, setUtility] = useState<BrowserUtility | null>(null);
  const [findRequest, setFindRequest] = useState(0);
  const deviceSize = useDevelopmentStore((s) => s.sides[session.id]?.deviceSize);
  const [deviceWidth, setDeviceWidth] = useState(deviceSize?.width ?? 390);
  const [deviceHeight, setDeviceHeight] = useState(deviceSize?.height ?? 844);
  useEffect(() => {
    if (tab?.webviewCreated && deviceSize) void browserPageAction(tab.id, "device", deviceSize).catch((cause) => setError(String(cause)));
  }, [tab?.id, tab?.webviewCreated]);
  useEffect(() => { setAddress(tab?.url ?? ""); }, [tab?.url]);
  useEffect(() => {
    if (!selected && binding) useDevelopmentStore.getState().setBrowser(session.id, binding.tabId);
  }, [selected, binding, session.id]);
  useEffect(() => {
    if (tab?.id !== pending.current) return;
    pending.current = null;
    if (pendingUrl.current && host && tab) {
      const url = pendingUrl.current; pendingUrl.current = "";
      host.navigate(tab.id, url);
    }
  }, [tab?.id, host]);
  const retain = host?.retain;
  useEffect(() => { if (tab) retain?.(tab.id); }, [tab?.id, retain]);
  const setVisible = host?.setVisible;
  useEffect(() => {
    setVisible?.(visible && tab && !utility ? tab.id : null);
    return () => setVisible?.(null);
  }, [visible, tab?.id, setVisible, utility]);
  const controller = useMemo(() => host && tab ? {
    tab, navigate: (url: string) => host.navigate(tab.id, url), goBack: () => host.goBack(tab.id),
    goForward: () => host.goForward(tab.id), reload: () => host.reload(tab.id),
    updateUrl: (url: string) => host.updateUrl(tab.id, url), openDevtools: () => host.openDevtools(tab.id),
  } : undefined, [tab, host]);
  const create = () => {
    if (pending.current || !host) return;
    pending.current = host.create();
    useDevelopmentStore.getState().setBrowser(session.id, pending.current);
  };
  const navigate = () => {
    const url = normalizeUrlOrSearch(address);
    if (!url) return;
    if (!isTauri() || !host) { setError("请在 Mona 桌面端打开网页。"); return; }
    if (id && !tab && !pending.current) { setError("原预览页不可用，请先新建预览页。"); return; }
    setError("");
    if (tab) host.navigate(tab.id, url);
    else { pendingUrl.current = url; create(); }
  };
  const updateDevice = async (size?: { width: number; height: number }) => {
    if (!tab?.webviewCreated) return;
    setError("");
    try { await browserPageAction(tab.id, size ? "device" : "device_off", size); useDevelopmentStore.getState().setSide(session.id, { deviceSize: size }); }
    catch (cause) { setError(String(cause)); }
  };
  return <>
    <form className="flex h-12 shrink-0 items-center gap-1 border-b border-border/50 bg-background px-2" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label="后退" title="后退" disabled={!tab?.canGoBack} onClick={() => tab && host?.goBack(tab.id)}><ArrowLeft className="h-4 w-4" /></Button>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label="前进" title="前进" disabled={!tab?.canGoForward} onClick={() => tab && host?.goForward(tab.id)}><ArrowRight className="h-4 w-4" /></Button>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label="刷新网页" title="刷新网页" disabled={!tab?.url} onClick={() => tab && host?.reload(tab.id)}><RotateCw className="h-4 w-4" /></Button>
      <Input aria-label="搜索或输入网址" placeholder="搜索或输入网址" value={address} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.target.select()} className="ml-1 h-8 min-w-0 flex-1 text-caption" />
      <DevelopmentBrowserBinding key={session.id} session={session} tabId={tab?.id} url={tab?.url} binding={binding} onError={setError} />
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground" aria-label="扩展程序" title="扩展程序" disabled={!tab?.webviewCreated} onClick={() => { setUtility("extensions"); setError(""); }}><Puzzle className="h-4 w-4" /></Button>
      <BrowserOptionsButton tab={tab} deviceActive={!!deviceSize} onFind={() => { setUtility(null); setFindRequest((value) => value + 1); }} onDevice={() => void updateDevice(deviceSize ? undefined : { width: deviceWidth, height: deviceHeight })} onOpen={(panel) => { setUtility(panel); setError(""); }} onError={setError} />
    </form>
    {error && <p role="alert" className="px-3 py-2 text-caption text-destructive">{error}</p>}
    {deviceSize && !utility && <form className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2 text-caption" onSubmit={(event) => { event.preventDefault(); void updateDevice({ width: deviceWidth, height: deviceHeight }); }}>
      <Input type="number" aria-label="设备宽度" className="h-7 w-20" min={240} max={3840} value={deviceWidth} onChange={(event) => setDeviceWidth(Number(event.target.value))} /><span>×</span><Input type="number" aria-label="设备高度" className="h-7 w-20" min={200} max={2160} value={deviceHeight} onChange={(event) => setDeviceHeight(Number(event.target.value))} /><Button type="submit" variant="ghost" size="sm">应用</Button><Button type="button" variant="ghost" size="icon" className="ml-auto h-7 w-7" aria-label="关闭设备工具栏" onClick={() => void updateDevice()}><X className="h-4 w-4" /></Button>
    </form>}
    <div className="relative min-h-0 flex-1">
      <div className={utility ? "hidden" : "h-full"}>
      {controller && tab?.url ? <SidebarBrowserPanel session={null} visible={visible && !utility} layoutVersion={layoutVersion} controller={controller} showToolbar={false} findRequest={findRequest} /> : id && !tab ?
        <div className="space-y-3 p-4 text-ui"><p className="text-muted-foreground">{id ? "原预览页已关闭或尚未恢复，不会自动新建替代页。" : "尚未打开预览页。"}</p>
          <Button variant="outline" disabled={!host} onClick={create}>新建预览页</Button>
        </div> : children}
      </div>
      {utility && <div className="absolute inset-0 overflow-hidden bg-background">
        {utility === "extensions" && tab && <BrowserExtensionsPanel tabId={tab.id} onClose={() => setUtility(null)} />}
        {utility === "history" && <HistoryPage onBack={() => setUtility(null)} onNavigate={(url) => { setUtility(null); setAddress(url); if (tab) host?.navigate(tab.id, url); else { pendingUrl.current = url; create(); } }} />}
        {utility === "downloads" && <DownloadsPage onBack={() => setUtility(null)} />}
        {utility === "settings" && <BrowserSettingsPanel tabId={tab?.webviewCreated ? tab.id : undefined} onClose={() => setUtility(null)} />}
      </div>}
    </div>
  </>;
}
