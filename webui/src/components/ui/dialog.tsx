import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 清理 Radix 浮层组件（Dialog/Sheet/AlertDialog）关闭后可能残留在 body 上的锁定状态。
 *
 * 根因：Radix Presence 依赖 animationend 事件来卸载 DialogOverlay/DialogContent。
 * 如果事件不触发，这些元素会以 data-state="closed" + pointer-events:auto 残留在 DOM 中，
 * 作为 fixed inset-0 z-50 的透明层挡住所有点击——即使 body 的 pointer-events 已恢复。
 *
 * 清理内容：
 * 1. body 上的 pointer-events/overflow/paddingRight/data-scroll-locked
 * 2. body 子元素的 aria-hidden/inert
 * 3. 残留的 Radix Portal 元素（data-state="closed" 且无 data-state="open" 的 Portal）
 */
function cleanupBodyLocks() {
  if (typeof document === "undefined") return;
  const body = document.body;
  if (!body) return;

  // 诊断日志：记录清理前的状态
  const beforePe = body.style.pointerEvents;
  const beforeOverflow = body.style.overflow;
  const closedOverlays = body.querySelectorAll('[data-state="closed"]');
  const openOverlays = body.querySelectorAll('[data-state="open"]');
  const radixPortals = body.querySelectorAll("[data-radix-portal]");
  if (closedOverlays.length > 0 || beforePe === "none") {
    console.warn("[cleanupBodyLocks] before:", {
      bodyPointerEvents: beforePe,
      bodyOverflow: beforeOverflow,
      bodyScrollLocked: body.hasAttribute("data-scroll-locked"),
      closedCount: closedOverlays.length,
      openCount: openOverlays.length,
      portalCount: radixPortals.length,
    });
  }

  // 1. 清理 body pointer-events（react-dismissable-layer 设置）
  if (body.style.pointerEvents === "none") {
    body.style.pointerEvents = "";
  }

  // 2. 清理 data-scroll-locked（react-remove-scroll-bar 设置）
  if (body.hasAttribute("data-scroll-locked")) {
    body.removeAttribute("data-scroll-locked");
  }

  // 3. 清理 inline overflow / paddingRight
  if (body.style.overflow === "hidden") {
    body.style.overflow = "";
  }
  if (body.style.paddingRight) {
    body.style.paddingRight = "";
  }

  // 4. 清理 aria-hidden（aria-hidden 包的 hideOthers）
  body.querySelectorAll("[data-aria-hidden]").forEach((el) => {
    el.removeAttribute("aria-hidden");
    el.removeAttribute("data-aria-hidden");
  });

  // 5. 清理 inert（aria-hidden 包的 inertOthers）
  body.querySelectorAll("[data-inert-ed]").forEach((el) => {
    el.removeAttribute("inert");
    el.removeAttribute("data-inert-ed");
  });

  // 6. 关键修复：处理残留的 Radix Portal 元素
  //    如果 Presence 没有卸载 DialogOverlay/DialogContent，它们会以
  //    data-state="closed" + pointer-events:auto 残留在 DOM 中，
  //    作为 fixed inset-0 z-50 的透明层挡住所有点击。
  //    检查每个 Portal：如果没有 data-state="open" 的子元素，说明该 Portal
  //    中的浮层已关闭但未被卸载，将其 display 设为 none 使其不再拦截交互。
  body.querySelectorAll("[data-radix-portal]").forEach((portal) => {
    const hasOpen = portal.querySelector('[data-state="open"]');
    const hasClosed = portal.querySelector('[data-state="closed"]');
    if (!hasOpen && hasClosed) {
      // Portal 中只有已关闭的浮层，Presence 未正确卸载
      console.warn("[cleanupBodyLocks] removing stuck Radix portal:", portal);
      // 直接移除 DOM 元素。安全的原因：
      // - Presence 已卡在 unmountSuspended 状态，React 不会重新渲染该组件
      // - 用户再次打开 Dialog 时 Radix 会创建新的 Portal
      portal.remove();
    }
  });

  // 诊断日志：记录清理后的状态
  const afterPe = body.style.pointerEvents;
  const afterPortals = body.querySelectorAll("[data-radix-portal]").length;
  if (closedOverlays.length > 0 || beforePe === "none") {
    console.warn("[cleanupBodyLocks] after:", {
      bodyPointerEvents: afterPe,
      portalCount: afterPortals,
    });
  }
}

const Dialog = ({ onOpenChange, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) => {
  const handleOpenChange = (open: boolean) => {
    onOpenChange?.(open);
    if (!open) {
      // 关闭后清理 body 残留的 pointer-events:none。
      // 根因：从 ContextMenu 打开 Dialog 时，ContextMenu 的 DismissableLayer 在
      // Dialog 打开后才卸载，它保存的 originalBodyPointerEvents 是 "none"（被 Dialog 设置的），
      // 卸载时会"恢复"成 "none"，覆盖我们的清理。
      // 解决：在多个时机清理，确保覆盖 ContextMenu 卸载的时间窗口。
      [50, 200, 400, 600, 1000].forEach((delay) => {
        window.setTimeout(() => {
          if (document.body.style.pointerEvents === "none") {
            document.body.style.pointerEvents = "";
          }
        }, delay);
      });
    }
  };
  return <DialogPrimitive.Root onOpenChange={handleOpenChange} {...props} />;
};

// 全局监控：用 MutationObserver 监听 body style 变化，
// 如果 pointer-events 被设为 none 且当前没有打开的 Radix 浮层，则立即清理。
// 这是对 onOpenChange 延迟清理的最终兜底，覆盖所有可能的竞态场景。
if (typeof window !== "undefined") {
  const observer = new MutationObserver(() => {
    if (document.body.style.pointerEvents === "none") {
      // 检查是否有打开的 Radix 浮层（Dialog/AlertDialog/Sheet/Menu）
      const hasOpenOverlay = document.querySelector(
        '[data-state="open"][role="dialog"], [data-state="open"][role="alertdialog"], [data-state="open"][role="menu"]'
      );
      if (!hasOpenOverlay) {
        // 没有打开的浮层，但 body.pointerEvents 是 none，这是残留状态，清理它
        document.body.style.pointerEvents = "";
      }
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ["style"] });
}
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  showCloseButton?: boolean;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, showCloseButton = true, ...props }, ref) => {
  // 安全网：DialogContent 卸载时清理 body 残留状态。
  // 这是 Dialog onOpenChange 延迟清理的兜底：如果 Presence 正确卸载了组件，
  // 此处会立即清理；如果 Presence 未卸载组件，onOpenChange 的延迟清理会兜底。
  React.useEffect(() => {
    return () => {
      cleanupBodyLocks();
    };
  }, []);
  return (
    <DialogPortal>
      <DialogOverlay />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            "grid w-full max-w-lg origin-center gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-2xl",
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton ? (
            <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className,
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  cleanupBodyLocks,
};
