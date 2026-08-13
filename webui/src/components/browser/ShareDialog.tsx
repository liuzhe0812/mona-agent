import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import QRCode from "qrcode";
import { Share2, Copy, Check, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isTauri } from "@/lib/tauri";
import { browserGetPageInfo, type PageInfo } from "@/lib/browser-ipc";

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabId: string | null;
  url: string;
  title: string;
}

export function ShareDialog({ open, onOpenChange, tabId, url, title }: ShareDialogProps) {
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrSvg, setQrSvg] = useState<string>("");

  const loadPageInfo = useCallback(async () => {
    if (!tabId || !isTauri()) {
      setPageInfo({ url, title, description: "", ogImage: "" });
      return;
    }
    try {
      await browserGetPageInfo(tabId);
    } catch (e) {
      console.error("[ShareDialog] load page info failed:", e);
      setPageInfo({ url, title, description: "", ogImage: "" });
    }
  }, [tabId, url, title]);

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<{ id: string; info: PageInfo }>(
        "browser-page-info-result",
        (event) => {
          if (event.payload.id === tabId) {
            setPageInfo(event.payload.info);
          }
        }
      );
    };
    void setup();
    return () => { unlisten?.(); };
  }, [open, tabId]);

  useEffect(() => {
    if (open) {
      setPageInfo(null);
      void loadPageInfo();
    }
  }, [open, loadPageInfo]);

  // 本地生成二维码 SVG，无需外部 API，不依赖 Canvas
  useEffect(() => {
    const target = pageInfo?.url || url;
    if (!open || !target) {
      setQrSvg("");
      return;
    }
    QRCode.toString(target, {
      type: "svg",
      width: 200,
      margin: 1,
      errorCorrectionLevel: "M",
    })
      .then((svg) => {
        setQrSvg(svg.replace(/<svg/, '<svg class="h-48 w-48"'));
      })
      .catch((e) => {
        console.error("[ShareDialog] generate QR failed:", e);
        setQrSvg("");
      });
  }, [open, pageInfo, url]);

  const handleCopy = useCallback(async () => {
    const shareUrl = pageInfo?.url || url;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("[ShareDialog] copy failed:", e);
    }
  }, [pageInfo, url]);

  const handleOpenExternal = useCallback(() => {
    const shareUrl = pageInfo?.url || url;
    if (isTauri()) {
      // 通过系统默认浏览器打开
      import("@tauri-apps/plugin-opener").then((opener) => {
        opener.openUrl(shareUrl).catch(() => {});
      }).catch(() => {});
    }
  }, [pageInfo, url]);

  const shareUrl = pageInfo?.url || url;
  const shareTitle = pageInfo?.title || title;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-4 w-4" />
            分享页面
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4">
          {/* 二维码（本地生成） */}
          <div className="rounded-lg border p-3 bg-white h-48 w-48 flex items-center justify-center">
            {qrSvg ? (
              <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
            ) : (
              <span className="text-caption text-muted-foreground">生成二维码...</span>
            )}
          </div>
          <p className="text-caption text-muted-foreground text-center">
            扫描二维码访问此页面
          </p>

          {/* 页面标题 */}
          {shareTitle && (
            <p className="text-body font-medium text-center line-clamp-2">{shareTitle}</p>
          )}

          {/* URL 输入框 */}
          <div className="flex items-center gap-2 w-full">
            <Input
              value={shareUrl}
              readOnly
              className="h-8 text-ui rounded-full"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopy}
              className="h-8 w-8 shrink-0"
              title="复制链接"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-success" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={handleOpenExternal}
              className="h-8 w-8 shrink-0"
              title="在系统浏览器中打开"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
