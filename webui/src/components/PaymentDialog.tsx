import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, CheckCircle2, XCircle, ExternalLink, RefreshCw } from "lucide-react";
import { isTauri } from "@/lib/tauri";

export interface PaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: number | null;
  paymentUrl: string;
  paymentMethod: "alipay_page";
  onSuccess: () => void;
  onCancel: () => void;
}

type PollStatus = "pending" | "paid" | "failed" | "timeout";

export function PaymentDialog({
  open,
  orderId,
  paymentUrl,
  paymentMethod,
  onSuccess,
  onCancel,
}: PaymentDialogProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [status, setStatus] = useState<PollStatus>("pending");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 生成二维码
  useEffect(() => {
    if (!open || !paymentUrl) return;
    QRCode.toDataURL(paymentUrl, { width: 240, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
      .then(setQrDataUrl)
      .catch((e) => {
        console.error("QR code generation failed", e);
        setQrDataUrl("");
      });
  }, [open, paymentUrl]);

  // 计时器
  useEffect(() => {
    if (!open) return;
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [open]);

  // 轮询订单状态
  const pollStatus = useCallback(async () => {
    if (!orderId || !isTauri()) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ status: string; subscription?: { status: string } }>("poll_payment_status", { orderId });
      if (result.status === "paid") {
        setStatus("paid");
        if (pollRef.current) clearInterval(pollRef.current);
        setTimeout(() => onSuccess(), 1200);
      } else if (result.status === "failed") {
        setStatus("failed");
        setErrorMsg("支付失败，请重试");
        if (pollRef.current) clearInterval(pollRef.current);
      }
    } catch (e) {
      console.error("poll_payment_status failed", e);
    }
  }, [orderId, onSuccess]);

  useEffect(() => {
    if (!open || !orderId) return;
    setStatus("pending");
    setErrorMsg("");
    // 立即查一次
    pollStatus();
    pollRef.current = setInterval(pollStatus, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [open, orderId, pollStatus]);

  // 超时处理（10 分钟）
  useEffect(() => {
    if (elapsed >= 600 && status === "pending") {
      setStatus("timeout");
      setErrorMsg("支付超时，请重新发起");
      if (pollRef.current) clearInterval(pollRef.current);
    }
  }, [elapsed, status]);

  const handleOpenInBrowser = useCallback(async () => {
    if (!isTauri()) {
      window.open(paymentUrl, "_blank");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_external_url", { url: paymentUrl });
    } catch (e) {
      console.error("open_external_url failed", e);
      window.open(paymentUrl, "_blank");
    }
  }, [paymentUrl]);

  const handleRetry = () => {
    setStatus("pending");
    setErrorMsg("");
    setElapsed(0);
    pollStatus();
    pollRef.current = setInterval(pollStatus, 3000);
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>支付宝支付</DialogTitle>
          <DialogDescription>使用支付宝扫码完成支付</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {status === "pending" && (
            <>
              <div className="relative">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="支付二维码" className="h-60 w-60 rounded-lg border" />
                ) : (
                  <div className="flex h-60 w-60 items-center justify-center rounded-lg border bg-muted">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>等待支付完成...</span>
                <span className="font-mono">{formatTime(elapsed)}</span>
              </div>
              <p className="text-xs text-muted-foreground text-center">
                请使用支付宝 App 扫描二维码完成支付
              </p>
            </>
          )}

          {status === "paid" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <CheckCircle2 className="h-16 w-16 text-green-500" />
              <p className="text-lg font-medium">支付成功</p>
              <p className="text-sm text-muted-foreground">订阅已开通，正在刷新...</p>
            </div>
          )}

          {(status === "failed" || status === "timeout") && (
            <div className="flex flex-col items-center gap-3 py-8">
              <XCircle className="h-16 w-16 text-destructive" />
              <p className="text-lg font-medium">支付未完成</p>
              <p className="text-sm text-muted-foreground">{errorMsg}</p>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {status === "pending" && (
            <Button variant="outline" className="w-full" onClick={handleOpenInBrowser}>
              <ExternalLink className="mr-2 h-4 w-4" />
              在浏览器中付款
            </Button>
          )}
          {(status === "failed" || status === "timeout") && (
            <Button variant="outline" className="w-full" onClick={handleRetry}>
              <RefreshCw className="mr-2 h-4 w-4" />
              重新查询
            </Button>
          )}
          <Button variant="ghost" className="w-full" onClick={onCancel}>
            {status === "paid" ? "关闭" : "取消支付"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
