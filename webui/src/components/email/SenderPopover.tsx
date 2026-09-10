import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Edit3, Loader2, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { openComposeWindow } from "./lib/emailApi";
import { searchContacts, updateContact } from "./contacts/lib/contactsApi";
import { getAllEmails, type Contact } from "./contacts/lib/types";
import { useEmailStore } from "./store/emailStore";

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
 * 弹窗用 Portal + fixed 定位渲染到 body，避免被父容器 overflow 裁剪。
 */
export function SenderPopover({
  displayName,
  email,
  accountId,
  inContacts,
  children,
}: SenderPopoverProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loadingContact, setLoadingContact] = useState(false);
  const [saving, setSaving] = useState(false);
  const [contact, setContact] = useState<Contact | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (open) return;
    setEditing(false);
    setContact(null);
    setError("");
  }, [open]);

  // 计算弹窗位置
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const style: React.CSSProperties = {
      position: "fixed",
      left: rect.left,
      top: rect.bottom + 4,
      zIndex: 9999,
    };
    // 防止溢出右边
    const popupWidth = 300;
    if (rect.left + popupWidth > window.innerWidth) {
      style.left = window.innerWidth - popupWidth - 8;
    }
    setPopupStyle(style);
  }, [open]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        !(target as HTMLElement).closest("[data-sender-popup]")
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

  const handleEdit = async () => {
    setLoadingContact(true);
    setError("");
    try {
      const target = email.trim().toLowerCase();
      const matches = await searchContacts(email, 50);
      const matched = matches.find((item) =>
        getAllEmails(item).some((address) => address.trim().toLowerCase() === target),
      );
      if (!matched) throw new Error("没有找到对应的联系人记录");
      setContact(matched);
      setNameDraft(matched.displayName);
      setEmailDraft(matched.email ?? email);
      setEditing(true);
    } catch (reason) {
      setError(String(reason).replace(/^Error:\s*/, ""));
    } finally {
      setLoadingContact(false);
    }
  };

  const handleSave = async () => {
    const name = nameDraft.trim();
    const address = emailDraft.trim();
    if (!contact || !name || !address) {
      setError("名称和邮箱不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await updateContact(contact.id, { displayName: name, email: address });
      useEmailStore.setState({ contactsLoaded: false });
      await useEmailStore.getState().loadContacts();
      setEditing(false);
      setOpen(false);
    } catch (reason) {
      setError(String(reason).replace(/^Error:\s*/, ""));
    } finally {
      setSaving(false);
    }
  };

  if (!inContacts || !email) {
    return <span className="text-foreground">{children ?? displayName}</span>;
  }

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }
        }}
        className="cursor-pointer text-primary"
        title="点击查看联系人信息"
      >
        {children ?? displayName}
      </span>
      {open &&
        createPortal(
          <div
            data-sender-popup
            style={popupStyle}
            className="w-[300px] rounded-xl border border-border bg-popover p-3 shadow-lg"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setOpen(false)}
              className="absolute right-2 top-2 h-6 w-6 text-muted-foreground hover:text-foreground"
              aria-label="关闭"
            >
              <X className="h-3.5 w-3.5" />
            </Button>

            {editing ? (
              <div className="grid gap-2 pr-6">
                <label className="grid gap-1 text-micro text-muted-foreground">
                  名称
                  <Input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} className="h-8 text-ui" autoFocus />
                </label>
                <label className="grid gap-1 text-micro text-muted-foreground">
                  邮箱
                  <Input value={emailDraft} onChange={(event) => setEmailDraft(event.target.value)} className="h-8 text-ui" inputMode="email" />
                </label>
              </div>
            ) : (
              <div className="pr-6">
                <div className="select-text break-words text-body font-medium text-foreground">
                  {displayName || "(未知姓名)"}
                </div>
                <div className="mt-0.5 select-text break-all text-caption text-muted-foreground">
                  {email}
                </div>
              </div>
            )}

            {error ? <p className="mt-2 text-micro text-destructive" role="alert">{error}</p> : null}

            <div className="mt-3 flex justify-end gap-1.5">
              {editing ? (
                <>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-caption" onClick={() => { setEditing(false); setError(""); }} disabled={saving}>取消</Button>
                  <Button size="sm" className="h-7 gap-1.5 px-2 text-caption" onClick={() => void handleSave()} disabled={saving}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    保存
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-caption" onClick={() => void handleEdit()} disabled={loadingContact}>
                    {loadingContact ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Edit3 className="h-3.5 w-3.5" />}
                    编辑
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-caption" onClick={handleWriteMail} disabled={!accountId}>
                    <Mail className="h-3.5 w-3.5" />
                    写邮件
                  </Button>
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
