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
  FileText,
  Clock,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { FileSystemIcon } from "@/components/ui/file-system-icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusNotice } from "@/components/ui/status-notice";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useEmailStore } from "./store/emailStore";
import {
  sendEmail,
  saveDraft,
  fetchEmailBody,
  fetchAttachment,
  parseEmailAddressList,
  textToHtml,
  type EmailAttachmentInput,
  type SaveDraftResult,
} from "./lib/emailApi";
import { EmailRichEditor, type EmailRichEditorHandle } from "./EmailRichEditor";
import { SafeHtmlFrame } from "./MailView";
import { ContactPicker } from "./contacts/ContactPicker";
import { ComposeAiButton } from "./ComposeAiButton";
import { buildForwardSubject, buildQuotedMailHtml } from "./lib/quoteHtml";
import { excludeSelf } from "./lib/addressUtils";
import { guessContentType, uint8ToBase64 } from "./lib/fileBytes";
import type { EmailAccount, EmailAttachment, EmailMessage, EmailSignature } from "./lib/types";

export type ComposerMode = "compose" | "reply" | "replyAll" | "forward" | "draft";

interface MailComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gatewayUrl: string;
  mode?: ComposerMode;
  baseMessage?: EmailMessage | null;
  account?: EmailAccount | null;
  standalone?: boolean;
  onDraftSaved?: (result: SaveDraftResult, accountId: string, folder: string) => void;
  /** 预设收件人（点击发件人名称写邮件时使用） */
  presetTo?: string | null;
}

/** 单封邮件附件总大小上限（与常见邮箱 50MB 上限对齐，网关请求体上限需能容纳 base64 膨胀） */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

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
      return /^re\s*[:：]/i.test(subject) ? subject : `Re: ${subject}`;
    case "forward":
      return buildForwardSubject(subject);
    default:
      return "";
  }
}

function parseAddressList(input: string): string[] {
  return parseEmailAddressList(input);
}

