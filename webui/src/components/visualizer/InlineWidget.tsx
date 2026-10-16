import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clipboard, Code2, Download, ImageDown, LoaderCircle, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadTextFile } from "@/components/notes/mindmap/mindmap-export";
import { downloadMediaUrl } from "@/lib/tauri";
import {
  createWidgetSrcDoc,
  createStandaloneWidgetHtml,
  isTrustedVisualizerMessage,
  sanitizeForIframe,
  sanitizeForStreaming,
} from "./widget-sandbox";

export type InlineWidgetProps = {
  id: string;
  title?: string;
  code: string;
  loadingMessages?: string[];
  streaming?: boolean;
  error?: string;
  onSendPrompt?: (text: string) => void;
  onOpenLink?: (url: string) => void;
};

type WidgetTheme = Record<string, string | boolean>;
type WidgetMessage = { channel?: unknown; type?: unknown; [key: string]: unknown };

const themeTokenNames = [
  "background",
  "foreground",
  "card",
  "muted",
  "muted-foreground",
  "border",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "ring",
  "editor-surface",
  "data-1",
  "data-2",
  "data-3",
  "data-4",
  "data-5",
  "data-6",
] as const;

function createChannelToken(): string {
  const bytes = new Uint8Array(24);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readTheme(): WidgetTheme {
  const root = document.documentElement;
  const computed = window.getComputedStyle(root);
  const theme: WidgetTheme = { dark: root.classList.contains("dark") };
  themeTokenNames.forEach((name) => {
    const value = computed.getPropertyValue(`--${name}`).trim();
    if (value) theme[name] = value;
  });
  return theme;
}

function widgetFileBase(title: string | undefined): string {
  const safe = (title || "图形").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60);
  return safe || "图形";
}

function safeLinkForHost(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function isPngDataUrl(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 24_000_000
    && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value);
}

