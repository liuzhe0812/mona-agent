import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { tempDir, join } from "@tauri-apps/api/path";
import { ArrowLeft, Loader2, Paperclip, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getGatewayStatus, openPathWithSystemApp, isTauri } from "@/lib/tauri";
import { fetchEmailBody, getMessages, listAccounts, downloadAttachmentToFile } from "./lib/emailApi";
import type { EmailAccount, EmailAttachment, EmailMessage } from "./lib/types";
import { SafeHtmlFrame } from "./MailView";

interface PreviewParams {
  accountId: string;
  uid: string;
  folder: string;
}

function parsePreviewParams(): PreviewParams | null {
  try {
    const hash = window.location.hash;
    const queryIndex = hash.indexOf("?");
    if (queryIndex === -1) return null;
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    const accountId = params.get("accountId");
    const uid = params.get("uid");
    const folder = params.get("folder");
    if (!accountId || !uid || !folder) return null;
    return { accountId, uid, folder };
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MailPreviewWindow() {
  const [message, setMessage] = useState<EmailMessage | null>(null);
  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingAtt, setDownloadingAtt] = useState<string | null>(null);

  const params = parsePreviewParams();

  useEffect(() => {
    if (!params) {
      setError("无效的邮件参数");
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const gw = await getGatewayStatus().catch(() => null);
        const url =
          gw?.running && gw?.port ? `http://127.0.0.1:${gw.port}` : "";
        if (!cancelled) setGatewayUrl(url);

        // 获取账号列表，找到对应账号
        const accounts = await listAccounts().catch(() => []);
        const acc = accounts.find((a) => a.id === params.accountId);
        if (!cancelled) setAccount(acc ?? null);

        // 用 before_uid = uid+1 + limit=1 取目标邮件元数据
        const uidNum = Number.parseInt(params.uid, 10);
        const beforeUid = Number.isFinite(uidNum)
          ? String(uidNum + 1)
          : null;
        const msgs = await getMessages(
          params.accountId,
          params.folder,
          beforeUid,
          1,
        );
        const target = msgs.find((m) => m.uid === params.uid);
        if (!target) {
          if (!cancelled) {
            setError("邮件不存在或已被删除");
            setLoading(false);
          }
          return;
        }
        if (!cancelled) setMessage(target);

        // 拉取正文
        if (url) {
          try {
            const body = await fetchEmailBody(
              url,
              params.accountId,
              params.uid,
              params.folder,
            );
            if (!cancelled) {
              setMessage((prev) =>
                prev
                  ? {
                      ...prev,
                      bodyText: body.bodyText,
                      bodyHtml: body.bodyHtml,
                      attachments: body.attachments,
                      bodyFetched: true,
                    }
                  : prev,
              );
            }
          } catch (e) {
            if (!cancelled) {
              setMessage((prev) =>
                prev
                  ? {
                      ...prev,
                      bodyFetched: true,
                      bodyError: String(e),
                    }
                  : prev,
              );
            }
          }
        } else {
          if (!cancelled) {
            setMessage((prev) =>
              prev
                ? {
                    ...prev,
                    bodyFetched: true,
                    bodyError: "Gateway 未运行，无法加载正文",
                  }
                : prev,
            );
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 同步窗口标题为邮件主题
  useEffect(() => {
    if (message?.subject) {
      document.title = message.subject;
    }
  }, [message?.subject]);

  const handleClose = async () => {
    try {
      await invoke("email_close_compose_window");
    } catch {
      window.close();
    }
  };

  const handleOpenAttachment = async (att: EmailAttachment) => {
    if (!gatewayUrl || !isTauri() || !account || !message) return;
    setDownloadingAtt(att.filename);
    try {
      const tmp = await tempDir();
      const safeName = att.filename.replace(/[<>:"/\\|?*]/g, "_");
      const filePath = await join(tmp, `mona-${message.uid}-${safeName}`);
      await downloadAttachmentToFile(
        gatewayUrl,
        account,
        message.folder,
        message.uid,
        att.filename,
        filePath,
      );
      await openPathWithSystemApp(filePath);
    } catch (e) {
      console.error("打开附件失败:", e);
    } finally {
      setDownloadingAtt(null);
    }
  };

  const handleDownloadAttachment = async (filename: string) => {
    if (!gatewayUrl || !account || !message) return;
    setDownloadingAtt(filename);
    try {
      const savePath = await save({ defaultPath: filename });
      if (savePath) {
        await downloadAttachmentToFile(
          gatewayUrl,
          account,
          message.folder,
          message.uid,
          filename,
          savePath,
        );
      }
    } catch (e) {
      console.error("下载附件失败:", e);
    } finally {
      setDownloadingAtt(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !message) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-sm text-muted-foreground">
          {error || "邮件不存在"}
        </p>
        <Button variant="outline" size="sm" onClick={handleClose}>
          关闭
        </Button>
      </div>
    );
  }

  const fromName = message.fromName?.trim() || message.fromAddress;
  const attachments = message.attachments ?? [];

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* 顶部信息栏 */}
      <div className="shrink-0 border-b border-border px-6 py-4">
        <div className="flex items-start gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="mt-0.5 h-7 w-7"
            onClick={handleClose}
            title="关闭"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">
              {message.subject || "(无主题)"}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
              <span>
                <span className="text-foreground/70">发件人：</span>
                {fromName}{" "}
                <span className="text-muted-foreground">
                  &lt;{message.fromAddress}&gt;
                </span>
              </span>
              <span>
                <span className="text-foreground/70">日期：</span>
                {message.date}
              </span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              <span className="text-foreground/70">收件人：</span>
              {message.toAddresses}
            </div>
            {attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {attachments.map((att, idx) => (
                  <ContextMenu key={idx}>
                    <ContextMenuTrigger asChild>
                      <div
                        className="group flex w-[220px] cursor-pointer items-center gap-2 rounded px-2 py-1 transition-colors hover:bg-muted/60"
                        onDoubleClick={() => void handleOpenAttachment(att)}
                        title="双击打开"
                      >
                        {downloadingAtt === att.filename ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                        ) : (
                          <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span
                          className="min-w-0 flex-1 truncate text-[12px] text-foreground"
                          title={att.filename}
                        >
                          {att.filename}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {formatSize(att.size)}
                        </span>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="min-w-[160px]">
                      <ContextMenuItem onClick={() => void handleOpenAttachment(att)}>
                        <ExternalLink className="mr-2 h-3.5 w-3.5" />
                        打开
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => void handleDownloadAttachment(att.filename)}>
                        <Download className="mr-2 h-3.5 w-3.5" />
                        另存为...
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 正文区域 */}
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {message.bodyError ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-destructive">{message.bodyError}</p>
          </div>
        ) : !message.bodyFetched ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : message.bodyHtml ? (
          <SafeHtmlFrame html={message.bodyHtml} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
            {message.bodyText || "(无正文)"}
          </pre>
        )}
      </div>
    </div>
  );
}
