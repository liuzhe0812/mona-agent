import { useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { developmentApi, executorLabels, type ExecutorId, type NativeLoginStatus } from "@/lib/development-api";
import { openExternalUrl } from "@/lib/tauri";

const observing = (state?: string) => !!state && ["starting", "waiting", "cancelling"].includes(state);
const unresolved = (state?: string) => observing(state) || state === "unknown";

export function DevelopmentLogin({ projectId, executor, disabled, configRevision, onChanged, onStateChanged, authorizationRequired = false, actionLabel = "获取官方登录链接", actionVariant = "outline", compactNotice = false, inline = false }: {
  projectId?: string; executor: ExecutorId; disabled: boolean; configRevision?: string; onChanged: () => void; actionLabel?: string;
  onStateChanged?: (state: NativeLoginStatus["state"]) => void;
  authorizationRequired?: boolean;
  compactNotice?: boolean;
  actionVariant?: ButtonProps["variant"];
  inline?: boolean;
}) {
  const [status, setStatus] = useState<NativeLoginStatus>();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0), pending = useRef<number | null>(null), notified = useRef("");
  const observedLogin = useRef(false);
  const callback = useRef(onChanged); callback.current = onChanged;
  const stateCallback = useRef(onStateChanged); stateCallback.current = onStateChanged;
  useEffect(() => { if (status) stateCallback.current?.(status.state); }, [status]);

  useEffect(() => {
    setStatus(undefined); setError(""); setUncertain(false); setBusy(false);
    pending.current = null;
    observedLogin.current = false;
  }, [projectId, executor, configRevision]);
  useEffect(() => {
    const generation = ++epoch.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observe = async () => {
      try {
        const value = await developmentApi.loginStatus(projectId, executor);
        if (epoch.current !== generation) return;
        setStatus(value); setError(""); setUncertain(false);
        if (observing(value.state)) observedLogin.current = true;
        const key = `${value.loginId}:${value.state}`;
        if (value.loginId && !unresolved(value.state) && notified.current !== key && (!inline || observedLogin.current)) {
          notified.current = key; callback.current();
        }
        if (observing(value.state)) timer = setTimeout(() => void observe(), 1200);
      } catch {
        if (epoch.current === generation) {
          setError("暂时无法读取登录状态，请重新检查。");
          stateCallback.current?.("unknown");
        }
      }
    };
    void observe();
    return () => { epoch.current += 1; clearTimeout(timer); };
  }, [projectId, executor, configRevision, refresh, inline]);

  const openOfficial = async (url = status?.authUrl) => {
    if (!url) return;
    try { await openExternalUrl(url); }
    catch { setError("系统浏览器未打开，请稍后重试。"); }
  };

  const act = async (cancel = false) => {
    if (disabled || pending.current !== null || !status) return;
    const generation = ++epoch.current;
    let shouldObserve = false;
    pending.current = generation; setBusy(true); setError("");
    observedLogin.current = true; notified.current = "";
    stateCallback.current?.(cancel ? "cancelling" : "starting");
    try {
      const value = cancel && status.loginId
        ? await developmentApi.cancelLogin(projectId, executor, status.loginId)
        : await developmentApi.login(projectId, executor);
      if (epoch.current === generation) {
        setStatus(value);
        shouldObserve = true;
        if (!cancel && value.authUrl) await openOfficial(value.authUrl);
      }
    } catch {
      if (epoch.current === generation) {
        setUncertain(true);
        setError("连接状态暂未确认，请重新检查。");
        stateCallback.current?.("unknown");
      }
    } finally {
      if (pending.current === generation) pending.current = null;
      if (epoch.current === generation) {
        setBusy(false);
        if (shouldObserve) setRefresh((n) => n + 1);
      }
    }
  };

  const pendingLogin = !!status?.loginId && observing(status.state);
  const needsCheck = uncertain || status?.state === "unknown" || !!error;
  const succeeded = status?.state === "succeeded" && !authorizationRequired;
  const inlineStatus = needsCheck ? error ? null : "认证状态待确认"
    : status?.state === "cancelling" ? "正在取消认证…"
      : observing(status?.state) ? "等待浏览器认证…"
        : observedLogin.current && status?.state === "failed" ? "本次认证未完成，请重试。" : null;

  return <div className={inline ? "inline-flex flex-wrap items-center gap-1 text-caption" : "space-y-2 text-caption"} aria-label={`${executorLabels[executor]} 官方登录`}>
    {inline && !busy && inlineStatus && <span role="status" className="text-muted-foreground">{inlineStatus}</span>}
    {succeeded ? <p role="status" className="text-success">已授权</p> : <div className="flex flex-wrap items-center gap-2">
      <Button variant={actionVariant} size={inline ? "xs" : "sm"} className={inline ? "font-normal" : undefined} disabled={disabled || busy || (!status && !needsCheck) || status?.state === "cancelling"}
        onClick={() => needsCheck ? (setUncertain(false), setRefresh((n) => n + 1)) : void act(pendingLogin)}>
        {busy ? inline ? "正在处理…" : "处理中…" : needsCheck ? "重新检查" : pendingLogin ? inline ? "取消认证" : "取消连接" : actionLabel}
      </Button>
      {status?.state === "waiting" && status.authUrl && <Button variant="ghost" size={inline ? "xs" : "sm"} className={inline ? "font-normal" : undefined} disabled={busy} onClick={() => void openOfficial()}>{inline ? "打开认证页" : "重新打开授权页"}</Button>}
    </div>}
    {!inline && status && status.state !== "idle" && !succeeded && <p role="status" className="text-muted-foreground">{status.reason}</p>}
    {error && <p role="alert" className={compactNotice ? "max-w-md rounded-lg bg-destructive/5 px-2.5 py-2 text-micro leading-relaxed text-destructive" : "text-destructive"}>{error}</p>}
  </div>;
}
