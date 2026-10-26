import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { tempDir, join } from "@tauri-apps/api/path";
import { Loader2, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileSystemIcon } from "@/components/ui/file-system-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getServicesStatus, openPathWithSystemApp, isTauri } from "@/lib/tauri";
import { fetchEmailBody, listAccounts, markRead, downloadAttachmentToFile } from "./lib/emailApi";
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

function attachmentErrorHint(error: unknown): string {
  const message = String(error);
  if (message.includes("附件未完整缓存在本地")) {
    return "附件尚未完整保存在本地，邮件服务未就绪。请启动邮件服务或同步邮件后重试。";
  }
  if (message.includes("本地邮件缓存中未找到该附件")) {
    return "本地邮件缓存中没有该附件，请重新同步邮件后重试。";
  }
  return "请检查邮件是否已完整收取或网络连接是否正常，然后重试。";
}

function showAttachmentError(action: string, error: unknown): void {
  console.warn(`${action}附件失败`);
  window.alert(`${action}附件失败。${attachmentErrorHint(error)}`);
}

export function formatPreviewDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function MailPreviewWindow() {
  const [message, setMessage] = useState<EmailMessage | null>(null);
  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingAtt, setDownloadingAtt] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [showProgress, setShowProgress] = useState(false);
  // 正文加载阶段：'local'=读本地，'network'=走邮件服务器
  const [bodyStage, setBodyStage] = useState<"local" | "network">("local");
  const bodyLoadingText = bodyStage === "network" ? "正在请求邮件..." : "正在加载正文...";

  const [params] = useState(parsePreviewParams);

  useEffect(() => {
    if (!loading) {
      setShowProgress(false);
      return;
    }
    const timer = window.setTimeout(() => setShowProgress(true), 400);
    return () => window.clearTimeout(timer);
  }, [loading]);

  // 监听 Rust 端 email-body-stage 事件：本地未命中时切为 'network'，切换提示文案
  useEffect(() => {
    if (!params) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const stop = await listen<{
          accountId: string;
          uid: string;
          mailbox: string;
          stage: "local" | "network";
        }>(
          "email-body-stage",
          (event) => {
            const payload = event.payload;
            if (
              payload?.accountId === params.accountId &&
              payload.uid === params.uid && payload.mailbox === params.folder &&
              payload.stage === "network"
            ) {
              setBodyStage("network");
            }
          },
        );
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        // 非桌面环境忽略
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [params]);

  useEffect(() => {
    if (!params) {
      setError("无效的邮件参数");
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setBodyStage("local");

    // Rust 先读本地，未命中时自行取得邮件服务地址并拉取；合法空正文也只读一次。
    const bodyRequest = fetchEmailBody(params.accountId, params.uid, params.folder);
    // 附件和已读同步所需的信息并行准备，不阻塞本地正文。
    const resources = Promise.all([
      getServicesStatus().catch(() => null),
      listAccounts().catch(() => []),
    ]).then(([status, accounts]) => {
      const url = status?.running && status.port ? `http://127.0.0.1:${status.port}` : "";
      const acc = accounts.find((a) => a.id === params.accountId) ?? null;
      if (!cancelled) {
        setGatewayUrl(url);
        setAccount(acc);
      }
      return { url, acc };
    });

    (async () => {
      try {
        const body = await bodyRequest;
        if (!cancelled) {
          setMessage({
            uid: params.uid,
            accountId: params.accountId,
            folder: params.folder,
            subject: body.header?.subject ?? "",
            fromAddress: body.header?.fromAddress ?? "",
            fromName: body.header?.fromName ?? "",
            toAddresses: body.header?.toAddresses ?? "",
            ccAddresses: body.header?.ccAddresses ?? "",
            date: body.header?.date ?? "",
            hasAttachments: body.attachments?.some((attachment) => !attachment.isInline) ?? false,
            isRead: true,
            isStarred: false,
            rawSize: 0,
            messageId: "",
            attachments: body.attachments ?? [],
            bodyText: body.bodyText,
            bodyHtml: body.bodyHtml,
            bodyFetched: true,
          });
          // 本地优先：已读标志后台同步，不阻塞正文显示。
          void resources.then(({ url, acc }) => {
            if (!cancelled && acc) return markRead(url, acc, params.folder, params.uid, true);
          }).catch((e) => {
            console.warn("[MailPreviewWindow] 标记已读失败:", e);
          });
        }
      } catch (e) {
        console.warn("[MailPreviewWindow] 加载邮件失败:", e instanceof Error ? e.name : "Error");
        if (!cancelled) setError("暂时无法加载这封邮件，请稍后重试。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [params, loadAttempt]);

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
    if (!isTauri()) {
      window.alert("请在 Mona 桌面版中打开附件。");
      return;
    }
    if (!account || !message) {
      window.alert("邮箱账号尚未准备好，请稍后重试。");
      return;
    }
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
        att.contentId ?? undefined,
      );
      await openPathWithSystemApp(filePath);
    } catch (e) {
      showAttachmentError("打开", e);
    } finally {
      setDownloadingAtt(null);
    }
  };

  const handleDownloadAttachment = async (att: EmailAttachment) => {
    if (!isTauri()) {
      window.alert("请在 Mona 桌面版中下载附件。");
      return;
    }
    if (!account || !message) {
      window.alert("邮箱账号尚未准备好，请稍后重试。");
      return;
    }
    setDownloadingAtt(att.filename);
    try {
      const savePath = await save({ defaultPath: att.filename });
      if (savePath) {
        await downloadAttachmentToFile(
          gatewayUrl,
          account,
          message.folder,
          message.uid,
          att.filename,
          savePath,
          att.contentId ?? undefined,
        );
      }
    } catch (e) {
      showAttachmentError("下载", e);
    } finally {
      setDownloadingAtt(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen flex-col bg-background" aria-busy="true">
        <div className="space-y-3 border-b border-border px-6 py-4" aria-hidden="true">
          <div className="h-5 w-3/5 rounded bg-muted" />
          <div className="h-3 w-2/5 rounded bg-muted" />
          <div className="h-3 w-1/3 rounded bg-muted" />
        </div>
        <div className="space-y-3 px-6 py-4" aria-hidden="true">
          <div className="h-3 w-full rounded bg-muted" />
          <div className="h-3 w-full rounded bg-muted" />
          <div className="h-3 w-4/5 rounded bg-muted" />
        </div>
        {showProgress && (
          <div role="status" className="flex items-center gap-2 px-6 text-ui text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {bodyLoadingText}
          </div>
        )}
      </div>
    );
  }

  if (error || !message) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-body text-muted-foreground">
          {error || "邮件不存在"}
        </p>
        <div className="flex gap-2">
          {params && (
            <Button variant="outline" size="sm" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
              重试
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleClose}>
            关闭
          </Button>
        </div>
      </div>
    );
  }

  const fromName = message.fromName?.trim() || message.fromAddress;
  const attachments = message.attachments?.filter((attachment) => !attachment.isInline) ?? [];
  const attachmentsReady = Boolean(account && isTauri());

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* 顶部信息栏 */}
      <div className="shrink-0 border-b border-border px-6 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-body-lg font-semibold">
              {message.subject || "(无主题)"}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-caption text-muted-foreground">
              <span>
                <span className="text-foreground/70">发件人：</span>
                {fromName}{" "}
                <span className="text-muted-foreground">
                  &lt;{message.fromAddress}&gt;
                </span>
              </span>
              <span>
                <span className="text-foreground/70">日期：</span>
                {formatPreviewDate(message.date)}
              </span>
            </div>
            <div className="mt-0.5 text-caption text-muted-foreground">
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
                        aria-disabled={!attachmentsReady}
                        title={attachmentsReady ? "双击打开" : "邮箱账号尚未准备好"}
                      >
                        {downloadingAtt === att.filename ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                        ) : (
                          <FileSystemIcon name={att.filename} />
                        )}
                        <span
                          className="min-w-0 flex-1 truncate text-caption text-foreground"
                          title={att.filename}
                        >
                          {att.filename}
                        </span>
                        <span className="shrink-0 text-micro text-muted-foreground">
                          {formatSize(att.size)}
                        </span>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="min-w-[160px]">
                      <ContextMenuItem disabled={!attachmentsReady} onClick={() => void handleOpenAttachment(att)}>
                        <ExternalLink className="mr-2 h-3.5 w-3.5" />
                        打开
                      </ContextMenuItem>
                      <ContextMenuItem disabled={!attachmentsReady} onClick={() => void handleDownloadAttachment(att)}>
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
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4 scrollbar-hover">
        {message.bodyError ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-muted-foreground">
            <span className="text-ui text-destructive">正文加载失败</span>
            <span className="max-w-md text-center text-caption text-muted-foreground">{message.bodyError}</span>
          </div>
        ) : !message.bodyFetched ? (
          <div className="flex h-full min-h-[200px] items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="ml-2 text-ui">{bodyLoadingText}</span>
          </div>
        ) : message.bodyHtml ? (
          <SafeHtmlFrame html={message.bodyHtml} />
        ) : message.bodyText ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
            {message.bodyText}
          </pre>
        ) : (
          // fetchEmailBody 已完成但 bodyText/bodyHtml 都空：合法空正文
          // skill 第四节：合法空正文不得反复请求网络
          <div className="flex h-full min-h-[200px] items-center justify-center text-muted-foreground">
            <span className="text-ui">此邮件无可显示正文</span>
          </div>
        )}
      </div>
    </div>
  );
}
