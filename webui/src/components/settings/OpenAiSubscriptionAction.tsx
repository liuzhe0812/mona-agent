import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { developmentApi, type DevExecutor, type NativeLoginStatus } from "@/lib/development-api";
import { isTauri } from "@/lib/tauri";

const pending = (state?: string) => state === "starting" || state === "waiting" || state === "cancelling";

export function OpenAiSubscriptionAction({ executor, onChanged }: { executor?: DevExecutor; onChanged: () => void }) {
  const [status, setStatus] = useState<NativeLoginStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const onChangedRef = useRef(onChanged);
  const notified = useRef("");
  onChangedRef.current = onChanged;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const value = await developmentApi.loginStatus(undefined, "codex");
        if (!active) return;
        setStatus(value);
        if (pending(value.state)) timer = setTimeout(() => void read(), 1200);
        else if (value.state === "succeeded" && value.loginId && notified.current !== value.loginId) {
          notified.current = value.loginId;
          const probe = await developmentApi.probe(undefined, "codex");
          if (probe.authMode !== "chatgpt") setError("暂时无法使用 ChatGPT 账号，请稍后重试。");
          if (active) onChangedRef.current();
        }
      } catch (cause) {
        if (active) setError("暂时无法检查连接，请稍后重试。");
      }
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [revision]);

  const connected = executor?.probe?.authMode === "chatgpt";
  const act = async () => {
    if (busy) return;
    if (!status || status.state === "unknown") {
      setError("");
      setRevision((value) => value + 1);
      return;
    }
    if (connected && !window.confirm("断开 ChatGPT 连接？正在运行的 Codex 开发任务可能受到影响。")) return;
    setBusy(true);
    setError("");
    try {
      if (connected) {
        await developmentApi.logout("codex");
        setStatus({ loginId: null, state: "idle", authUrl: "", reason: "" });
        onChangedRef.current();
      } else if (pending(status.state) && status.loginId) {
        setStatus(await developmentApi.cancelLogin(undefined, "codex", status.loginId));
      } else {
        if (!(executor?.programAvailable ?? executor?.available)) throw new Error("请先在引擎管理中检查 Codex 程序");
        const value = await developmentApi.login(undefined, "codex");
        setStatus(value);
        setRevision((current) => current + 1);
        if (value.authUrl) {
          const url = new URL(value.authUrl);
          if (url.protocol !== "https:" || !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname)
            || url.username || url.password || (url.port && url.port !== "443")) {
            throw new Error("暂时无法打开登录页面，请稍后重试。");
          }
          if (isTauri()) {
            const { openUrl } = await import("@tauri-apps/plugin-opener");
            await openUrl(value.authUrl);
          } else window.open(value.authUrl, "_blank", "noopener,noreferrer");
        }
      }
      if (connected || pending(status.state)) setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error && (cause.message.startsWith("请先在引擎管理") || cause.message.startsWith("暂时无法打开")) ? cause.message : "连接失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Button type="button" variant="outline" className="rounded-full" onClick={() => void act()} disabled={busy || (!status && !error)}>
      {connected ? "断开连接" : !status || status.state === "unknown" ? "检查连接状态" : pending(status.state) ? "取消连接" : "使用本机 Codex 账号"}
    </Button>
    {status?.state === "waiting" && status.authUrl && <a href={status.authUrl} target="_blank" rel="noreferrer" className="text-caption text-info underline">打开认证页面</a>}
    {error && <span role="alert" className="text-caption text-destructive">{error}</span>}
  </>;
}
