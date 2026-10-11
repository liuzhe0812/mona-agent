import { useRef, useState } from "react";
import { Link2, LoaderCircle, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { developmentApi, type DevBrowserBinding, type DevSession } from "@/lib/development-api";
import { useDevelopmentStore } from "./store";
import { refreshDevelopmentSession } from "./useDevelopmentSession";

export function previewOriginMatches(binding: DevBrowserBinding, tabId?: string, url?: string): boolean {
  if (binding.tabId !== tabId || !url) return false;
  try { return new URL(binding.origin).origin === new URL(url).origin; }
  catch { return false; }
}

export function DevelopmentBrowserBinding({ session, tabId, url, binding, onError }: {
  session: DevSession; tabId?: string; url?: string; binding?: DevBrowserBinding | null;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const linked = !!binding && previewOriginMatches(binding, tabId, url);
  const bindable = session.executor === "mona" && !session.readonly && !session.archived;
  const hasPage = !!tabId && !!url && /^https?:\/\//i.test(url);
  const change = async (target: string | null) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); onError("");
    try {
      const response = await developmentApi.bindBrowser(session.id, target, binding?.id ?? null);
      const state = useDevelopmentStore.getState();
      const current = state.snapshots[session.id];
      if (current) state.setSnapshot(session.id, { ...current, browserBinding: response.binding });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "关联结果未确认，请刷新后重试。");
    } finally {
      refreshDevelopmentSession(session.id);
      pending.current = false; setBusy(false);
    }
  };
  if (!binding && (!bindable || !hasPage)) return null;
  const linkLabel = binding ? "重新关联" : "关联此页";
  return <div className="flex shrink-0 items-center gap-1" aria-label="开发预览关联">
    {(!linked && bindable && hasPage) && <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" disabled={busy}
      aria-label={linkLabel} title={linkLabel} onClick={() => void change(tabId!)}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Link2 className="h-4 w-4" />}</Button>}
    {binding && <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" disabled={busy}
      aria-label="解除关联" title="解除关联" onClick={() => void change(null)}><Unlink className="h-4 w-4" /></Button>}
  </div>;
}