export function InlineWidget({
  id,
  title,
  code,
  loadingMessages = [],
  streaming = false,
  error,
  onSendPrompt,
  onOpenLink,
}: InlineWidgetProps) {
  const { t } = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frameReadyRef = useRef(false);
  const translateRef = useRef(t);
  translateRef.current = t;
  const channelRef = useRef<string>("");
  if (!channelRef.current) channelRef.current = createChannelToken();
  const channel = channelRef.current;
  const srcDoc = useMemo(() => createWidgetSrcDoc(channel), [channel]);
  const latestRef = useRef({ code, title, streaming, error, onSendPrompt, onOpenLink });
  latestRef.current = { code, title, streaming, error, onSendPrompt, onOpenLink };
  const [frameReady, setFrameReady] = useState(false);
  const [frameError, setFrameError] = useState(false);
  const [frameHeight, setFrameHeight] = useState(20);
  const [showSource, setShowSource] = useState(false);
  const [status, setStatus] = useState("");
  const [pendingLink, setPendingLink] = useState<string>();
  const pendingExportRef = useRef<"png" | "svg" | null>(null);

  const send = useCallback((type: string, value?: Record<string, unknown>) => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return false;
    try {
      frame.contentWindow.postMessage({ channel, type, ...value }, "*");
      return true;
    } catch {
      return false;
    }
  }, [channel]);

  const sendTheme = useCallback(() => {
    send("theme", { theme: readTheme() });
  }, [send]);

  const sendLatestCode = useCallback(() => {
    const current = latestRef.current;
    const sent = send(current.streaming || current.error ? "update" : "finalize", {
      code: current.error ? "" : current.streaming ? sanitizeForStreaming(current.code) : sanitizeForIframe(current.code),
    });
    if (!sent) setFrameError(true);
  }, [send]);

  useLayoutEffect(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    frameReadyRef.current = false;
    setFrameReady(false);
    setFrameError(false);
    const failTimer = window.setTimeout(() => {
      if (!frameReadyRef.current) setFrameError(true);
    }, 5000);
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });

    const handleMessage = (event: MessageEvent<WidgetMessage>) => {
      if (!isTrustedVisualizerMessage(event, frame, channel)) return;
      const message = event.data;
      switch (message.type) {
        case "ready":
          if (frameReadyRef.current) return;
          frameReadyRef.current = true;
          setFrameReady(true);
          setFrameError(false);
          window.clearTimeout(failTimer);
          sendTheme();
          break;
        case "resize": {
          const height = Number(message.height);
          if (!Number.isFinite(height)) return;
          setFrameHeight(Math.min(2000, Math.max(20, Math.round(height))));
          break;
        }
        case "prompt": {
          const text = typeof message.text === "string" ? message.text.trim().slice(0, 500) : "";
          if (text) latestRef.current.onSendPrompt?.(text);
          break;
        }
        case "link": {
          const url = safeLinkForHost(message.url);
          if (url) setPendingLink(url);
          break;
        }
        case "png": {
          if (pendingExportRef.current !== "png") return;
          pendingExportRef.current = null;
          if (!isPngDataUrl(message.dataUrl)) {
            setStatus(translateRef.current("visualizer.export.failed", { defaultValue: "导出失败，请稍后重试" }));
            return;
          }
          void downloadMediaUrl(message.dataUrl, `${widgetFileBase(latestRef.current.title)}.png`)
            .then(() => setStatus(translateRef.current("visualizer.export.pngDone", { defaultValue: "PNG 已导出" })))
            .catch(() => setStatus(translateRef.current("visualizer.export.failed", { defaultValue: "导出失败，请稍后重试" })));
          break;
        }
        case "svg": {
          if (pendingExportRef.current !== "svg") return;
          pendingExportRef.current = null;
          if (typeof message.code !== "string") {
            setStatus(translateRef.current("visualizer.export.failed", { defaultValue: "导出失败，请稍后重试" }));
            return;
          }
          const svg = sanitizeForStreaming(message.code);
          if (!/^\s*<svg\b/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) {
            setStatus(translateRef.current("visualizer.export.failed", { defaultValue: "导出失败，请稍后重试" }));
            return;
          }
          void downloadTextFile(svg, `${widgetFileBase(latestRef.current.title)}.svg`, "image/svg+xml")
            .then(() => setStatus(translateRef.current("visualizer.export.svgDone", { defaultValue: "SVG 已导出" })))
            .catch(() => setStatus(translateRef.current("visualizer.export.failed", { defaultValue: "导出失败，请稍后重试" })));
          break;
        }
        case "error":
          {
            const failedExport = pendingExportRef.current;
          pendingExportRef.current = null;
            if (failedExport === "png") {
              setStatus(translateRef.current("visualizer.export.pngFailed", { defaultValue: "无法导出 PNG，请检查图形中的外部资源" }));
            } else if (failedExport === "svg") {
              setStatus(translateRef.current("visualizer.export.svgFailed", { defaultValue: "无法导出 SVG，请查看图形源码" }));
            } else {
              setStatus(translateRef.current("visualizer.render.failed", { defaultValue: "图形暂时无法显示，请查看源码" }));
            }
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", handleMessage);
    frame.contentWindow?.postMessage({ channel, type: "hello" }, "*");
    return () => {
      window.clearTimeout(failTimer);
      observer.disconnect();
      window.removeEventListener("message", handleMessage);
      frameReadyRef.current = false;
    };
  // The channel is stable for this mounted iframe; current props are read through latestRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, sendLatestCode, sendTheme]);

  useLayoutEffect(() => {
    if (frameReady) sendLatestCode();
  }, [code, streaming, error, frameReady, sendLatestCode]);

  const copySource = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setStatus(t("visualizer.source.copied", { defaultValue: "源码已复制" }));
    } catch {
      setStatus(t("visualizer.source.copyFailed", { defaultValue: "无法复制源码" }));
    }
  }, [code, t]);

  const exportHtml = useCallback(async () => {
    try {
      const html = createStandaloneWidgetHtml(code);
      await downloadTextFile(html, `${widgetFileBase(title)}.html`, "text/html");
      setStatus(t("visualizer.export.htmlDone", { defaultValue: "HTML 已导出" }));
    } catch {
      setStatus(t("visualizer.export.failed", { defaultValue: "导出失败，请稍后重试" }));
    }
  }, [code, title, t]);

  const exportPng = useCallback(() => {
    if (!frameReady || streaming) return;
    pendingExportRef.current = "png";
    setStatus(t("visualizer.export.pngWorking", { defaultValue: "正在导出 PNG…" }));
    if (!send("export-png")) {
      pendingExportRef.current = null;
      setStatus(t("visualizer.export.pngFailed", { defaultValue: "无法导出 PNG，请检查图形中的外部资源" }));
    }
  }, [frameReady, send, streaming, t]);

  const exportSvg = useCallback(() => {
    if (!frameReady || streaming) return;
    pendingExportRef.current = "svg";
    setStatus(t("visualizer.export.svgWorking", { defaultValue: "正在导出 SVG…" }));
    if (!send("export-svg")) {
      pendingExportRef.current = null;
      setStatus(t("visualizer.export.svgFailed", { defaultValue: "无法导出 SVG，请查看图形源码" }));
    }
  }, [frameReady, send, streaming, t]);

  const displayTitle = title?.trim() || t("visualizer.title", { defaultValue: "图形" });
  const loadingText = loadingMessages.map((message) => message.trim()).filter(Boolean).at(-1)
    || t("visualizer.status.generating", { defaultValue: "正在生成图形…" });
  const hasSvg = /<svg\b/i.test(code);
  const displayError = error || (frameError
    ? t("visualizer.render.timeout", { defaultValue: "图形暂时无法显示，请查看源码" })
    : "");

  return (
    <section className="my-3 min-w-0" aria-label={displayTitle} data-widget-id={id}>
      <header className="mb-1 flex min-w-0 items-center gap-1.5">
        {streaming ? <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
        <span className="min-w-0 truncate text-ui font-medium text-foreground">{displayTitle}</span>
        {streaming ? <span className="min-w-0 truncate text-caption text-muted-foreground">{loadingText}</span> : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto size-7 shrink-0"
              aria-label={t("visualizer.actions.label", { defaultValue: "图形操作" })}
              title={t("visualizer.actions.label", { defaultValue: "图形操作" })}
            >
              <Download aria-hidden="true" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onSelect={() => setShowSource((visible) => !visible)}>
              <Code2 aria-hidden="true" />
              {showSource
                ? t("visualizer.source.hide", { defaultValue: "收起源码" })
                : t("visualizer.source.view", { defaultValue: "查看源码" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copySource()}>
              <Clipboard aria-hidden="true" />
              {t("visualizer.source.copy", { defaultValue: "复制源码" })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void exportHtml()} disabled={!code}>
              <Download aria-hidden="true" />
              {t("visualizer.export.html", { defaultValue: "下载 HTML" })}
            </DropdownMenuItem>
            {hasSvg ? (
              <DropdownMenuItem onSelect={exportSvg} disabled={!frameReady || streaming}>
                <Share2 aria-hidden="true" />
                {t("visualizer.export.svg", { defaultValue: "下载 SVG" })}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={exportPng} disabled={!frameReady || streaming}>
              <ImageDown aria-hidden="true" />
              {t("visualizer.export.png", { defaultValue: "下载 PNG" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {displayError ? (
        <p role="alert" className="mb-1 text-caption text-destructive">{displayError}</p>
      ) : null}
      {status ? <p role="status" className="mb-1 text-caption text-muted-foreground">{status}</p> : null}
      {pendingLink ? <Button variant="link" size="sm" className="max-w-full truncate px-0"
        onClick={() => { onOpenLink?.(pendingLink); setPendingLink(undefined); }}>
        {t("visualizer.openLink", { defaultValue: "打开链接" })}：{pendingLink}
      </Button> : null}
      <iframe
        ref={iframeRef}
        title={displayTitle}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => iframeRef.current?.contentWindow?.postMessage({ channel, type: "hello" }, "*")}
        className="block w-full rounded-md border border-border bg-background"
        style={{ height: `${frameHeight + 2}px` }}
      />
      {showSource ? (
        <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-border bg-muted p-3 text-caption text-foreground">
          <code>{code}</code>
        </pre>
      ) : null}
      {!frameReady && !frameError && !displayError && !status ? (
        <span className="sr-only">{t("visualizer.status.loading", { defaultValue: "正在载入图形" })}</span>
      ) : null}
    </section>
  );
}

