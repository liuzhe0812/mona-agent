import { useEffect, useRef, useState } from "react";
import {
  Send,
  Loader2,
  Save,
  Paperclip,
  Image as ImageIcon,
  Camera,
  ChevronDown,
  X,
  File as FileIcon,
  FileText,
  Clock,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useEmailStore } from "./store/emailStore";
import { sendEmail, saveDraft, fetchEmailBody, type EmailAttachmentInput } from "./lib/emailApi";
import { EmailRichEditor, type EmailRichEditorHandle } from "./EmailRichEditor";
import { ContactPicker } from "./contacts/ContactPicker";
import type { EmailAccount, EmailMessage, EmailSignature } from "./lib/types";

export type ComposerMode = "compose" | "reply" | "replyAll" | "forward";

interface MailComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gatewayUrl: string;
  mode?: ComposerMode;
  baseMessage?: EmailMessage | null;
  account?: EmailAccount | null;
  standalone?: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToHtmlParagraphs(text: string): string {
  return escapeHtml(text)
    .split("\n")
    .map((line) => (line.trim() === "" ? "<br>" : line))
    .join("<br>");
}

/** Foxmail 风格回复/转发：顶部空段落（光标位置）+ 分隔线 + 原文引用 */
function formatReplyHeaderHtml(message: EmailMessage): string {
  const date = new Date(message.date).toLocaleString("zh-CN");
  const sender = message.fromName
    ? `${message.fromName} &lt;${message.fromAddress}&gt;`
    : message.fromAddress;
  const to = message.toAddresses || "";
  const cc = message.ccAddresses || "";
  const subject = message.subject || "";

  // 优先用 HTML 正文，否则用纯文本转换
  let quotedBody = "";
  if (message.bodyHtml) {
    // 去掉 HTML 的 html/head/body 包裹，只保留内容
    quotedBody = message.bodyHtml
      .replace(/<!DOCTYPE[^>]*>/gi, "")
      .replace(/<html[^>]*>/gi, "")
      .replace(/<\/html>/gi, "")
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
      .replace(/<body[^>]*>/gi, "")
      .replace(/<\/body>/gi, "")
      .trim();
  } else if (message.bodyText) {
    quotedBody = textToHtmlParagraphs(message.bodyText.slice(0, 50000));
  }

  const headerLines: string[] = [
    `----- 原始邮件 -----`,
    `发件人：${sender}`,
  ];
  if (to) headerLines.push(`收件人：${escapeHtml(to)}`);
  if (cc) headerLines.push(`抄送：${escapeHtml(cc)}`);
  headerLines.push(`主题：${escapeHtml(subject)}`);
  headerLines.push(`日期：${escapeHtml(date)}`);

  const headerHtml = headerLines
    .map((line) => `<div style="color:#666;font-size:12px;">${line}</div>`)
    .join("\n");

  // 顶部一个空段落作为用户输入区，下方是分隔线 + 原文引用
  return `<p></p><div style="border-top:1px solid #ccc;padding-top:8px;margin-top:8px;">${headerHtml}</div><div style="margin-top:8px;">${quotedBody}</div>`;
}

