import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { tempDir, join } from "@tauri-apps/api/path";
import { Loader2, Paperclip, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getServicesStatus, openPathWithSystemApp, isTauri } from "@/lib/tauri";
import { fetchEmailBody, listAccounts, downloadAttachmentToFile } from "./lib/emailApi";
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
  // 正文加载阶段：'local'=读本地，'network'=走邮件服务器
  const [bodyStage, setBodyStage] = useState<"local" | "network">("local");
  const bodyLoadingText = bodyStage === "network" ? "正在请求邮件..." : "正在加载正文...";

  const params = parsePreviewParams();

  // 监听 Rust 端 email-body-stage 事件：本地未命中时切为 'network'，切换提示文案
  useEffect(() => {
    if (!params) return;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ stage: "local" | "network" }>(
          "email-body-stage",
          (event) => {
            if (event.payload?.stage === "network") {
              setBodyStage("network");
            }
          },
        );
      } catch {
        // 非桌面环境忽略
      }
    })();
    return () => {
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

    (async () => {
      try {
        // 并行：gateway 状态 + 账号列表（互不依赖）
        // listAccounts 仅用于附件下载，可延迟；getMessages 去掉：fetchEmailBody 会返回 header
        const [gw, accounts] = await Promise.all([
          getServicesStatus().catch(() => null),
          listAccounts().catch(() => []),
        ]);
        const url =
          gw?.running && gw?.port ? `http://127.0.0.1:${gw.port}` : "";
        if (!cancelled) {
          setGatewayUrl(url);
          const acc = accounts.find((a) => a.id === params.accountId);
          setAccount(acc ?? null);
        }

        // fetchEmailBody 优先读本地 .eml（毫秒级），本地失败时回退到邮件服务 HTTP 拉取
        // 本地 .eml 是 HEADER-only 时 body 为空，自动重试一次（fetchEmailBody 会走 HTTP fallback）
        try {
          let body = await fetchEmailBody(
            params.accountId,
            params.uid,
            params.folder,
            url,
          );
          // 空 body 自动重试一次（本地 .eml 是 HEADER-only 或解析失败）
          if (!body.bodyText && !body.bodyHtml) {
            console.warn("[MailPreviewWindow] 本地 body 为空，自动重试一次");
            await new Promise((r) => setTimeout(r, 200));
            body = await fetchEmailBody(
              params.accountId,
              params.uid,
              params.folder,
              url,
            );
          }
          if (!cancelled) {
            setMessage(() => ({
              uid: params.uid,
              accountId: params.accountId,
              folder: params.folder,
              subject: body.header?.subject ?? "",
              fromAddress: body.header?.fromAddress ?? "",
              fromName: body.header?.fromName ?? "",
              toAddresses: body.header?.toAddresses ?? "",
              ccAddresses: body.header?.ccAddresses ?? "",
              date: "",
              hasAttachments: (body.attachments?.length ?? 0) > 0,
              isRead: true,
              isStarred: false,
              rawSize: 0,
              messageId: "",
              attachments: body.attachments ?? [],
              bodyText: body.bodyText,
              bodyHtml: body.bodyHtml,
              bodyFetched: true,
            }));
          }
        } catch (e) {
          if (!cancelled) {
            setError(`加载邮件失败: ${e instanceof Error ? e.message : String(e)}`);
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
        <p className="text-body text-muted-foreground">
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
                {message.date}
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
                        title="双击打开"
                      >
                        {downloadingAtt === att.filename ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                        ) : (
                          <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
