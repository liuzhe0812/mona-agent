import { useEffect, useRef, useState } from "react";
import { Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openComposeWindow } from "./lib/emailApi";

interface SenderPopoverProps {
  /** 显示的名称 */
  displayName: string;
  /** 邮箱地址 */
  email: string;
  /** 当前账号 ID（用于写邮件时确定发件账号） */
  accountId: string | null;
  /** 是否在通讯录中（控制是否可点击） */
  inContacts: boolean;
  /** 子元素（可选，不传则显示 displayName） */
  children?: React.ReactNode;
}

/**
 * 发件人/收件人名称点击弹窗。
 * 仅当 inContacts 为 true 时可点击，弹窗显示姓名、邮箱地址、写邮件按钮。
 */
export function SenderPopover({
  displayName,
  email,
  accountId,
  inContacts,
  children,
}: SenderPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const handleWriteMail = async () => {
    if (!accountId) return;
    try {
      await openComposeWindow({
        mode: "compose",
        accountId,
        presetTo: email,
      });
      setOpen(false);
    } catch (err) {
      console.error("[SenderPopover] 打开写邮件窗口失败:", err);
    }
  };

  if (!inContacts || !email) {
    // 不在通讯录中或无邮箱：不可点击，直接显示
    return <span className="text-foreground">{children ?? displayName}</span>;
  }

  return (
    <span ref={containerRef} className="relative inline-block">
      <span
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="cursor-pointer text-primary underline-offset-2 hover:underline"
        title="点击查看联系人信息"
      >
        {children ?? displayName}
      </span>
      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-[260px] rounded-lg border border-border bg-popover p-3 shadow-md"
          style={{ minWidth: "220px" }}
        >
          {/* 关闭按钮 */}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-2 top-2 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>

          {/* 姓名 */}
          <div className="pr-6">
            <div className="truncate text-sm font-medium text-foreground">
              {displayName || "(未知姓名)"}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {email}
            </div>
          </div>

          {/* 写邮件按钮 */}
          <div className="mt-3 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={handleWriteMail}
              disabled={!accountId}
            >
              <Mail className="h-3.5 w-3.5" />
              写邮件
            </Button>
          </div>
        </div>
      )}
    </span>
  );
}