/** 校验邮箱地址格式（支持 "Name <email>" 和纯 email 两种格式） */
function isValidEmail(addr: string): boolean {
  const s = addr.trim();
  // 从 "Name <email>" 中提取尖括号内的 email
  const match = s.match(/<([^>]+)>$/);
  const email = match ? match[1].trim() : s;
  // 简单 RFC 5322 校验：local@domain
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** 校验逗号分隔的地址列表，返回第一个无效地址或 null */
function validateAddressList(input: string): string | null {
  const addrs = parseAddressList(input);
  for (const a of addrs) {
    if (!isValidEmail(a)) return a;
  }
  return null;
}

function buildInitialSubject(mode: ComposerMode, original: string): string {
  const subject = original || "";
  switch (mode) {
    case "reply":
    case "replyAll":
      return subject.startsWith("Re:") ? subject : `Re: ${subject}`;
    case "forward":
      return subject.startsWith("Fwd:") ? subject : `Fwd: ${subject}`;
    default:
      return "";
  }
}

function parseAddressList(input: string): string[] {
  return input
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MailComposer({
  open,
  onOpenChange,
  gatewayUrl,
  mode = "compose",
  baseMessage = null,
  account: accountProp,
  standalone = false,
}: MailComposerProps) {
  const accounts = useEmailStore((s) => s.accounts);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const account = accountProp ?? accounts.find((a) => a.id === selectedAccountId) ?? null;

  const [toAddresses, setToAddresses] = useState("");
  const [ccAddresses, setCcAddresses] = useState("");
  const [bccAddresses, setBccAddresses] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [attachments, setAttachments] = useState<EmailAttachmentInput[]>([]);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const editorRef = useRef<EmailRichEditorHandle>(null);

  // 获取当前账号的签名列表
  const signatures: EmailSignature[] = account?.signatures ?? [];
  const defaultSignature = signatures.find((s) => s.isDefault) ?? signatures[0] ?? null;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setAttachments([]);
    // 默认选中默认签名（仅 compose 模式自动追加）
    setSelectedSignatureId(defaultSignature?.id ?? null);
    if (mode === "compose" || !baseMessage) {
      setToAddresses("");
      setCcAddresses("");
      setBccAddresses("");
      setSubject("");
      setBodyText("");
      setBodyHtml("");
      setShowCc(false);
      setShowBcc(false);
      return;
    }

    const from = baseMessage.fromAddress;
    const toList = parseAddressList(baseMessage.toAddresses);
    const ccList = parseAddressList(baseMessage.ccAddresses ?? "");
    const self = account?.fromAddress;

    // 设置收件人/主题等字段
    if (mode === "reply") {
      setToAddresses(from);
      setCcAddresses("");
      setBccAddresses("");
      setSubject(buildInitialSubject("reply", baseMessage.subject));
      setShowCc(false);
      setShowBcc(false);
    } else if (mode === "replyAll") {
      // To: 原发件人 + 原 To（排除自己）
      const toRecipients = [from, ...toList.filter((addr) => addr !== self)];
      // Cc: 原 Cc（排除自己）
      const ccRecipients = ccList.filter((addr) => addr !== self);
      setToAddresses(toRecipients.join(", "));
      setCcAddresses(ccRecipients.join(", "));
      setBccAddresses("");
      setSubject(buildInitialSubject("replyAll", baseMessage.subject));
      setShowCc(ccRecipients.length > 0);
      setShowBcc(false);
    } else if (mode === "forward") {
      setToAddresses("");
      setCcAddresses("");
      setBccAddresses("");
      setSubject(buildInitialSubject("forward", baseMessage.subject));
      setShowCc(false);
      setShowBcc(false);
    }

    // 设置引用正文：优先用已有的 bodyHtml/bodyText，没有则异步拉取
    const hasBody = baseMessage.bodyHtml || baseMessage.bodyText;
    if (mode === "reply" || mode === "replyAll" || mode === "forward") {
      if (hasBody) {
        const replyHtml = formatReplyHeaderHtml(baseMessage);
        setBodyHtml(replyHtml);
        setBodyText("");
        // initialHtml 只在首次挂载生效，需额外调 setHtml 确保内容更新
        editorRef.current?.setHtml(replyHtml);
      } else if (gatewayUrl) {
        // 原邮件正文未加载（用户未点开过），异步拉取后再格式化
        const loadingHtml = '<div style="color:#999;">正在加载原邮件...</div>';
        setBodyHtml(loadingHtml);
        setBodyText("");
        (async () => {
          try {
            const result = await fetchEmailBody(
              gatewayUrl,
              baseMessage.accountId,
              baseMessage.uid,
              baseMessage.folder,
            );
            const enriched: EmailMessage = {
              ...baseMessage,
              bodyText: result.bodyText,
              bodyHtml: result.bodyHtml,
            };
            const html = formatReplyHeaderHtml(enriched);
            setBodyHtml(html);
            editorRef.current?.setHtml(html);
          } catch (e) {
            const errHtml = `<div style="color:#999;">原邮件加载失败：${escapeHtml(String(e))}</div>`;
            setBodyHtml(errHtml);
            editorRef.current?.setHtml(errHtml);
          }
        })();
      }
    }
  }, [open, mode, baseMessage, account?.fromAddress, gatewayUrl]);

  if (!open) return null;

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleSend = async () => {
    if (!account) {
      setError("请先选择一个邮箱账号");
      return;
    }
    if (!toAddresses.trim()) {
      setError("请填写收件人");
      return;
    }
    // 邮箱格式校验
    const invalidTo = validateAddressList(toAddresses);
    if (invalidTo) {
      setError(`收件人地址格式无效: ${invalidTo}`);
      return;
    }
    if (ccAddresses.trim()) {
      const invalidCc = validateAddressList(ccAddresses);
      if (invalidCc) {
        setError(`抄送地址格式无效: ${invalidCc}`);
        return;
      }
    }
    if (bccAddresses.trim()) {
      const invalidBcc = validateAddressList(bccAddresses);
      if (invalidBcc) {
        setError(`密送地址格式无效: ${invalidBcc}`);
        return;
      }
    }
    setSending(true);
    setError(null);
    try {
      // 追加签名到正文末尾
      const selectedSig = signatures.find((s) => s.id === selectedSignatureId) ?? null;
      const finalBodyHtml = selectedSig?.content
        ? `${bodyHtml}<br/><br/>${selectedSig.content}`
        : bodyHtml;
      const sigText = selectedSig?.content
        ? selectedSig.content.replace(/<[^>]*>/g, "").trim()
        : "";
      const finalBodyText = sigText ? `${bodyText}\n\n${sigText}` : bodyText;
      await sendEmail(gatewayUrl, account, {
        toAddresses: toAddresses.trim(),
        ccAddresses: ccAddresses.trim() || undefined,
        bccAddresses: bccAddresses.trim() || undefined,
        subject: subject.trim(),
        bodyText: finalBodyText,
        bodyHtml: finalBodyHtml,
        inReplyTo: baseMessage?.messageId ?? null,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      handleClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!account) {
      setError("请先选择一个邮箱账号");
      return;
    }
    setSavingDraft(true);
    setError(null);
    try {
      await saveDraft(gatewayUrl, account, {
        toAddresses: toAddresses.trim(),
        ccAddresses: ccAddresses.trim() || undefined,
        bccAddresses: bccAddresses.trim() || undefined,
        subject: subject.trim(),
        bodyText,
        bodyHtml,
        inReplyTo: baseMessage?.messageId ?? null,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      handleClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingDraft(false);
    }
  };

  const handleScheduleSend = async () => {
    if (!account) {
      setError("请先选择一个邮箱账号");
      return;
    }
    if (!toAddresses.trim()) {
      setError("请填写收件人");
      return;
    }
    const datetimeStr = window.prompt(
      "请输入定时发送时间（格式：YYYY-MM-DD HH:MM）\n例如：2026-06-25 09:00",
      new Date(Date.now() + 3600_000).toISOString().slice(0, 16).replace("T", " "),
    );
    if (!datetimeStr) return;
    // 解析本地时间
    const scheduled = new Date(datetimeStr.replace(" ", "T"));
    if (isNaN(scheduled.getTime())) {
      setError("时间格式无效，请使用 YYYY-MM-DD HH:MM 格式");
      return;
    }
    if (scheduled.getTime() <= Date.now()) {
      setError("定时发送时间必须晚于当前时间");
      return;
    }
    setSending(true);
    setError(null);
    try {
      // 追加签名
      const selectedSig = signatures.find((s) => s.id === selectedSignatureId) ?? null;
      const finalBodyHtml = selectedSig?.content
        ? `${bodyHtml}<br/><br/>${selectedSig.content}`
        : bodyHtml;
      const sigText = selectedSig?.content
        ? selectedSig.content.replace(/<[^>]*>/g, "").trim()
        : "";
      const finalBodyText = sigText ? `${bodyText}\n\n${sigText}` : bodyText;
      const { outboxAdd } = await import("./lib/emailApi");
      await outboxAdd({
        id: crypto.randomUUID(),
        accountId: account.id,
        toAddresses: toAddresses.trim(),
        ccAddresses: ccAddresses.trim() || null,
        bccAddresses: bccAddresses.trim() || null,
        subject: subject.trim(),
        bodyText: finalBodyText,
        bodyHtml: finalBodyHtml,
        inReplyTo: baseMessage?.messageId ?? null,
        attachmentsJson: attachments.length > 0 ? JSON.stringify(attachments) : null,
        scheduledAt: scheduled.toISOString(),
        status: "pending",
        error: null,
        createdAt: new Date().toISOString(),
      });
      handleClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  /** 附件：打开文件对话框，读取为 base64 */
  const handleAttach = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const newAtts: EmailAttachmentInput[] = [];
      for (const p of paths) {
        const data = await readFile(p);
        const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
        const filename = p.split(/[\\/]/).pop() || "attachment";
        newAtts.push({
          filename,
          contentType: "application/octet-stream",
          data: base64,
        });
      }
      if (newAtts.length > 0) {
        setAttachments((prev) => [...prev, ...newAtts]);
      }
    } catch (err) {
      console.warn("[MailComposer] attach files failed:", err);
    }
  };

  /** 截屏：从剪贴板读取图片并插入编辑区 */
  const handleScreenshot = async () => {
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            editorRef.current?.insertImageFromDataUrl(dataUrl);
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
      setError("剪贴板中没有图片。请先用系统截图工具（如 Win+Shift+S）截图，再点击截屏按钮。");
    } catch (err) {
      console.warn("[MailComposer] screenshot failed:", err);
      setError("读取剪贴板失败，请先用系统截图工具截图后再试。");
    }
  };

  const topToolbar = (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/70 bg-muted/20 px-3">
      <Button
        type="button"
        size="sm"
        className="h-7 gap-1.5 px-3 text-[12px]"
        disabled={sending || savingDraft || !account}
        onClick={handleSend}
      >
        {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        发送
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-[12px] text-muted-foreground hover:text-foreground"
        disabled={savingDraft || sending || !account}
        onClick={handleSaveDraft}
      >
        {savingDraft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        保存
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-[12px] text-muted-foreground hover:text-foreground"
        disabled={sending || savingDraft || !account}
        onClick={() => void handleScheduleSend()}
        title="定时发送"
      >
        <Clock className="h-3.5 w-3.5" />
        定时
      </Button>
      <span className="mx-1 h-4 w-px bg-border/70" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
        disabled={!account}
        onClick={handleAttach}
      >
        <Paperclip className="h-3.5 w-3.5" />
        附件
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
        disabled={!account}
        onClick={() => editorRef.current?.insertImage()}
      >
        <ImageIcon className="h-3.5 w-3.5" />
        图片
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
        disabled={!account}
        onClick={handleScreenshot}
      >
        <Camera className="h-3.5 w-3.5" />
        截屏
      </Button>
      {signatures.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
              disabled={!account}
            >
              <FileText className="h-3.5 w-3.5" />
              {selectedSignatureId
                ? signatures.find((s) => s.id === selectedSignatureId)?.name ?? "签名"
                : "签名"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => setSelectedSignatureId(null)}>
              不使用签名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {signatures.map((sig) => (
              <DropdownMenuItem
                key={sig.id}
                onClick={() => setSelectedSignatureId(sig.id)}
                className={sig.id === selectedSignatureId ? "font-medium" : ""}
              >
                {sig.name}
                {sig.isDefault && (
                  <span className="ml-1 text-[10px] text-blue-600">默认</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-1 text-[12px] text-muted-foreground">
        <span className="truncate max-w-[180px]">
          {account ? `${account.displayName} <${account.fromAddress}>` : "未选择账号"}
        </span>
        <ChevronDown className="h-3.5 w-3.5" />
      </div>
      {!standalone && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-2 h-7 w-7 text-muted-foreground"
          onClick={handleClose}
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );

  const fields = (
    <div className="flex shrink-0 flex-col border-b border-border/60 bg-background px-4 py-2">
      <FieldRow label="收件人">
        <ContactPicker
          value={toAddresses}
          onChange={setToAddresses}
          placeholder="recipient@example.com"
        />
        <button
          type="button"
          onClick={() => setShowCc((v) => !v)}
          className="ml-2 text-[12px] text-muted-foreground hover:text-foreground"
        >
          抄送
        </button>
        <button
          type="button"
          onClick={() => setShowBcc((v) => !v)}
          className="ml-2 text-[12px] text-muted-foreground hover:text-foreground"
        >
          密送
        </button>
      </FieldRow>
      {showCc && (
        <FieldRow label="抄送">
          <ContactPicker
            value={ccAddresses}
            onChange={setCcAddresses}
            placeholder="cc@example.com"
          />
        </FieldRow>
      )}
      {showBcc && (
        <FieldRow label="密送">
          <ContactPicker
            value={bccAddresses}
            onChange={setBccAddresses}
            placeholder="bcc@example.com"
          />
        </FieldRow>
      )}
      <FieldRow label="主题">
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="邮件主题"
          className="h-7 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-[13px] shadow-none focus-visible:ring-0"
        />
      </FieldRow>
      {attachments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {attachments.map((att, idx) => (
            <div
              key={`${att.filename}-${idx}`}
              className="flex items-center gap-1.5 rounded border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              <FileIcon className="h-3 w-3 shrink-0" />
              <span className="max-w-[160px] truncate">{att.filename}</span>
              <span className="shrink-0">{formatFileSize(Math.ceil(att.data.length * 0.75))}</span>
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                className="ml-0.5 text-muted-foreground hover:text-destructive"
                aria-label="移除附件"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="mt-1 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </div>
  );

  const content = (
    <EmailRichEditor
      key={`${mode}-${baseMessage?.uid ?? "new"}`}
      ref={editorRef}
      initialHtml={bodyHtml || undefined}
      onChange={({ html, text }) => {
        setBodyText(text);
        setBodyHtml(html);
      }}
      placeholder="邮件正文..."
      className="min-h-0 flex-1"
    />
  );

  if (standalone) {
    return (
      <div className="flex h-full flex-col bg-background">
        {topToolbar}
        {fields}
        {content}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleClose}
    >
      <div
        className="flex h-[85vh] w-full max-w-[720px] flex-col rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {topToolbar}
        {fields}
        {content}
      </div>
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[30px] items-center gap-2">
      <Label className="w-12 shrink-0 text-[12px] text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
