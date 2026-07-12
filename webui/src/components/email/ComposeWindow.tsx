import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getGatewayStatus } from "@/lib/tauri";
import { MailComposer, type ComposerMode } from "./MailComposer";
import { listAccounts } from "./lib/emailApi";
import type { EmailAccount, EmailMessage } from "./lib/types";

interface ComposePayload {
  mode: ComposerMode;
  accountId: string;
  baseMessage?: EmailMessage | null;
  presetTo?: string | null;
}

function parseComposePayload(): ComposePayload | null {
  try {
    const hash = window.location.hash;
    const queryIndex = hash.indexOf("?");
    if (queryIndex === -1) return null;
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    const data = params.get("data");
    if (!data) return null;
    // URL-safe base64 (no padding) → standard base64
    let b64 = data.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) {
      b64 += "=";
    }
    // atob 返回 Latin-1 字符串，UTF-8 中文会乱码。
    // 先 atob 得到二进制字符串，再用 TextDecoder 按 UTF-8 解码。
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const parsed = JSON.parse(json) as ComposePayload;
    return parsed;
  } catch {
    return null;
  }
}

export function ComposeWindow() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [gatewayUrl, setGatewayUrl] = useState<string>("");
  const [payload, setPayload] = useState<ComposePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const payload = parseComposePayload();
    setPayload(payload);

    (async () => {
      try {
        const [accounts, gw] = await Promise.all([
          listAccounts(),
          getGatewayStatus().catch(() => null),
        ]);
        setAccounts(accounts);
        if (gw?.running && gw?.port) {
          setGatewayUrl(`http://127.0.0.1:${gw.port}`);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const account = useMemo(() => {
    const targetId = payload?.accountId;
    if (!targetId) return accounts[0] ?? null;
    return accounts.find((a) => a.id === targetId) ?? accounts[0] ?? null;
  }, [accounts, payload]);

  const handleClose = async () => {
    try {
      await invoke("email_close_compose_window");
    } catch {
      // fallback：如果 invoke 失败则尝试浏览器原生关闭
      if (typeof window !== "undefined") {
        window.close();
      }
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-[13px] text-muted-foreground">
        正在加载...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-[13px] text-destructive">
        {error}
      </div>
    );
  }

  return (
    <MailComposer
      open={true}
      onOpenChange={handleClose}
      gatewayUrl={gatewayUrl}
      mode={payload?.mode ?? "compose"}
      baseMessage={payload?.baseMessage ?? null}
      account={account}
      standalone
      presetTo={payload?.presetTo ?? null}
    />
  );
}
