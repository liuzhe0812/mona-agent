import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  X,
  FileDown,
  FolderArchive,
  Copy,
  Trash2,
  ExternalLink,
  Share2,
  ImageDown,
  CalendarPlus,
  Check,
  FolderInput,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEmailStore, resolveSenderDisplay } from "./store/emailStore";
import { useLicense } from "@/hooks/useLicense";
import type { EmailAnalysis, EmailAttachment, EmailKeyInfo, EmailMessage } from "./lib/types";
import { getFolderDisplayName, sortFolders } from "./lib/folderUtils";
import * as emailApi from "./lib/emailApi";
import { save, open as openDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { tempDir, join } from "@tauri-apps/api/path";
import {
  getIcon,
  extractExtension,
  getCachedIcon,
} from "../terminal/FileManager/iconCache";
import { openPathWithSystemApp, isTauri, httpFetch } from "@/lib/tauri";
import { getServicesHttpBase } from "@/lib/api";
import { SenderPopover } from "./SenderPopover";

interface ParsedAddress {
  name: string;
  email: string;
  inContacts: boolean;
}

/**
 * 解析地址字符串（支持 "Name <email>" 和纯 email，逗号分隔多个）。
 * 返回每个地址的 name、email、是否在通讯录中。
 */
function parseAddressListWithContacts(
  raw: string | null | undefined,
  contactsByEmail: Record<string, string>,
): ParsedAddress[] {
  if (!raw) return [];
  const parts: string[] = [];
  let current = "";
  let inAngle = false;
  for (const ch of raw) {
    if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inAngle) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  return parts.map((part) => {
    const match = part.match(/^([^<]*?)\s*<([^>]+)>$/);
    if (match) {
      const name = match[1].trim().replace(/^["']|["']$/g, "");
      const email = match[2].trim();
      const contactName = contactsByEmail[email.toLowerCase()];
      return {
        name: contactName || name || email,
        email,
        inContacts: Boolean(contactName),
      };
    }
    const email = part.trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const contactName = contactsByEmail[email.toLowerCase()];
      return {
        name: contactName || email,
        email,
        inContacts: Boolean(contactName),
      };
    }
    return { name: part, email: "", inContacts: false };
  });
}

export function MailView({ onOpenSubscribe }: { onOpenSubscribe?: () => void }) {
  const { licenseActive } = useLicense();
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
  const bodyLoadingStage = useEmailStore((s) => s.bodyLoadingStage);
  const contactsByEmail = useEmailStore((s) => s.contactsByEmail);
  const loadContacts = useEmailStore((s) => s.loadContacts);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  // 多选
  const selectedUids = useEmailStore((s) => s.selectedUids);
  const folders = useEmailStore((s) => s.folders);
  const batchOperate = useEmailStore((s) => s.batchOperate);
  const batchOperating = useEmailStore((s) => s.batchOperating);
  const clearSelection = useEmailStore((s) => s.clearSelection);

  // 首次渲染时加载通讯录，建立 email→name 映射（仅一次）
  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [exporting, setExporting] = useState(false);
  // 提取日程中（手动触发单封邮件 AI 日程提取）
  const [extractingSchedule, setExtractingSchedule] = useState(false);
  const [scheduleExtractResult, setScheduleExtractResult] = useState<{
    title: string;
    description: string;
  } | null>(null);
  // 附件系统图标缓存：key = filename，value = dataUrl（系统默认应用图标）
  const [attIcons, setAttIcons] = useState<Record<string, string>>({});
  // 邮件正文图片：左键点击直接打开预览
  const [imagePreviewSrc, setImagePreviewSrc] = useState<string | null>(null);
  // 邮件正文图片：右键自定义菜单（替代 WebView2 原生菜单）
  const [imageContextMenu, setImageContextMenu] = useState<{ src: string; x: number; y: number } | null>(null);
  const [imageActionLoading, setImageActionLoading] = useState(false);

  // 将图片 src（http/data URL）转为 Blob，用于复制到剪贴板和另存为
  // 必须放在条件 return 之前，保证 hooks 调用顺序稳定
  const fetchImageBlob = useCallback(async (src: string): Promise<Blob | null> => {
    try {
      if (src.startsWith("data:")) {
        const resp = await fetch(src);
        return await resp.blob();
      }
      const resp = await fetch(src, { mode: "cors" });
      return await resp.blob();
    } catch {
      return null;
    }
  }, []);

  // 左键点击图片：直接打开预览
  const handleImageOpen = useCallback((src: string) => {
    setImagePreviewSrc(src);
  }, []);

  // 右键点击图片：显示自定义菜单
  const handleImageMenu = useCallback((src: string, x: number, y: number) => {
    setImageContextMenu({ src, x, y });
  }, []);

  // 点击链接：用系统默认应用打开 URL（默认浏览器）
  const handleLinkClick = useCallback((url: string) => {
    if (!isTauri()) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    void openPathWithSystemApp(url);
  }, []);

  // 附件列表变化时，异步加载系统文件类型图标（已缓存的同步显示，未缓存的加载后显示）
  useEffect(() => {
    if (!selectedMessage?.attachments) return;
    const atts = selectedMessage.attachments;
    let cancelled = false;
    void (async () => {
      const updates: Record<string, string> = {};
      for (const att of atts) {
        const ext = extractExtension(att.filename);
        const cached = getCachedIcon(ext, false);
        if (cached) {
          updates[att.filename] = cached;
        } else if (ext) {
          try {
            const icon = await getIcon(ext, false);
            if (icon && !cancelled) updates[att.filename] = icon;
          } catch {
            // 获取图标失败时静默忽略，用回退图标
          }
        }
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        setAttIcons((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedMessage?.attachments]);

  // 选中邮件时，若未读则自动标记为已读
  // 本地优先：即使 gateway 离线，Rust 侧也会先更新 SQLite，gateway 失败不报错
  useEffect(() => {
    if (selectedMessage && !selectedMessage.isRead && gatewayUrl) {
      void toggleRead(gatewayUrl, selectedMessage);
    }
  }, [selectedMessage, gatewayUrl, toggleRead]);

  // 选中邮件时，从本地缓存加载 AI 分析结果（不自动调用 LLM）
  useEffect(() => {
    if (selectedMessage) {
      void loadAnalysis(selectedMessage);
      setAnalysisCollapsed(false);
    }
  }, [selectedMessage, loadAnalysis]);

  // 按需拉取正文：选中邮件且正文未拉取时，调用 fetchBody 加载完整正文
  // Offline-First：SQLite 不存 bodyText/bodyHtml（正文完全在 .eml 文件），
  // 因此只看 bodyFetched 标志判断是否需要拉取，不再检查 bodyText/bodyHtml
  // （否则这两个字段永远为空会触发无限循环）
  // 有附件但未加载附件列表时也需要拉取（fetchBody 会顺带返回附件元信息）
  // Rust 侧 email_fetch_body 会先读本地 .eml 文件，读不到才走 gateway IMAP，无需检查 isOnline
  // bodyError 存在时不自动重试（selectMessage 已清除 bodyError，此处 bodyError 表示同一次选中内彻底失败）
  useEffect(() => {
    // email_fetch_body 是纯本地 Tauri IPC，不依赖 gatewayUrl
    // bodyCache 未命中时触发（selectMessage 已预取，这里是兜底）
    // 触发条件：
    //   1. bodyFetched=false：本地 .eml 不完整，需走网络拉取
    //   2. bodyFetched=true 但 bodyText/bodyHtml 都空：本地 .eml 完整但未解析过，
    //      需触发 fetchBody 解析本地 .eml（毫秒级，不走网络）
    //      若解析后仍空（合法空正文），bodyCache 会填空 body 命中，下次切换不再重复请求
    //   3. 有附件但附件列表未加载：需触发 fetchBody 解析附件
    if (
      selectedMessage &&
      !selectedMessage.bodyError &&
      (!selectedMessage.bodyFetched ||
        (selectedMessage.hasAttachments && !selectedMessage.attachments) ||
        (!selectedMessage.bodyText &&
          !selectedMessage.bodyHtml &&
          selectedMessage.bodyFetched))
    ) {
      void fetchBody(selectedMessage);
    }
  }, [selectedMessage, fetchBody]);

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
    // 多选模式：显示批量操作面板
    if (selectedUids.size > 1) {
      const moveTargets = sortFolders(folders);
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-editor-surface">
          <div className="text-center">
            <Check className="mx-auto h-10 w-10 text-info" />
            <p className="mt-2 text-body font-medium text-foreground">
              已选中 {selectedUids.size} 封邮件
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-caption"
              disabled={batchOperating}
              onClick={() => void batchOperate(gatewayUrl, "mark_read")}
            >
              <MailOpen className="h-3.5 w-3.5" />
              标为已读
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-caption"
              disabled={batchOperating}
              onClick={() => void batchOperate(gatewayUrl, "mark_unread")}
            >
              <MailOpen className="h-3.5 w-3.5" />
              标为未读
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-caption"
              disabled={batchOperating}
              onClick={() => void batchOperate(gatewayUrl, "star")}
            >
              <Star className="h-3.5 w-3.5" />
              星标
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-caption"
              disabled={batchOperating}
              onClick={() => void batchOperate(gatewayUrl, "unstar")}
            >
              <Star className="h-3.5 w-3.5" />
              取消星标
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-caption text-destructive hover:text-destructive"
              disabled={batchOperating}
              onClick={() => void batchOperate(gatewayUrl, "delete")}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </Button>
          </div>
          {moveTargets.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-caption"
                  disabled={batchOperating}
                >
                  <FolderInput className="h-3.5 w-3.5" />
                  移动到
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="min-w-[160px]">
                {moveTargets.map((folder) => (
                  <DropdownMenuItem
                    key={folder.name}
                    onClick={() => void batchOperate(gatewayUrl, "move", folder.name)}
                    className="flex items-center justify-between gap-2 text-caption"
                  >
                    <span className="truncate">{getFolderDisplayName(folder.name)}</span>
                    {folder.unreadCount ? (
                      <span className="shrink-0 text-micro text-muted-foreground">
                        {folder.unreadCount}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-7 gap-1.5 text-caption text-muted-foreground"
            onClick={clearSelection}
          >
            取消选择
          </Button>
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-editor-surface text-muted-foreground">
        <MailOpen className="h-10 w-10 opacity-30" />
        <span className="text-ui">选择一封邮件查看</span>
      </div>
    );
  }

  const m = selectedMessage;
  // 正文加载阶段：区分"正在加载正文"（读本地）和"正在请求邮件"（走邮件服务器）
  const stageKey = m ? `${m.uid}:${m.accountId}:${m.folder}` : null;
  const stage = stageKey ? bodyLoadingStage[stageKey] : undefined;
  const bodyLoadingText = stage === "network" ? "正在请求邮件..." : "正在加载正文...";
  // fetchBody 进行中（stage 存在）才显示 loading；stage 已清除说明加载完成
  // 此时 bodyText/bodyHtml 都空属于合法空正文（纯附件、日历邀请、加密内容）
  const isBodyLoading = Boolean(stage);

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

  // 打开附件：下载到临时目录后用系统默认应用打开
  const handleOpenAttachment = async (att: EmailAttachment) => {
    if (!gatewayUrl || !isTauri()) return;
    const account = accounts.find((a) => a.id === m.accountId);
    if (!account) return;
    setDownloading(att.filename);
    try {
      const tmp = await tempDir();
      // 避免文件名冲突：用 uid 作为前缀
      const safeName = att.filename.replace(/[<>:"/\\|?*]/g, "_");
      const filePath = await join(tmp, `mona-${m.uid}-${safeName}`);
      await emailApi.downloadAttachmentToFile(
        gatewayUrl,
        account,
        m.folder,
        m.uid,
        att.filename,
        filePath,
      );
      await openPathWithSystemApp(filePath);
    } catch (e) {
      console.error("打开附件失败:", e);
    } finally {
      setDownloading(null);
    }
  };

  // 保存全部附件：选择目录后批量下载
  const handleSaveAllAttachments = async () => {
    if (!gatewayUrl || !m.attachments) return;
    const account = accounts.find((a) => a.id === m.accountId);
    if (!account) return;
    const dir = await openDialog({ directory: true, multiple: false });
    if (!dir || typeof dir !== "string") return;
    setDownloading("__all__");
    try {
      for (const att of m.attachments) {
        const safeName = att.filename.replace(/[<>:"/\\|?*]/g, "_");
        const filePath = await join(dir, safeName);
        await emailApi.downloadAttachmentToFile(
          gatewayUrl,
          account,
          m.folder,
          m.uid,
          att.filename,
          filePath,
        );
      }
    } catch (e) {
      console.error("保存全部附件失败:", e);
    } finally {
      setDownloading(null);
    }
  };

  // 复制附件到剪贴板：下载到临时文件后用 Rust 命令复制文件到剪贴板
  const handleCopyAttachment = async (att: EmailAttachment) => {
    if (!gatewayUrl || !isTauri()) return;
    const account = accounts.find((a) => a.id === m.accountId);
    if (!account) return;
    try {
      const tmp = await tempDir();
      const safeName = att.filename.replace(/[<>:"/\\|?*]/g, "_");
      const filePath = await join(tmp, `mona-${m.uid}-${safeName}`);
      await emailApi.downloadAttachmentToFile(
        gatewayUrl,
        account,
        m.folder,
        m.uid,
        att.filename,
        filePath,
      );
      // 复制文件路径文本到剪贴板（Tauri clipboard-manager 仅支持文本，文件剪贴板需 OS 级 API）
      await navigator.clipboard.writeText(filePath);
    } catch (e) {
      console.error("复制附件失败:", e);
    }
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

  // 手动触发 AI 日程提取
  const handleExtractSchedule = async () => {
    if (!licenseActive) {
      onOpenSubscribe?.();
      return;
    }
    setExtractingSchedule(true);
    try {
      const base = await getServicesHttpBase();
      if (!base) {
        setScheduleExtractResult({
          title: "提取日程失败",
          description: "Gateway 未就绪，请稍后重试",
        });
        return;
      }
      const url = `${base}/email/schedule/extract-manual`;
      const resp = await httpFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: m.accountId,
          uid: m.uid,
          folder: m.folder,
        }),
      });
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const body = await resp.json();
          if (body?.error) msg = body.error;
        } catch {
          // ignore
        }
        setScheduleExtractResult({ title: "提取日程失败", description: msg });
        return;
      }
      const data = (await resp.json()) as { result: string };
      const result = data.result;
      const resultInfo =
        result === "created"
          ? { title: "日程已创建", description: "已从邮件创建日程" }
          : result === "pending"
            ? { title: "已加入待确认", description: "请前往计划收集箱确认日程" }
            : result === "skipped"
              ? { title: "未识别到日程", description: "这封邮件中没有可提取的日程信息" }
              : { title: "提取日程失败", description: "请稍后重试" };
      setScheduleExtractResult(resultInfo);
    } catch (e) {
      setScheduleExtractResult({
        title: "提取日程失败",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setExtractingSchedule(false);
    }
  };

  // 从 src 推断图片扩展名
  const inferImageExt = (src: string): string => {
    if (src.startsWith("data:")) {
      const m = src.match(/^data:image\/([a-zA-Z0-9.+-]+)/);
      if (m) {
        const sub = m[1].toLowerCase();
        if (sub === "jpeg") return "jpg";
        if (sub === "svg+xml") return "svg";
        return sub;
      }
      return "png";
    }
    try {
      const url = new URL(src);
      const last = url.pathname.split("/").pop() || "";
      const dot = last.lastIndexOf(".");
      if (dot > 0) {
        const ext = last.slice(dot + 1).toLowerCase();
        if (/^[a-z0-9]+$/.test(ext) && ext.length <= 5) return ext;
      }
    } catch {
      // ignore
    }
    return "png";
  };

  // 复制图片到剪贴板
  const handleCopyImage = async (src: string) => {
    setImageActionLoading(true);
    try {
      const blob = await fetchImageBlob(src);
      if (!blob) {
        window.alert("复制图片失败：无法获取图片数据");
        return;
      }
      try {
        // ClipboardItem 支持 PNG/JPEG 等，SVG 需转 PNG
        let pngBlob = blob;
        if (blob.type === "image/svg+xml") {
          const img = new Image();
          img.crossOrigin = "anonymous";
          const url = URL.createObjectURL(blob);
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("svg load failed"));
            img.src = url;
          });
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth || 800;
          canvas.height = img.naturalHeight || 600;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            pngBlob = await new Promise<Blob>((resolve) =>
              canvas.toBlob((b) => resolve(b ?? blob), "image/png"),
            );
          }
          URL.revokeObjectURL(url);
        }
        await navigator.clipboard.write([
          new ClipboardItem({ [pngBlob.type.startsWith("image/") ? pngBlob.type : "image/png"]: pngBlob }),
        ]);
      } catch {
        // ClipboardItem 不支持时，回退写入图片 URL 文本
        await navigator.clipboard.writeText(src);
        window.alert("已复制图片地址（当前环境不支持直接复制图片）");
      }
    } finally {
      setImageActionLoading(false);
      setImageContextMenu(null);
    }
  };

  // 图片另存为：下载到用户选择的路径
  const handleSaveImage = async (src: string) => {
    setImageActionLoading(true);
    try {
      const blob = await fetchImageBlob(src);
      if (!blob) {
        window.alert("保存图片失败：无法获取图片数据");
        return;
      }
      const ext = inferImageExt(src);
      const defaultName = `image_${Date.now()}.${ext}`;
      const savePath = await save({ defaultPath: defaultName });
      if (!savePath) return;
      const buf = new Uint8Array(await blob.arrayBuffer());
      await writeFile(savePath, buf);
    } catch (e) {
      console.error("保存图片失败:", e);
    } finally {
      setImageActionLoading(false);
      setImageContextMenu(null);
    }
  };

  // 共享图片：调用系统共享（WebView2 支持 navigator.share 时）
  const handleShareImage = async (src: string) => {
    setImageActionLoading(true);
    try {
      const blob = await fetchImageBlob(src);
      if (!blob) {
        window.alert("共享失败：无法获取图片数据");
        return;
      }
      const ext = inferImageExt(src);
      const file = new File([blob], `image.${ext}`, { type: blob.type || "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "共享图片" });
      } else if (navigator.share) {
        await navigator.share({ title: "共享图片", url: src.startsWith("data:") ? undefined : src });
      } else {
        window.alert("当前环境不支持系统共享");
      }
    } catch (e) {
      // 用户取消共享时也会抛 AbortError，静默忽略
      if ((e as Error)?.name !== "AbortError") {
        console.error("共享图片失败:", e);
      }
    } finally {
      setImageActionLoading(false);
      setImageContextMenu(null);
    }
  };

  return (
    <div className="flex h-full flex-col bg-editor-surface">
      <div className="shrink-0 border-b border-border bg-card px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 flex-1 text-body-lg font-semibold text-foreground">
            {m.subject || "(无主题)"}
          </h2>
          <TooltipProvider delayDuration={300}>
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => void toggleRead(gatewayUrl, m)}
                    aria-label={m.isRead ? "标记为未读" : "标记为已读"}
                  >
                    <MailOpen className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{m.isRead ? "标记为未读" : "标记为已读"}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => void toggleStarred(gatewayUrl, m)}
                    aria-label={m.isStarred ? "取消星标" : "星标"}
                  >
                    <Star
                      className={
                        m.isStarred
                          ? "h-3.5 w-3.5 fill-warning text-warning"
                          : "h-3.5 w-3.5"
                      }
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{m.isStarred ? "取消星标" : "星标"}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    disabled={exporting}
                    onClick={() => void handleExportEml()}
                    aria-label="导出为 .eml"
                  >
                    {exporting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FileDown className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>导出为 .eml</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    disabled={extractingSchedule}
                    onClick={() => void handleExtractSchedule()}
                    aria-label="提取日程"
                  >
                    {extractingSchedule ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CalendarPlus className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>提取日程</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>
        <div className="mt-2 flex flex-col gap-0.5 text-caption text-muted-foreground">
          <div className="flex gap-2">
            <span className="shrink-0 text-muted-foreground/70">发件人</span>
            <span className="min-w-0 truncate" title={formatSender(m.fromName, m.fromAddress)}>
              <SenderPopover
                displayName={resolveSenderDisplay(m.fromName, m.fromAddress, contactsByEmail)}
                email={m.fromAddress}
                accountId={selectedAccountId}
                inContacts={Boolean(contactsByEmail[m.fromAddress?.toLowerCase()])}
              />
            </span>
          </div>
          <div className="flex gap-2">
            <span className="shrink-0 text-muted-foreground/70">收件人</span>
            <span className="min-w-0 truncate" title={m.toAddresses}>
              {parseAddressListWithContacts(m.toAddresses, contactsByEmail).map((addr, idx) => (
                <span key={idx}>
                  {idx > 0 && ", "}
                  <SenderPopover
                    displayName={addr.name}
                    email={addr.email}
                    accountId={selectedAccountId}
                    inContacts={addr.inContacts}
                  />
                </span>
              ))}
            </span>
          </div>
          {m.ccAddresses && (
            <div className="flex gap-2">
              <span className="shrink-0 text-muted-foreground/70">抄送</span>
              <span className="min-w-0 truncate" title={m.ccAddresses}>
                {parseAddressListWithContacts(m.ccAddresses, contactsByEmail).map((addr, idx) => (
                  <span key={idx}>
                    {idx > 0 && ", "}
                    <SenderPopover
                      displayName={addr.name}
                      email={addr.email}
                      accountId={selectedAccountId}
                      inContacts={addr.inContacts}
                    />
                  </span>
                ))}
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="shrink-0 text-muted-foreground/70">时间</span>
            <span className="text-foreground">{formatFullDate(m.date)}</span>
          </div>
          {m.hasAttachments && m.attachments && m.attachments.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {m.attachments.map((att, idx) => (
                <ContextMenu key={idx}>
                  <ContextMenuTrigger asChild>
                    <div
                      className="group flex w-[220px] cursor-pointer items-center gap-2 rounded-xs px-2 py-1 transition-colors hover:bg-muted/60"
                      onDoubleClick={() => void handleOpenAttachment(att)}
                      title="双击打开"
                    >
                      {downloading === att.filename ? (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : attIcons[att.filename] ? (
                        <img
                          src={attIcons[att.filename]}
                          alt=""
                          className="h-4 w-4 shrink-0 object-contain"
                          draggable={false}
                        />
                      ) : (
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-caption text-foreground" title={att.filename}>
                        {att.filename}
                      </span>
                      <span className="shrink-0 text-micro text-muted-foreground">
                        {formatSize(att.size)}
                      </span>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="min-w-[160px]">
                    <ContextMenuItem onClick={() => void handleOpenAttachment(att)}>
                      <ExternalLink className="mr-2 h-3.5 w-3.5" />
                      打开
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => void handleDownloadAttachment(att.filename)}>
                      <Download className="mr-2 h-3.5 w-3.5" />
                      另存为...
                    </ContextMenuItem>
                    {m.attachments && m.attachments.length > 1 && (
                      <ContextMenuItem onClick={() => void handleSaveAllAttachments()}>
                        <FolderArchive className="mr-2 h-3.5 w-3.5" />
                        保存全部附件
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem onClick={() => void handleCopyAttachment(att)}>
                      <Copy className="mr-2 h-3.5 w-3.5" />
                      复制
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => window.alert("删除附件需要重写邮件内容，暂不支持。请通过另存为导出后转发处理。")}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      删除
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-editor-surface px-4 py-3 scrollbar-hover">
        {m.bodyError ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-muted-foreground">
            <span className="text-ui text-destructive">正文加载失败</span>
            <span className="max-w-md text-center text-caption text-muted-foreground">{m.bodyError}</span>
          </div>
        ) : !m.bodyFetched ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="ml-2 text-ui">{bodyLoadingText}</span>
          </div>
        ) : m.bodyHtml ? (
          <SafeHtmlFrame
            html={m.bodyHtml}
            onImageOpen={handleImageOpen}
            onImageMenu={handleImageMenu}
            onLinkClick={handleLinkClick}
          />
        ) : m.bodyText ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-ui leading-relaxed text-foreground">
            {m.bodyText}
          </pre>
        ) : isBodyLoading ? (
          // fetchBody 进行中：本地 .eml HEADER-only 或解析失败，store 已自动重试走 HTTP 拉取
          <div className="flex h-full min-h-[200px] items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="ml-2 text-ui">{bodyLoadingText}</span>
          </div>
        ) : (
          // fetchBody 已完成但 bodyText/bodyHtml 都空：合法空正文（纯附件、日历邀请、加密内容）
          // skill 第四节：合法空正文不得反复请求网络
          <div className="flex h-full min-h-[200px] items-center justify-center text-muted-foreground">
            <span className="text-ui">此邮件无可显示正文</span>
          </div>
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
      <AlertDialog
        open={!!scheduleExtractResult}
        onOpenChange={(open) => {
          if (!open) setScheduleExtractResult(null);
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{scheduleExtractResult?.title}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line text-ui">
              {scheduleExtractResult?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction className="h-8 text-caption">知道了</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {imagePreviewSrc && (
        <BodyImagePreviewModal src={imagePreviewSrc} onClose={() => setImagePreviewSrc(null)} />
      )}
      {imageContextMenu && (
        <BodyImageContextMenu
          src={imageContextMenu.src}
          x={imageContextMenu.x}
          y={imageContextMenu.y}
          loading={imageActionLoading}
          onCopy={() => void handleCopyImage(imageContextMenu.src)}
          onSave={() => void handleSaveImage(imageContextMenu.src)}
          onShare={() => void handleShareImage(imageContextMenu.src)}
          onClose={() => setImageContextMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * 邮件正文图片预览：左键点击图片后弹出，点击空白处或按 Esc 关闭。
 * 支持任意 src（http URL 或 data URL），放大显示并可滚动查看。
 */
function BodyImagePreviewModal({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-full max-w-full items-center justify-center overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt="邮件图片预览"
          className="max-h-[90vh] max-w-[90vw] object-contain"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 h-8 w-8 bg-black/40 text-white hover:bg-black/60 hover:text-white"
          onClick={onClose}
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

interface BodyImageContextMenuProps {
  src: string;
  x: number;
  y: number;
  loading: boolean;
  onCopy: () => void;
  onSave: () => void;
  onShare: () => void;
  onClose: () => void;
}

/**
 * 邮件正文图片右键自定义菜单。
 * 替代 WebView2 原生菜单，仅保留：复制图片、图片另存为、共享（一级菜单，无"更多工具"）。
 */
function BodyImageContextMenu({
  x,
  y,
  loading,
  onCopy,
  onSave,
  onShare,
  onClose,
}: BodyImageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击菜单外部或按 Esc 关闭
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 延迟绑定，避免触发菜单的同一次 mousedown 立即关闭
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", handleClick, true);
      window.addEventListener("contextmenu", handleClick, true);
      window.addEventListener("keydown", onKey, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", handleClick, true);
      window.removeEventListener("contextmenu", handleClick, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // 计算菜单位置，避免超出视口
  const menuWidth = 180;
  const menuHeight = 156;
  const left = Math.min(x, window.innerWidth - menuWidth - 8);
  const top = Math.min(y, window.innerHeight - menuHeight - 8);

  const items: { icon: typeof Copy; label: string; action: () => void }[] = [
    { icon: Copy, label: "复制图片", action: onCopy },
    { icon: ImageDown, label: "图片另存为", action: onSave },
    { icon: Share2, label: "共享", action: onShare },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-md"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, idx) => (
        <Button
          key={idx}
          type="button"
          variant="ghost"
          disabled={loading}
          onClick={item.action}
          className="h-auto w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-left text-ui font-normal text-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <item.icon className="h-3.5 w-3.5" />
          )}
          <span>{item.label}</span>
        </Button>
      ))}
    </div>
  );
}

interface SafeHtmlFrameProps {
  html: string;
  /** 左键点击图片时触发（直接打开预览） */
  onImageOpen?: (src: string) => void;
  /** 右键点击图片时触发（显示自定义菜单） */
  onImageMenu?: (src: string, x: number, y: number) => void;
  /** 点击链接时触发（用系统默认应用打开 URL） */
  onLinkClick?: (url: string) => void;
}

/**
 * 用 sandbox iframe 渲染邮件 HTML，脚本完全隔离无法执行。
 * allow-same-origin 让父页面可读取 contentDocument 调整高度（不带 allow-scripts，脚本仍不能跑）。
 * 通过父窗口访问 contentDocument 拦截 IMG 的 click/contextmenu，替换 WebView2 原生菜单。
 */
export function SafeHtmlFrame({ html, onImageOpen, onImageMenu, onLinkClick }: SafeHtmlFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(400);
  // 保存当前事件监听的解绑函数，用于 onLoad 时重新挂载前清理
  const detachListenersRef = useRef<(() => void) | null>(null);

  // 用 ref 保存最新回调，避免依赖变化时反复解绑/绑定事件监听
  const onImageOpenRef = useRef(onImageOpen);
  onImageOpenRef.current = onImageOpen;
  const onImageMenuRef = useRef(onImageMenu);
  onImageMenuRef.current = onImageMenu;
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;

  // 注入 CSS：默认自动换行防止溢出，但允许固定宽度内容横向滚动
  // img cursor: zoom-in 提示可点击放大
  const wrappedHtml = useMemo(() => {
    const wrapCss = `<style>
      html, body { margin: 0 !important; padding: 0 !important; }
      html { overflow-x: auto !important; overflow-y: hidden !important; }
      body { word-wrap: break-word !important; overflow-wrap: break-word !important; white-space: normal !important; min-width: 0 !important; overflow: hidden !important; }
      pre, code { white-space: pre-wrap !important; word-wrap: break-word !important; overflow-wrap: break-word !important; }
      table { table-layout: auto !important; word-break: break-word !important; }
      img { max-width: 100% !important; height: auto !important; cursor: zoom-in; }
      a { cursor: pointer; }
      div, p, span, td, th { word-wrap: break-word !important; overflow-wrap: break-word !important; }
    </style>`;
    const referrerMeta = `<meta name="referrer" content="no-referrer">`;
    if (html.includes("</head>")) {
      return html.replace("</head>", `${referrerMeta}${wrapCss}</head>`);
    }
    if (html.includes("<body")) {
      return `${referrerMeta}${wrapCss}${html}`;
    }
    return `${referrerMeta}${wrapCss}${html}`;
  }, [html]);

  // 在 iframe contentDocument 上挂载图片事件监听
  const attachListeners = (doc: Document) => {
    // 左键点击：先检测链接，再检测图片
    // 链接点击：阻止 iframe 内导航，交给父组件用系统默认应用打开 URL
    // 图片点击：直接打开预览（替代 WebView2 默认行为）
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      // 优先检测链接：向上查找最近的 A 标签（链接可能包裹在 span/em 等内联元素里）
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (anchor) {
        // 取原始 href 属性，避免 srcDoc 的 baseURI 把相对路径解析成 about:srcdoc/...
        const rawHref = anchor.getAttribute("href") || "";
        // 仅处理 http/https/mailto/tel 等外部链接，忽略锚点（#xxx）和 javascript:
        if (/^(https?:|mailto:|tel:)/i.test(rawHref)) {
          e.preventDefault();
          e.stopPropagation();
          onLinkClickRef.current?.(rawHref);
          return;
        }
      }
      if (target.tagName === "IMG") {
        const src = (target as HTMLImageElement).src;
        if (src) {
          e.preventDefault();
          e.stopPropagation();
          onImageOpenRef.current?.(src);
        }
      }
    };
    // 右键菜单：阻止 WebView2 原生菜单，显示自定义菜单
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target && target.tagName === "IMG") {
        const src = (target as HTMLImageElement).src;
        if (src) {
          e.preventDefault();
          e.stopPropagation();
          // iframe 内的 clientX/Y 是相对于 iframe 视口的坐标，
          // 需要加上 iframe 在父窗口中的偏移量，才能正确定位 fixed 菜单
          const iframe = iframeRef.current;
          const rect = iframe?.getBoundingClientRect();
          const offsetX = rect?.left ?? 0;
          const offsetY = rect?.top ?? 0;
          onImageMenuRef.current?.(src, e.clientX + offsetX, e.clientY + offsetY);
        }
      }
    };
    // 拖拽图片也阻止，避免 WebView2 触发图片拖放行为
    const handleDragStart = (e: Event) => {
      const target = e.target as Element | null;
      if (target && target.tagName === "IMG") {
        e.preventDefault();
      }
    };
    doc.addEventListener("click", handleClick, true);
    doc.addEventListener("contextmenu", handleContextMenu, true);
    doc.addEventListener("dragstart", handleDragStart, true);
    return () => {
      doc.removeEventListener("click", handleClick, true);
      doc.removeEventListener("contextmenu", handleContextMenu, true);
      doc.removeEventListener("dragstart", handleDragStart, true);
    };
  };

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
        detachListenersRef.current?.();
        detachListenersRef.current = attachListeners(doc);
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

  // 卸载时清理监听
  useEffect(() => {
    return () => {
      detachListenersRef.current?.();
      detachListenersRef.current = null;
    };
  }, []);

  // onLoad 时重新挂载监听器：srcDoc 变化后 iframe 会重新加载，contentDocument 被替换
  const handleLoad = () => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const h = doc.body?.scrollHeight ?? doc.documentElement?.scrollHeight ?? 400;
      setHeight(Math.max(h, 100));
      // 重新挂载事件监听（新的 contentDocument 上）
      detachListenersRef.current?.();
      detachListenersRef.current = attachListeners(doc);
    } catch {
      // ignore
    }
  };

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-same-origin"
      srcDoc={wrappedHtml}
      scrolling="auto"
      onLoad={handleLoad}
      className="w-full border-0"
      style={{ height: `${height}px`, minHeight: "200px", overflowX: "auto", overflowY: "hidden" }}
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
  high: "bg-destructive/15 text-destructive",
  normal: "bg-warning/15 text-warning",
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
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
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
          <span className="min-w-0 flex-1 truncate text-caption text-destructive">
            {error}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 text-micro text-destructive hover:text-destructive"
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
    <div className="shrink-0 border-t border-border bg-info/5">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-4 py-2">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-info" />
        <span className="text-caption font-semibold text-foreground">
          AI 内容分析
        </span>
        {analysis?.analyzedAt && (
          <span className="text-micro text-muted-foreground">
            {formatAnalysisTime(analysis.analyzedAt)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-micro text-muted-foreground hover:text-foreground"
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
          <div className="text-ui leading-relaxed text-foreground">
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
            <div className="flex items-center gap-1.5 text-micro text-destructive">
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
    category: "bg-info/15 text-info-strong",
    intent: "bg-primary/10 text-primary",
    urgency: "",
    sentiment: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-micro font-medium ${
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
    <div className="flex items-start gap-1.5 text-caption">
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