type RestorableDraftAttachment = EmailAttachment & { contentId?: string | null };

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
  onDraftSaved,
  presetTo = null,
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
  // 转发时随邮件一起发送的原邮件附件（体积只在发送时按需取，避免打开窗口就加载大附件）
  const [forwardedAttachments, setForwardedAttachments] = useState<EmailAttachment[]>([]);
  // 引用块：原邮件 HTML 原样保留，不经过编辑器 schema，只读展示 + 发送时拼接
  const [quoteHtml, setQuoteHtml] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // 发送前准备附件的进度提示
  const [preparingText, setPreparingText] = useState("");
  // 原邮件附件读取失败时的提示（不能让附件静默丢失）
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [draftLoadError, setDraftLoadError] = useState<string | null>(null);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const editorRef = useRef<EmailRichEditorHandle>(null);
  const draftUidRef = useRef<string | null>(null);
  const draftRequestIdRef = useRef<string | null>(null);
  // 引用 gateway 地址但不作为 effect 依赖：地址后续就绪时不能重置用户已经输入的内容
  const gatewayUrlRef = useRef(gatewayUrl);
  gatewayUrlRef.current = gatewayUrl;

  // 获取当前账号的签名列表
  const signatures: EmailSignature[] = account?.signatures ?? [];
  const defaultSignature = signatures.find((s) => s.isDefault) ?? signatures[0] ?? null;

  useEffect(() => {
    if (!open) {
      draftUidRef.current = null;
      draftRequestIdRef.current = null;
      return;
    }
    let cancelled = false;
    draftUidRef.current = mode === "draft" ? baseMessage?.uid ?? null : null;
    setError(null);
    setDraftLoadError(null);
    setAttachments([]);
    setForwardedAttachments([]);
    setQuoteHtml("");
    setQuoteError(null);
    setQuoteLoading(false);
    setPreparingText("");
    setAttachmentNotice(null);
    setBodyText("");
    setBodyHtml("");
    // 仅新邮件自动选中默认签名，回复/转发默认不带签名
    setSelectedSignatureId(mode === "compose" ? (defaultSignature?.id ?? null) : null);
    if (mode === "compose" || !baseMessage) {
      setToAddresses(presetTo ?? "");
      setCcAddresses("");
      setBccAddresses("");
      setSubject("");
      setShowCc(false);
      setShowBcc(false);
      return;
    }

    if (mode === "draft") {
      setToAddresses(baseMessage.toAddresses);
      setCcAddresses(baseMessage.ccAddresses ?? "");
      setBccAddresses(baseMessage.bccAddresses ?? "");
      setSubject(baseMessage.subject);
      setShowCc(Boolean(baseMessage.ccAddresses?.trim()));
      setShowBcc(Boolean(baseMessage.bccAddresses?.trim()));
      setQuoteLoading(true);
      void (async () => {
        try {
          const result = await fetchEmailBody(
            baseMessage.accountId,
            baseMessage.uid,
            baseMessage.folder,
            gatewayUrlRef.current,
          );
          if (cancelled) return;
          const draftBodyHtml = result.bodyHtml || textToHtml(result.bodyText);
          setBodyText(result.bodyText);
          setBodyHtml(draftBodyHtml);
          editorRef.current?.setHtml(draftBodyHtml);
          const bcc = result.header?.bccAddresses ?? baseMessage.bccAddresses ?? "";
          setBccAddresses(bcc);
          setShowBcc(Boolean(bcc.trim()));

          const metadata = (result.attachments ?? []) as RestorableDraftAttachment[];
          if (baseMessage.hasAttachments && metadata.length === 0) {
            throw new Error("草稿附件列表不可用");
          }
          const draftAccount =
            account ?? accounts.find((candidate) => candidate.id === baseMessage.accountId);
          if (!draftAccount) {
            throw new Error("草稿所属邮箱账号不可用");
          }
          const restored: EmailAttachmentInput[] = [];
          for (let index = 0; index < metadata.length; index += 1) {
            const attachment = metadata[index];
            setPreparingText(`正在恢复草稿附件 ${index + 1}/${metadata.length}...`);
            const fetched = await fetchAttachment(
              gatewayUrlRef.current,
              draftAccount,
              baseMessage.folder,
              baseMessage.uid,
              attachment.filename,
              attachment.contentId,
            );
            restored.push({
              filename: fetched.filename,
              contentType: fetched.contentType || attachment.contentType,
              data: fetched.data,
              contentId: attachment.contentId ?? undefined,
            });
          }
          if (cancelled) return;
          const restoredBytes = restored.reduce(
            (sum, attachment) => sum + Math.ceil(attachment.data.length * 0.75),
            0,
          );
          if (restoredBytes > MAX_ATTACHMENT_BYTES) {
            throw new Error("草稿附件总大小超过单封 50 MB 上限");
          }
          setAttachments(restored);
        } catch (error) {
          if (!cancelled) {
            const message = `草稿加载失败：${String(error)}`;
            setDraftLoadError(message);
            setAttachmentNotice(message);
          }
        } finally {
          if (!cancelled) {
            setPreparingText("");
            setQuoteLoading(false);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
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
      // To: 原发件人 + 原 To；Cc: 原 Cc
      // 地址是 `姓名 <地址>` 形式，必须按裸地址比较才能把自己和重复项剔除
      const toRecipients = excludeSelf([from, ...toList], self);
      const ccRecipients = excludeSelf(ccList, self);
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

    // 引用原邮件：Offline-First 下 SQLite 不存正文，统一走 fetchEmailBody
    // （fetchEmailBody 内部会先读本地 .eml，命中则毫秒级返回，不命中才走 gateway）
    // 引用块不再写入编辑器：编辑器会把原 HTML 压成自己支持的少数标签，导致丢格式。
    const applyOriginal = (message: EmailMessage) => {
      if (cancelled) return;
      setQuoteHtml(buildQuotedMailHtml(message));
      // 转发保留原邮件附件；回复不带原附件
      if (mode !== "forward") return;
      // attachments 已解析（含空数组）时直接采用，避免重复拉取
      if (message.attachments !== undefined) {
        setForwardedAttachments(message.attachments);
        return;
      }
      if (!message.hasAttachments) {
        setForwardedAttachments([]);
        return;
      }
      // 正文来自内存缓存但缺少附件元信息：补拉一次附件列表（本地 .eml 解析，毫秒级）
      void (async () => {
        try {
          const result = await fetchEmailBody(
            message.accountId,
            message.uid,
            message.folder,
            gatewayUrlRef.current,
          );
          if (!cancelled) setForwardedAttachments(result.attachments ?? []);
        } catch {
          if (!cancelled) {
            setAttachmentNotice("原邮件附件读取失败，如需一并转发请手动添加附件");
          }
        }
      })();
    };

    if (baseMessage.bodyHtml || baseMessage.bodyText) {
      applyOriginal(baseMessage);
      return;
    }
    setQuoteLoading(true);
    void (async () => {
      try {
        const result = await fetchEmailBody(
          baseMessage.accountId,
          baseMessage.uid,
          baseMessage.folder,
          gatewayUrlRef.current,
        );
        applyOriginal({
          ...baseMessage,
          bodyText: result.bodyText,
          bodyHtml: result.bodyHtml,
          attachments: result.attachments ?? baseMessage.attachments,
        });
      } catch (e) {
        if (!cancelled) setQuoteError(`原邮件加载失败：${String(e)}`);
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode, baseMessage, account?.fromAddress]);

  if (!open) return null;

  const handleClose = () => {
    onOpenChange(false);
  };

  /** 已选附件 + 原邮件附件的总字节数（base64 按 3/4 还原） */
  const totalAttachmentBytes = () =>
    attachments.reduce((sum, att) => sum + Math.ceil(att.data.length * 0.75), 0) +
    forwardedAttachments.reduce((sum, att) => sum + att.size, 0);

  /** 发送/存草稿/定时前统一校验附件体积，避免等到网关 413 才失败 */
  const assertAttachmentBudget = () => {
    const total = totalAttachmentBytes();
    if (total > MAX_ATTACHMENT_BYTES) {
      const mb = (total / (1024 * 1024)).toFixed(1);
      throw new Error(
        `附件合计 ${mb} MB，超过单封 50 MB 上限。\n请移除较大的附件，或改用分享链接发送。`,
      );
    }
  };

  /** 原邮件附件转成待发送附件：体积较大，只在发送动作时按需读取 */
  const resolveOutgoingAttachments = async (): Promise<EmailAttachmentInput[]> => {
    assertAttachmentBudget();
    if (!account || forwardedAttachments.length === 0 || !baseMessage) return attachments;
    const resolved: EmailAttachmentInput[] = [];
    for (let i = 0; i < forwardedAttachments.length; i += 1) {
      const att = forwardedAttachments[i];
      setPreparingText(`正在准备附件 ${i + 1}/${forwardedAttachments.length}...`);
      const res = await fetchAttachment(
        gatewayUrl,
        account,
        baseMessage.folder,
        baseMessage.uid,
        att.filename,
        att.contentId,
      );
      resolved.push({
        filename: res.filename,
        contentType: res.contentType || att.contentType || "application/octet-stream",
        data: res.data,
        contentId: att.contentId ?? undefined,
      });
    }
    setPreparingText("");
    return [...attachments, ...resolved];
  };

  const handleSend = async () => {
    if (!account) {
      setError("请先选择一个邮箱账号");
      return;
    }
    if (draftLoadError) {
      setError(draftLoadError);
      return;
    }
    if (mode === "draft" && quoteLoading) {
      setError("草稿仍在加载，请稍后重试");
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
      // 正文顺序：用户输入 → 签名 → 原邮件引用（引用原样保留，不经过编辑器）
      const selectedSig = signatures.find((s) => s.id === selectedSignatureId) ?? null;
      const finalBodyHtml = `${bodyHtml}${
        selectedSig?.content ? `<br/><br/>${selectedSig.content}` : ""
      }${quoteHtml}`;
      const sigText = selectedSig?.content
        ? selectedSig.content.replace(/<[^>]*>/g, "").trim()
        : "";
      const finalBodyText = sigText ? `${bodyText}\n\n${sigText}` : bodyText;
      const outgoingAttachments = await resolveOutgoingAttachments();
      await sendEmail(gatewayUrl, account, {
        toAddresses: toAddresses.trim(),
        ccAddresses: ccAddresses.trim() || undefined,
        bccAddresses: bccAddresses.trim() || undefined,
        subject: subject.trim(),
        bodyText: finalBodyText,
        bodyHtml: finalBodyHtml,
        // 只有回复才建立会话关系；转发是新的会话，带 In-Reply-To 会被对方客户端归到原邮件线程
        inReplyTo:
          mode === "reply" || mode === "replyAll" ? baseMessage?.messageId ?? null : null,
        attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
      });
      handleClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
      setPreparingText("");
    }
  };

  const handleSaveDraft = async () => {
    if (!account) {
      setError("请先选择一个邮箱账号");
      return;
    }
    if (draftLoadError) {
      setError(draftLoadError);
      return;
    }
    if (mode === "draft" && quoteLoading) {
      setError("草稿仍在加载，请稍后重试");
      return;
    }
    setSavingDraft(true);
    setError(null);
    try {
      // 草稿必须带上引用块，否则存下来再打开就丢了原邮件内容
      const outgoingAttachments = await resolveOutgoingAttachments();
      const savedDraft = await saveDraft(gatewayUrl, account, {
        toAddresses: toAddresses.trim(),
        ccAddresses: ccAddresses.trim() || undefined,
        bccAddresses: bccAddresses.trim() || undefined,
        subject: subject.trim(),
        bodyText,
        bodyHtml: `${bodyHtml}${quoteHtml}`,
        inReplyTo:
          mode === "reply" || mode === "replyAll" ? baseMessage?.messageId ?? null : null,
        attachments: outgoingAttachments.length > 0 ? outgoingAttachments : undefined,
      }, {
        draftUid: mode === "draft" ? draftUidRef.current : null,
        draftFolder: mode === "draft" ? baseMessage?.folder : null,
        draftRequestId: draftRequestIdRef.current ?? (draftRequestIdRef.current = crypto.randomUUID()),
      });
      draftUidRef.current = savedDraft.draftUid ?? draftUidRef.current;
      const savedFolder = savedDraft.draftFolder ?? (mode === "draft" ? baseMessage?.folder : null);
      if (savedFolder) onDraftSaved?.(savedDraft, account.id, savedFolder);
      draftRequestIdRef.current = null;
      handleClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingDraft(false);
      setPreparingText("");
    }
  };

  const handleScheduleSend = async () => {
    if (!account) {
      setError("请先选择一个邮箱账号");
      return;
    }
    if (draftLoadError) {
      setError(draftLoadError);
      return;
    }
    if (mode === "draft" && quoteLoading) {
      setError("草稿仍在加载，请稍后重试");
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
      // 正文顺序：用户输入 → 签名 → 原邮件引用
      const selectedSig = signatures.find((s) => s.id === selectedSignatureId) ?? null;
      const finalBodyHtml = `${bodyHtml}${
        selectedSig?.content ? `<br/><br/>${selectedSig.content}` : ""
      }${quoteHtml}`;
      const sigText = selectedSig?.content
        ? selectedSig.content.replace(/<[^>]*>/g, "").trim()
        : "";
      const finalBodyText = sigText ? `${bodyText}\n\n${sigText}` : bodyText;
      const outgoingAttachments = await resolveOutgoingAttachments();
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
        inReplyTo:
          mode === "reply" || mode === "replyAll" ? baseMessage?.messageId ?? null : null,
        attachmentsJson:
          outgoingAttachments.length > 0 ? JSON.stringify(outgoingAttachments) : null,
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
      setPreparingText("");
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
      const { readFile, stat } = await import("@tauri-apps/plugin-fs");
      const newAtts: EmailAttachmentInput[] = [];
      let projected = totalAttachmentBytes();
      for (const p of paths) {
        const filename = p.split(/[\\/]/).pop() || "attachment";
        // 先按文件大小预判，避免把几百 MB 的文件整个读进内存再报错
        let size = 0;
        try {
          size = (await stat(p)).size ?? 0;
        } catch {
          // 权限或平台差异时退化为读取后再校验
        }
        if (size > 0 && projected + size > MAX_ATTACHMENT_BYTES) {
          setError(
            `附件合计超过单封 50 MB 上限，「${filename}」未添加。\n请移除其他附件或改用分享链接发送。`,
          );
          continue;
        }
        const data = await readFile(p);
        if (projected + data.byteLength > MAX_ATTACHMENT_BYTES) {
          setError(
            `附件合计超过单封 50 MB 上限，「${filename}」未添加。\n请移除其他附件或改用分享链接发送。`,
          );
          continue;
        }
        projected += data.byteLength;
        newAtts.push({
          filename,
          contentType: guessContentType(filename),
          data: uint8ToBase64(data),
        });
      }
      if (newAtts.length > 0) {
        setAttachments((prev) => [...prev, ...newAtts]);
      }
    } catch (err) {
      setError(`添加附件失败：${String(err)}`);
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
        className="h-7 gap-1.5 px-3 text-caption"
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
        className="h-7 gap-1.5 px-2 text-caption text-muted-foreground hover:text-foreground"
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
        className="h-7 gap-1.5 px-2 text-caption text-muted-foreground hover:text-foreground"
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
        className="h-7 gap-1 px-2 text-caption text-muted-foreground hover:text-foreground"
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
        className="h-7 gap-1 px-2 text-caption text-muted-foreground hover:text-foreground"
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
        className="h-7 gap-1 px-2 text-caption text-muted-foreground hover:text-foreground"
        disabled={!account}
        onClick={handleScreenshot}
      >
        <Camera className="h-3.5 w-3.5" />
        截屏
      </Button>
      <span className="mx-0.5 h-4 w-px bg-border/70" />
      {mode !== "draft" && (
        <ComposeAiButton
          mode={mode}
          baseMessage={baseMessage}
          bodyText={bodyText}
          onResult={(html) => {
            setBodyHtml(html);
            editorRef.current?.setHtml(html);
          }}
          disabled={!account || sending || savingDraft}
        />
      )}
      {signatures.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-caption text-muted-foreground hover:text-foreground"
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
                  <span className="ml-1 text-micro text-info-strong">默认</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div className="flex-1" />
      <div className="flex items-center gap-1 text-caption text-muted-foreground">
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
          placeholder="输入邮箱地址或选择联系人"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowCc((v) => !v)}
          className="ml-2 h-6 px-1.5 text-caption text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          抄送
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowBcc((v) => !v)}
          className="ml-2 h-6 px-1.5 text-caption text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          密送
        </Button>
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
          className="h-7 flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-ui shadow-none focus-visible:ring-0"
        />
      </FieldRow>
      {attachments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {attachments.map((att, idx) => (
            <div
              key={`${att.filename}-${idx}`}
              className="flex items-center gap-1.5 rounded-xs border border-border/60 bg-muted/30 px-2 py-0.5 text-micro text-muted-foreground"
            >
              <FileSystemIcon name={att.filename} />
              <span className="max-w-[160px] truncate">{att.filename}</span>
              <span className="shrink-0">{formatFileSize(Math.ceil(att.data.length * 0.75))}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                className="ml-0.5 h-4 w-4 p-0 text-muted-foreground hover:bg-transparent hover:text-destructive"
                aria-label="移除附件"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {forwardedAttachments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="shrink-0 text-micro text-muted-foreground">原邮件附件</span>
          {forwardedAttachments.map((att, idx) => (
            <div
              key={`${att.filename}-${idx}`}
              className="flex items-center gap-1.5 rounded-xs border border-border/60 bg-muted/30 px-2 py-0.5 text-micro text-muted-foreground"
              title="随本次转发一起发送"
            >
              <FileSystemIcon name={att.filename} />
              <span className="max-w-[160px] truncate">{att.filename}</span>
              <span className="shrink-0">{formatFileSize(att.size)}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setForwardedAttachments((prev) => prev.filter((_, i) => i !== idx))
                }
                className="ml-0.5 h-4 w-4 p-0 text-muted-foreground hover:bg-transparent hover:text-destructive"
                aria-label="不转发该附件"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {attachmentNotice && (
        <div className="mt-1 px-1 text-micro text-warning">{attachmentNotice}</div>
      )}
      {preparingText && (
        <div className="mt-1 flex items-center gap-1.5 px-1 text-micro text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {preparingText}
        </div>
      )}
      {error && (
        <StatusNotice tone="danger" className="mt-1 px-2 py-1">
          {error}
        </StatusNotice>
      )}
    </div>
  );

  const content = (
    <EmailRichEditor
      key={`${mode}-${baseMessage?.uid ?? "new"}`}
      ref={editorRef}
      initialHtml=""
      onChange={({ html, text }) => {
        setBodyText(text);
        setBodyHtml(html);
      }}
      placeholder="邮件正文..."
      className="min-h-0 flex-1"
      signatureHtml={signatures.find((s) => s.id === selectedSignatureId)?.content ?? null}
      footer={
        mode !== "compose" && baseMessage ? (
          <div className="mt-2">
            {quoteLoading ? (
              <div className="flex items-center gap-1.5 py-2 text-caption text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {mode === "draft" ? "正在加载草稿..." : "正在加载原邮件..."}
              </div>
            ) : quoteError ? (
              <div className="py-2 text-caption text-destructive">{quoteError}</div>
            ) : quoteHtml ? (
              <SafeHtmlFrame html={quoteHtml} minHeight={64} />
            ) : null}
          </div>
        ) : null
      }
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
      <Label className="w-12 shrink-0 text-caption text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
