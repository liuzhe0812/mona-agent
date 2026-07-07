import { useEffect, useMemo, useRef, useState } from "react";
import {
  MailOpen,
  Star,
  Paperclip,
  Download,
  Loader2,
  Sparkles,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Calendar,
  DollarSign,
  Link as LinkIcon,
  Flag,
  AlertCircle,
  Eye,
  X,
  FileDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEmailStore } from "./store/emailStore";
import type { EmailAnalysis, EmailAttachment, EmailKeyInfo, EmailMessage } from "./lib/types";
import * as emailApi from "./lib/emailApi";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

export function MailView() {
  const selectedMessage = useEmailStore((s) => s.selectedMessage);
  const toggleRead = useEmailStore((s) => s.toggleRead);
  const toggleStarred = useEmailStore((s) => s.toggleStarred);
  const gatewayUrl = useEmailStore((s) => s.gatewayUrl);
  const accounts = useEmailStore((s) => s.accounts);
  const analysisCache = useEmailStore((s) => s.analysisCache);
  const analysisLoading = useEmailStore((s) => s.analysisLoading);
  const analysisError = useEmailStore((s) => s.analysisError);
  const loadAnalysis = useEmailStore((s) => s.loadAnalysis);
  const runAnalysis = useEmailStore((s) => s.runAnalysis);
  const fetchBody = useEmailStore((s) => s.fetchBody);
  const isOnline = useEmailStore((s) => s.isOnline);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [previewing, setPreviewing] = useState<{ filename: string; dataUrl: string; contentType: string } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // 选中邮件时，若未读则自动标记为已读（仅在线时）
  useEffect(() => {
    if (selectedMessage && !selectedMessage.isRead && gatewayUrl && isOnline) {
      void toggleRead(gatewayUrl, selectedMessage);
    }
  }, [selectedMessage, gatewayUrl, toggleRead, isOnline]);

  // 选中邮件时，从本地缓存加载 AI 分析结果（不自动调用 LLM）
  useEffect(() => {
    if (selectedMessage) {
      void loadAnalysis(selectedMessage);
      setAnalysisCollapsed(false);
    }
  }, [selectedMessage, loadAnalysis]);

  // 按需拉取正文：选中邮件且正文未拉取时，调用 fetchBody 加载完整正文（仅在线时）
  // 兼容旧数据：bodyFetched=true 但 bodyText/bodyHtml 都空（Foxmail 模式 SQLite 不存正文），也需要拉取
  useEffect(() => {
    if (
      selectedMessage &&
      gatewayUrl &&
      isOnline &&
      (!selectedMessage.bodyFetched ||
        (!selectedMessage.bodyText && !selectedMessage.bodyHtml && !selectedMessage.bodyError))
    ) {
      void fetchBody(gatewayUrl, selectedMessage);
    }
  }, [selectedMessage, gatewayUrl, fetchBody, isOnline]);

  const analysisKey = selectedMessage
    ? `${selectedMessage.uid}:${selectedMessage.accountId}:${selectedMessage.folder}`
    : null;
  const analysis = analysisKey ? analysisCache[analysisKey] ?? null : null;

  const handleRunAnalysis = async () => {
    if (!selectedMessage || !gatewayUrl) return;
    try {
      await runAnalysis(gatewayUrl, selectedMessage);
    } catch {
      // 错误已存入 store
    }
  };

  if (!selectedMessage) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/10 text-muted-foreground">
        <MailOpen className="h-10 w-10 opacity-30" />
        <span className="text-[13px]">选择一封邮件查看</span>
      </div>
    );
  }

  const m = selectedMessage;

  const handleDownloadAttachment = async (filename: string) => {
    if (!gatewayUrl) return;
    const account = accounts.find((a) => a.id === m.accountId);
    if (!account) return;
    setDownloading(filename);
    try {
      const savePath = await save({
        defaultPath: filename,
      });
      if (savePath) {
        // 直接下载到文件，避免前端处理大 base64 字符串
        await emailApi.downloadAttachmentToFile(
          gatewayUrl,
          account,
          m.folder,
          m.uid,
          filename,
          savePath,
        );
      }
    } catch (e) {
      console.error("下载附件失败:", e);
    } finally {
      setDownloading(null);
    }
  };

  const handlePreviewAttachment = async (att: EmailAttachment) => {
    if (!gatewayUrl) return;
    const account = accounts.find((a) => a.id === m.accountId);
    if (!account) return;
    setLoadingPreview(att.filename);
    try {
      const resp = await emailApi.fetchAttachment(
        gatewayUrl,
        account,
        m.folder,
        m.uid,
        att.filename,
      );
      const dataUrl = `data:${att.contentType || "application/octet-stream"};base64,${resp.data}`;
      setPreviewing({ filename: att.filename, dataUrl, contentType: att.contentType });
    } catch (e) {
      console.error("预览附件失败:", e);
    } finally {
      setLoadingPreview(null);
    }
  };

  const isPreviewable = (att: EmailAttachment): boolean => {
    const ct = att.contentType.toLowerCase();
    return ct.startsWith("image/") || ct === "application/pdf";
  };

  const handleExportEml = async () => {
    if (!gatewayUrl) return;
    setExporting(true);
    try {
      const resp = await emailApi.fetchRawEmail(gatewayUrl, m.accountId, m.uid, m.folder);
      const binary = atob(resp.rawBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const safeName = (m.subject || "email").replace(/[<>:"/\\|?*]/g, "_").slice(0, 80);
      const savePath = await save({ defaultPath: `${safeName}.eml` });
      if (savePath) {
        await writeFile(savePath, bytes);
      }
    } catch (e) {
      console.error("导出 .eml 失败:", e);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 flex-1 text-[15px] font-semibold text-foreground">
            {m.subject || "(无主题)"}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => void toggleRead(gatewayUrl, m)}
              aria-label={m.isRead ? "标记为未读" : "标记为已读"}
              title={m.isRead ? "标记为未读" : "标记为已读"}
            >
              <MailOpen className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => void toggleStarred(gatewayUrl, m)}
              aria-label={m.isStarred ? "取消星标" : "星标"}
              title={m.isStarred ? "取消星标" : "星标"}
            >
              <Star
                className={
                  m.isStarred
                    ? "h-3.5 w-3.5 fill-amber-400 text-amber-400"
                    : "h-3.5 w-3.5"
                }
              />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              disabled={exporting}
              onClick={() => void handleExportEml()}
              aria-label="导出为 .eml"
              title="导出为 .eml"
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileDown className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
        <div className="mt-2 flex flex-col gap-0.5 text-[12px] text-muted-foreground">
          <div className="flex gap-2">
            <span className="shrink-0 text-muted-foreground/70">发件人</span>
            <span className="min-w-0 truncate text-foreground">
              {formatSender(m.fromName, m.fromAddress)}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="shrink-0 text-muted-foreground/70">收件人</span>
            <span className="min-w-0 truncate text-foreground">{m.toAddresses}</span>
          </div>
          {m.ccAddresses && (
            <div className="flex gap-2">
              <span className="shrink-0 text-muted-foreground/70">抄送</span>
              <span className="min-w-0 truncate text-foreground">{m.ccAddresses}</span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="shrink-0 text-muted-foreground/70">时间</span>
            <span className="text-foreground">{formatFullDate(m.date)}</span>
          </div>
          {m.hasAttachments && m.attachments && m.attachments.length > 0 && (
            <div className="mt-1 flex flex-col gap-1">
              {m.attachments.map((att, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 rounded border border-border/50 bg-muted/30 px-2 py-1"
                >
                  <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                    {att.filename}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatSize(att.size)}
                  </span>
                  {isPreviewable(att) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      disabled={loadingPreview === att.filename}
                      onClick={() => void handlePreviewAttachment(att)}
                      title="预览"
                    >
                      {loadingPreview === att.filename ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Eye className="h-3 w-3" />
                      )}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    disabled={downloading === att.filename}
                    onClick={() => void handleDownloadAttachment(att.filename)}
                    title="下载附件"
                  >
                    {downloading === att.filename ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Download className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 scrollbar-hover">
        {!m.bodyFetched || (!m.bodyText && !m.bodyHtml) ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-muted-foreground">
            {m.bodyError ? (
              <>
                <span className="text-[13px] text-destructive">正文加载失败</span>
                <span className="max-w-md text-center text-[12px] text-muted-foreground">{m.bodyError}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 h-7 text-[12px]"
                  onClick={() => {
                    if (gatewayUrl && isOnline) {
                      // 清除错误状态后重试
                      useEmailStore.setState((state) => ({
                        messages: state.messages.map((mm) =>
                          mm.uid === m.uid && mm.accountId === m.accountId
                            ? { ...mm, bodyError: null }
                            : mm,
                        ),
                        selectedMessage:
                          state.selectedMessage?.uid === m.uid
                            ? { ...state.selectedMessage, bodyError: null }
                            : state.selectedMessage,
                      }));
                      void fetchBody(gatewayUrl, m);
                    }
                  }}
                >
                  重试
                </Button>
              </>
            ) : isOnline ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="ml-2 text-[13px]">正在加载正文...</span>
              </>
            ) : (
              <span className="text-[13px]">离线模式 — 正文未缓存，连接恢复后可加载</span>
            )}
          </div>
        ) : m.bodyHtml ? (
          <SafeHtmlFrame html={m.bodyHtml} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground">
            {m.bodyText || "(无正文)"}
          </pre>
        )}
      </div>
      {analysis || analysisLoading || analysisError ? (
        <MailAnalysisCard
          analysis={analysis}
          loading={analysisLoading}
          error={analysisError}
          collapsed={analysisCollapsed}
          onToggleCollapse={() => setAnalysisCollapsed((v) => !v)}
          onRun={handleRunAnalysis}
        />
      ) : null}
      {previewing && (
        <AttachmentPreviewModal
          filename={previewing.filename}
          dataUrl={previewing.dataUrl}
          contentType={previewing.contentType}
          onClose={() => setPreviewing(null)}
        />
      )}
    </div>
  );
}

/**
 * 附件预览模态框：图片直接显示，PDF 用 iframe 内嵌。
 */
function AttachmentPreviewModal({
  filename,
  dataUrl,
  contentType,
  onClose,
}: {
  filename: string;
  dataUrl: string;
  contentType: string;
  onClose: () => void;
}) {
  const isImage = contentType.toLowerCase().startsWith("image/");
  const isPdf = contentType.toLowerCase() === "application/pdf";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="flex h-[90vh] w-[90vw] max-w-[1000px] flex-col rounded-lg bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <Eye className="h-4 w-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{filename}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {isImage ? (
            <div className="flex h-full items-center justify-center">
              <img
                src={dataUrl}
                alt={filename}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : isPdf ? (
            <iframe
              src={dataUrl}
              className="h-full w-full border-0"
              title={filename}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <span className="text-[13px]">不支持预览此文件类型</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 用 sandbox iframe 渲染邮件 HTML，脚本完全隔离无法执行。
 * allow-same-origin 让父页面可读取 contentDocument 调整高度（不带 allow-scripts，脚本仍不能跑）。
 */
function SafeHtmlFrame({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(400);

  // 注入 CSS 强制自动换行，防止邮件 HTML 中 nowrap/pre 导致横向溢出
  const wrappedHtml = useMemo(() => {
    const wrapCss = `<style>
      html, body { margin: 0 !important; padding: 0 !important; }
      body { word-wrap: break-word !important; overflow-wrap: break-word !important; white-space: normal !important; }
      pre, code { white-space: pre-wrap !important; word-wrap: break-word !important; overflow-wrap: break-word !important; }
      table { table-layout: auto !important; word-break: break-word !important; }
      img { max-width: 100% !important; height: auto !important; }
      div, p, span, td, th { word-wrap: break-word !important; overflow-wrap: break-word !important; }
    </style>`;
    // referrer policy：加载网络图片时不带 Referer，避免部分图床防盗链 403
    const referrerMeta = `<meta name="referrer" content="no-referrer">`;
    if (html.includes("</head>")) {
      return html.replace("</head>", `${referrerMeta}${wrapCss}</head>`);
    }
    if (html.includes("<body")) {
      return `${referrerMeta}${wrapCss}${html}`;
    }
    return `${referrerMeta}${wrapCss}${html}`;
  }, [html]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const adjustHeight = () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        const h = doc.body?.scrollHeight ?? doc.documentElement?.scrollHeight ?? 400;
        setHeight(Math.max(h, 100));
      } catch {
        // 跨域访问失败时保持默认高度
      }
    };

    // 初次加载调整
    const timer1 = window.setTimeout(adjustHeight, 50);
    // 图片等资源加载后再次调整
    const timer2 = window.setTimeout(adjustHeight, 500);
    const timer3 = window.setTimeout(adjustHeight, 1500);

    // 监听 iframe 内部 DOM 变化（资源加载导致的重排）
    let observer: MutationObserver | null = null;
    try {
      const doc = iframe.contentDocument;
      if (doc) {
        observer = new MutationObserver(() => adjustHeight());
        observer.observe(doc.body ?? doc.documentElement, {
          childList: true,
          subtree: true,
          attributes: false,
        });
      }
    } catch {
      // ignore
    }

    return () => {
      window.clearTimeout(timer1);
      window.clearTimeout(timer2);
      window.clearTimeout(timer3);
      observer?.disconnect();
    };
  }, [wrappedHtml]);

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-same-origin"
      srcDoc={wrappedHtml}
      scrolling="no"
      onLoad={() => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        try {
          const doc = iframe.contentDocument;
          if (!doc) return;
          const h = doc.body?.scrollHeight ?? doc.documentElement?.scrollHeight ?? 400;
          setHeight(Math.max(h, 100));
        } catch {
          // ignore
        }
      }}
      className="w-full border-0"
      style={{ height: `${height}px`, minHeight: "200px", overflow: "hidden" }}
      title="邮件正文"
    />
  );
}

function formatSender(fromName: string | null | undefined, fromAddress: string): string {
  const name = (fromName || "").trim();
  const addr = (fromAddress || "").trim();
  if (name && addr) {
    return `${name} <${addr}>`;
  }
  return name || addr || "(未知发件人)";
}

export function formatFullDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// AI 内容分析卡片（人工单次触发，不自动介入）
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, string> = {
  work: "工作",
  personal: "私人",
  finance: "财务",
  notification: "通知",
  marketing: "营销",
  social: "社交",
};

const INTENT_LABELS: Record<string, string> = {
  needs_reply: "需回复",
  needs_action: "需处理",
  notify_only: "仅通知",
  needs_approval: "需审批",
  spam: "垃圾邮件",
};

const URGENCY_LABELS: Record<string, string> = {
  high: "高",
  normal: "中",
  low: "低",
};

const URGENCY_STYLES: Record<string, string> = {
  high: "bg-red-500/15 text-red-600 dark:text-red-400",
  normal: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  low: "bg-muted text-muted-foreground",
};

const SENTIMENT_LABELS: Record<string, string> = {
  positive: "积极",
  neutral: "中性",
  negative: "消极",
};

function parseKeyInfo(raw: string): EmailKeyInfo | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      dates: parsed.dates ?? [],
      amounts: parsed.amounts ?? [],
      deadlines: parsed.deadlines ?? [],
      links: parsed.links ?? [],
    };
  } catch {
    return null;
  }
}

interface MailAnalysisCardProps {
  analysis: EmailAnalysis | null;
  loading: boolean;
  error: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onRun: () => void;
}

function MailAnalysisCard({
  analysis,
  loading,
  error,
  collapsed,
  onToggleCollapse,
  onRun,
}: MailAnalysisCardProps) {
  // 加载中
  if (loading && !analysis) {
    return (
      <div className="shrink-0 border-t border-border bg-muted/20 px-4 py-2.5">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在分析邮件内容...
        </div>
      </div>
    );
  }

  // 错误（无缓存结果）
  if (error && !analysis) {
    return (
      <div className="shrink-0 border-t border-destructive/30 bg-destructive/5 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-destructive">
            {error}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 text-[11px] text-destructive hover:text-destructive"
            onClick={onRun}
            disabled={loading}
          >
            <RefreshCw className="h-3 w-3" />
            重试
          </Button>
        </div>
      </div>
    );
  }

  // 有分析结果（或加载中刷新）
  const keyInfo = analysis ? parseKeyInfo(analysis.keyInfo) : null;
  const hasKeyInfo =
    keyInfo &&
    (keyInfo.dates.length > 0 ||
      keyInfo.amounts.length > 0 ||
      keyInfo.deadlines.length > 0 ||
      keyInfo.links.length > 0);

  return (
    <div className="shrink-0 border-t border-border bg-violet-500/5">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-2">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-500" />
        <span className="text-[11.5px] font-semibold text-foreground">
          AI 内容分析
        </span>
        {analysis?.analyzedAt && (
          <span className="text-[10.5px] text-muted-foreground">
            {formatAnalysisTime(analysis.analyzedAt)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[10.5px] text-muted-foreground hover:text-foreground"
            onClick={onRun}
            disabled={loading}
            title="重新分析"
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            重新分析
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            onClick={onToggleCollapse}
            aria-label={collapsed ? "展开" : "收起"}
          >
            {collapsed ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* 内容 */}
      {!collapsed && analysis && (
        <div className="flex flex-col gap-2 px-4 pb-3">
          {/* 摘要 */}
          <div className="text-[12.5px] leading-relaxed text-foreground">
            {analysis.summary}
          </div>

          {/* 标签行 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag variant="category">
              {CATEGORY_LABELS[analysis.category] ?? analysis.category}
            </Tag>
            <Tag variant="intent">
              {INTENT_LABELS[analysis.intent] ?? analysis.intent}
            </Tag>
            <Tag
              variant="urgency"
              className={URGENCY_STYLES[analysis.urgency] ?? URGENCY_STYLES.normal}
            >
              <span className="mr-1">⚡</span>
              {URGENCY_LABELS[analysis.urgency] ?? analysis.urgency}
            </Tag>
            <Tag variant="sentiment">
              {SENTIMENT_LABELS[analysis.sentiment] ?? analysis.sentiment}
            </Tag>
          </div>

          {/* 关键信息 */}
          {hasKeyInfo && keyInfo && (
            <div className="flex flex-col gap-1.5 rounded-md border border-border/50 bg-background/50 p-2.5">
              {keyInfo.dates.length > 0 && (
                <KeyInfoRow icon={<Calendar className="h-3 w-3" />} label="日期">
                  {keyInfo.dates.map((d, i) => (
                    <span key={i}>
                      {d.date}
                      {d.description ? ` - ${d.description}` : ""}
                    </span>
                  ))}
                </KeyInfoRow>
              )}
              {keyInfo.amounts.length > 0 && (
                <KeyInfoRow icon={<DollarSign className="h-3 w-3" />} label="金额">
                  {keyInfo.amounts.map((a, i) => (
                    <span key={i}>
                      {a.value}
                      {a.currency ? ` ${a.currency}` : ""}
                      {a.context ? ` (${a.context})` : ""}
                    </span>
                  ))}
                </KeyInfoRow>
              )}
              {keyInfo.deadlines.length > 0 && (
                <KeyInfoRow icon={<Flag className="h-3 w-3" />} label="截止">
                  {keyInfo.deadlines.map((d, i) => (
                    <span key={i}>
                      {d.date}
                      {d.task ? ` - ${d.task}` : ""}
                    </span>
                  ))}
                </KeyInfoRow>
              )}
              {keyInfo.links.length > 0 && (
                <KeyInfoRow icon={<LinkIcon className="h-3 w-3" />} label="链接">
                  {keyInfo.links.map((l, i) => (
                    <span key={i} className="truncate">
                      {l.url}
                      {l.description ? ` - ${l.description}` : ""}
                    </span>
                  ))}
                </KeyInfoRow>
              )}
            </div>
          )}

          {/* 刷新时的错误提示 */}
          {error && (
            <div className="flex items-center gap-1.5 text-[11px] text-destructive">
              <AlertCircle className="h-3 w-3" />
              上次重新分析失败：{error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Tag({
  children,
  variant,
  className = "",
}: {
  children: React.ReactNode;
  variant: "category" | "intent" | "urgency" | "sentiment";
  className?: string;
}) {
  const baseStyles: Record<string, string> = {
    category: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    intent: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
    urgency: "",
    sentiment: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
        baseStyles[variant] ?? ""
      } ${className}`}
    >
      {children}
    </span>
  );
}

function KeyInfoRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-1.5 text-[11.5px]">
      <span className="mt-0.5 flex shrink-0 items-center gap-1 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-foreground">
        {children}
      </span>
    </div>
  );
}

function formatAnalysisTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

// 保留 EmailMessage 类型引用以备扩展
export type { EmailMessage };
