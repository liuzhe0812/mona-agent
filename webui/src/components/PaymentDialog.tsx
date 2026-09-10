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
  pollCommand?: "poll_payment_status" | "get_credit_order_status";
  title?: string;
  successMessage?: string;
}

type PollStatus = "pending" | "processing" | "paid" | "failed" | "timeout";

export function PaymentDialog({
  open,
  orderId,
  paymentUrl,
  onSuccess,
  onCancel,
  pollCommand = "poll_payment_status",
  title = "支付宝支付",
  successMessage = "订阅已开通，正在刷新...",
}: PaymentDialogProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [status, setStatus] = useState<PollStatus>("pending");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [elapsed, setElapsed] = useState(0);
  const [querying, setQuerying] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const onSuccessRef = useRef(onSuccess);

  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  // 生成二维码
  useEffect(() => {
    if (!open || !paymentUrl) return;
    let active = true;
    setQrDataUrl("");
    QRCode.toDataURL(paymentUrl, { width: 240, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
      .then((url) => { if (active) setQrDataUrl(url); })
      .catch((e) => {
        console.error("QR code generation failed", e);
        if (active) setQrDataUrl("");
      });
    return () => { active = false; };
  }, [open, paymentUrl]);

  // 每个订单只保留一个查询；关闭或切换订单后忽略迟到的响应。
  useEffect(() => {
    if (!open || !orderId) return;
    let active = true;
    let inFlight = false;
    let paidSeen = false;
    let phase: PollStatus = "pending";
    let startedAt = Date.now();
    let lastReconciledAt = startedAt;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let successTimer: ReturnType<typeof setTimeout> | undefined;
    const updateStatus = (next: PollStatus) => {
      phase = next;
      setStatus(next);
    };
    updateStatus("pending");
    setErrorMsg("");
    setElapsed(0);
    setQuerying(false);

    const pollStatus = async (manual = false) => {
      if (!active || inFlight || phase === "paid") return;
      clearTimeout(pollTimer);
      if (manual && (phase === "timeout" || phase === "failed")) {
        startedAt = Date.now();
        setElapsed(0);
        updateStatus(paidSeen ? "processing" : "pending");
      }
      inFlight = true;
      setQuerying(true);
      try {
        if (!isTauri()) throw new Error("Payment status requires Mona desktop");
        const { invoke } = await import("@tauri-apps/api/core");
        if (!active) return;
        const reconcile = pollCommand === "get_credit_order_status"
          && (manual || Date.now() - lastReconciledAt >= 15_000);
        if (reconcile) lastReconciledAt = Date.now();
        const result = await invoke<{
          status: string;
          fulfillment_status?: string;
        }>(pollCommand, { orderId, ...(reconcile ? { reconcile: true } : {}) });
        if (!active) return;
        setErrorMsg("");
        if (result.status === "paid") {
          paidSeen = true;
          if (pollCommand !== "get_credit_order_status" || result.fulfillment_status === "succeeded") {
            updateStatus("paid");
            successTimer = setTimeout(() => onSuccessRef.current(), 1200);
          } else {
            updateStatus("processing");
            if (result.fulfillment_status === "failed") {
              setErrorMsg("付款已成功，余额暂未到账。正在重试，如长时间未到账请联系客服。");
            }
          }
        } else if (result.status === "failed") {
          updateStatus("failed");
          setErrorMsg("订单未完成。如已扣款，请刷新结果或联系客服核对。");
        } else if (result.status !== "pending") {
          throw new Error("Unrecognized payment status");
        }
      } catch (e) {
        if (!active) return;
        console.error("Payment status query failed", e);
        setErrorMsg("暂时无法查询支付结果，正在重试。也可手动刷新结果。");
      } finally {
        inFlight = false;
        if (active) {
          setQuerying(false);
          if (phase === "pending" || phase === "processing") {
            pollTimer = setTimeout(() => { void pollStatus(); }, 3000);
          }
        }
      }
    };

    refreshRef.current = () => { void pollStatus(true); };
    const onFocus = () => {
      if (phase === "pending" || phase === "processing") void pollStatus(true);
    };
    const timer = setInterval(() => {
      if (phase !== "pending" && phase !== "processing") return;
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(seconds);
      if (seconds >= 600) {
        updateStatus("timeout");
        setErrorMsg(paidSeen
          ? "付款已成功，余额尚未确认到账。请刷新结果或联系客服。"
          : "暂未确认支付结果。如已付款，请刷新结果或稍后查看充值记录。");
        clearTimeout(pollTimer);
      }
    }, 1000);
    window.addEventListener("focus", onFocus);
    void pollStatus();
    return () => {
      active = false;
      refreshRef.current = () => {};
      clearInterval(timer);
      clearTimeout(pollTimer);
      clearTimeout(successTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, [open, orderId, pollCommand]);

  const handleOpenInBrowser = useCallback(async () => {
    setErrorMsg("");
    if (!isTauri()) {
      window.open(paymentUrl, "_blank");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_payment_url", { url: paymentUrl });
    } catch (e) {
      console.error("open_payment_url failed", e);
      setErrorMsg("无法打开支付页面，请使用二维码完成支付");
    }
  }, [paymentUrl]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {status === "pending" ? "使用支付宝扫码完成支付" : "支付结果以服务器确认为准"}
          </DialogDescription>
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
              {errorMsg ? <p className="text-xs text-destructive">{errorMsg}</p> : null}
            </>
          )}

          {status === "processing" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="h-12 w-12 animate-spin text-muted-foreground" />
              <p className="text-title-sm font-medium">付款已成功，正在确认到账</p>
              <p className="text-sm text-muted-foreground">到账后将自动刷新余额，请勿重复付款。</p>
              {errorMsg ? <p role="status" className="text-xs text-destructive">{errorMsg}</p> : null}
            </div>
          )}

          {status === "paid" && (
            <div className="flex flex-col items-center gap-3 py-8">
              <CheckCircle2 className="h-16 w-16 text-green-500" />
              <p className="text-title-sm font-medium">支付成功</p>
              <p className="text-sm text-muted-foreground">{successMessage}</p>
            </div>
          )}

          {(status === "failed" || status === "timeout") && (
            <div className="flex flex-col items-center gap-3 py-8">
              <XCircle className="h-16 w-16 text-destructive" />
              <p className="text-title-sm font-medium">{status === "timeout" ? "支付结果待确认" : "订单未完成"}</p>
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
          {status !== "paid" && (
            <Button variant="outline" className="w-full" disabled={querying} onClick={() => refreshRef.current()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {querying ? "正在查询..." : status === "pending" ? "我已付款，刷新结果" : "刷新支付结果"}
            </Button>
          )}
          <Button variant="ghost" className="w-full" onClick={onCancel}>
            {status === "pending" ? "取消支付" : "关闭"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
