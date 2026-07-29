import { invoke } from "@tauri-apps/api/core";
import type {
  BatchActionRequest,
  BatchActionResponse,
  EmailAccount,
  EmailAnalysis,
  EmailAttachment,
  EmailFolder,
  EmailMessage,
  EmailRule,
  EmailSearchRequest,
  EmailSearchResult,
  OutboxEmail,
} from "./types";

// ---------------------------------------------------------------------------
// 请求类型 — 必须与 Rust 侧 SyncRequest/SendRequest 的 camelCase 字段名一致
// ---------------------------------------------------------------------------

export interface SyncRequest {
  accountId: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  mailbox: string;
  useSsl: boolean;
  lastUid: string | null;
}

/// email_sync 返回值：新增邮件数 + 新邮件列表（规则应用后仍在当前文件夹的）
/// 前端可直接 prepend 到列表，无需全量 reload
export interface SyncResult {
  newCount: number;
  newMessages: EmailMessage[];
}

export interface EmailAttachmentInput {
  filename: string;
  contentType: string;
  data: string; // base64 编码（无 data: 前缀）
  /// 内联图片的 Content-ID（不含尖括号）。设置后附件以 inline 方式嵌入，
  /// HTML 中通过 cid:xxx 引用，避免被 Gmail/Outlook 剥离 data URI 图片。
  contentId?: string;
}

export interface SendRequest {
  accountId: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  useTls: boolean;
  useSsl: boolean;
  fromAddress: string;
  fromName?: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  inReplyTo: string | null;
  attachments?: EmailAttachmentInput[];
  // IMAP 配置：用于发送成功后通过 IMAP APPEND 保存副本到"已发送"文件夹
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  imapUseSsl: boolean;
}

// ---------------------------------------------------------------------------
// 辅助：从账号配置读取 SSL/TLS 设置（优先用显式字段，兼容旧数据按端口推断）
// ---------------------------------------------------------------------------

function imapSsl(account: EmailAccount): boolean {
  return account.imapUseSsl ?? account.imapPort === 993;
}

function smtpTls(account: EmailAccount): { useTls: boolean; useSsl: boolean } {
  if (account.smtpUseSsl) return { useTls: false, useSsl: true };
  // 465 = SMTPS (SSL)，587 = STARTTLS
  if (account.smtpPort === 465) return { useTls: false, useSsl: true };
  return { useTls: true, useSsl: false };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textToHtml(text: string): string {
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(text)}</div>`;
}

function parseAddressList(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tauri invoke 封装
// ---------------------------------------------------------------------------

export async function listAccounts(): Promise<EmailAccount[]> {
  return invoke<EmailAccount[]>("email_list_accounts");
}

export async function addAccount(account: EmailAccount): Promise<void> {
  return invoke("email_add_account", { account });
}

/**
 * 更新账号设置（不会双重加密密码）。
 *
 * - 如果 newPassword 非空，会加密后写入数据库
 * - 如果 newPassword 为 null/undefined/空字符串，保留数据库原密码
 *
 * 用于账号设置对话框：用户不修改密码时不会破坏已有密码。
 */
export async function updateAccountSettings(
  account: EmailAccount,
  newPassword?: string | null,
): Promise<void> {
  return invoke("email_update_account_settings", {
    account,
    newPassword: newPassword && newPassword.trim() ? newPassword : null,
  });
}

export async function deleteAccount(
  gatewayUrl: string,
  accountId: string,
): Promise<void> {
  return invoke("email_delete_account", { gatewayUrl, accountId });
}

export interface TestConnectionRequest {
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  useSsl: boolean;
}

export interface TestConnectionResponse {
  ok: boolean;
  folders?: number;
}

export async function testConnection(
  gatewayUrl: string,
  account: EmailAccount,
  password: string,
): Promise<TestConnectionResponse> {
  const req: TestConnectionRequest = {
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword: password,
    useSsl: imapSsl(account),
  };
  return invoke<TestConnectionResponse>("email_test_connection", { gatewayUrl, req });
}

export interface DeleteRequest {
  accountId: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  mailbox: string;
  uid: string;
  useSsl: boolean;
}

export async function deleteMessage(
  gatewayUrl: string,
  account: EmailAccount,
  mailbox: string,
  uid: string,
): Promise<void> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req: DeleteRequest = {
    accountId: account.id,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    mailbox,
    uid,
    useSsl: imapSsl(account),
  };
  return invoke("email_delete_message", { gatewayUrl, req });
}

export async function getMessages(
  accountId: string,
  folder: string,
  beforeUid: string | null,
  limit: number,
): Promise<EmailMessage[]> {
  return invoke<EmailMessage[]>("email_get_messages", {
    accountId,
    folder,
    beforeUid,
    limit,
  });
}

/// 统一收件箱：聚合所有账号 INBOX，按日期降序，使用 date 作为游标
export async function getUnifiedInbox(
  beforeDate: string | null,
  limit: number,
): Promise<EmailMessage[]> {
  return invoke<EmailMessage[]>("email_get_unified_inbox", {
    beforeDate,
    limit,
  });
}

/// 账号颜色调色板（用于统一收件箱中区分不同账号）
export const ACCOUNT_COLORS = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
];

export function getAccountColor(
  accountId: string,
  accounts: EmailAccount[],
): string {
  const idx = accounts.findIndex((a) => a.id === accountId);
  if (idx < 0) return "#6b7280";
  return ACCOUNT_COLORS[idx % ACCOUNT_COLORS.length];
}

export interface SetFlagRequest {
  accountId: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  mailbox: string;
  uid: string;
  flag: string;
  add: boolean;
  useSsl: boolean;
}

export async function markRead(
  gatewayUrl: string,
  account: EmailAccount,
  mailbox: string,
  uid: string,
  isRead: boolean,
): Promise<void> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req: SetFlagRequest = {
    accountId: account.id,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    mailbox,
    uid,
    flag: "\\Seen",
    add: isRead,
    useSsl: imapSsl(account),
  };
  return invoke("email_mark_read", { gatewayUrl, req });
}

export async function toggleStarred(
  gatewayUrl: string,
  account: EmailAccount,
  mailbox: string,
  uid: string,
  starred: boolean,
): Promise<void> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req: SetFlagRequest = {
    accountId: account.id,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    mailbox,
    uid,
    flag: "\\Flagged",
    add: starred,
    useSsl: imapSsl(account),
  };
  return invoke("email_toggle_starred", { gatewayUrl, req });
}

export interface FolderActionPayload {
  accountId: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  mailbox: string;
  useSsl: boolean;
}

/// 将指定文件夹所有邮件标记为已读
export async function markAllRead(
  gatewayUrl: string,
  account: EmailAccount,
  mailbox: string,
): Promise<number> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req: FolderActionPayload = {
    accountId: account.id,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    mailbox,
    useSsl: imapSsl(account),
  };
  return invoke<number>("email_mark_all_read", { gatewayUrl, req });
}

/// 清空指定文件夹中的所有邮件
export async function emptyFolder(
  gatewayUrl: string,
  account: EmailAccount,
  mailbox: string,
): Promise<number> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req: FolderActionPayload = {
    accountId: account.id,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    mailbox,
    useSsl: imapSsl(account),
  };
  return invoke<number>("email_empty_folder", { gatewayUrl, req });
}

export interface MoveRequest {
  accountId: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  mailbox: string;
  destMailbox: string;
  uid: string;
  useSsl: boolean;
}

export async function moveMessage(
  gatewayUrl: string,
  account: EmailAccount,
  mailbox: string,
  destMailbox: string,
  uid: string,
): Promise<void> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req: MoveRequest = {
    accountId: account.id,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    mailbox,
    destMailbox,
    uid,
    useSsl: imapSsl(account),
  };
  return invoke("email_move_message", { gatewayUrl, req });
}

export interface FetchAttachmentRequest {
  accountId: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  mailbox: string;
  uid: string;
  filename: string;
  useSsl: boolean;
}

export interface FetchAttachmentResponse {
  filename: string;
  contentType: string;
  size: number;
  data: string; // base64
}

export async function fetchAttachment(
  gatewayUrl: string,
  account: EmailAccount,
  mailbox: string,
  uid: string,
  filename: string,
): Promise<FetchAttachmentResponse> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req: FetchAttachmentRequest = {
    accountId: account.id,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    mailbox,
    uid,
    filename,
    useSsl: imapSsl(account),
  };
  return invoke<FetchAttachmentResponse>("email_fetch_attachment", { gatewayUrl, req });
}

/// 直接下载附件到指定文件路径，避免前端处理大 base64 字符串（适合大附件）
export async function downloadAttachmentToFile(
  gatewayUrl: string,
  account: EmailAccount,
  mailbox: string,
  uid: string,
  filename: string,
  savePath: string,
): Promise<number> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req: FetchAttachmentRequest = {
    accountId: account.id,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    mailbox,
    uid,
    filename,
    useSsl: imapSsl(account),
  };
  return invoke<number>("email_download_attachment_to_file", { gatewayUrl, req, savePath });
}

/// 按需拉取单封邮件的完整正文
/// 优先走本地 Tauri IPC（读 .eml + mailparse，毫秒级）
/// 本地 .eml 不存在或解析失败时，回退到邮件服务 HTTP 拉取（需传 serviceUrl）
export async function fetchEmailBody(
  accountId: string,
  uid: string,
  mailbox: string,
  serviceUrl?: string,
): Promise<FetchEmailBodyResult> {
  return invoke<FetchEmailBodyResult>("email_fetch_body", {
    accountId,
    uid,
    mailbox,
    gatewayUrl: serviceUrl ?? "",
  });
}

export interface FetchEmailBodyResult {
  bodyText: string;
  bodyHtml: string | null;
  attachments?: EmailAttachment[];
  /** 重新解析的 header（用于修复旧数据中可能的乱码，如 gb2312→gb18030 修复前的旧邮件） */
  header?: {
    subject: string;
    fromAddress: string;
    fromName: string;
    toAddresses: string;
    ccAddresses: string;
  };
}

/// 拉取邮件原始 RFC822 字节（用于 .eml 导出）
export async function fetchRawEmail(
  gatewayUrl: string,
  accountId: string,
  uid: string,
  mailbox: string,
): Promise<{ rawBase64: string; size: number }> {
  return invoke<{ rawBase64: string; size: number }>("email_fetch_raw", {
    gatewayUrl,
    accountId,
    uid,
    mailbox,
  });
}

/// 全量重建邮件索引（从本地 .eml 文件重新解析 header）
/// 用于修复旧数据中邮件头乱码（to/cc/from/subject 未解码 MIME encoded-word）
export async function rebuildEmailIndex(): Promise<{ count: number }> {
  return invoke<{ count: number }>("email_rebuild_index");
}

// ---------------------------------------------------------------------------
// 邮件规则/过滤器
// ---------------------------------------------------------------------------

export async function listRules(accountId: string): Promise<EmailRule[]> {
  return invoke<EmailRule[]>("email_list_rules", { accountId });
}

export async function saveRule(rule: EmailRule): Promise<void> {
  return invoke<void>("email_save_rule", { rule });
}

export async function deleteRule(ruleId: string): Promise<void> {
  return invoke<void>("email_delete_rule", { ruleId });
}

/** 对账号下已有邮件批量应用收件规则（用于规则创建后归类历史邮件） */
export async function applyRules(
  gatewayUrl: string,
  accountId: string,
): Promise<{
  matched: number;
  success: number;
  failed: number;
  errors: string[];
  inboxTotal?: number;
  diagRules?: Array<{ name: string; conditionField: string; conditionValue: string; action: string; actionTarget: string | null }>;
  diagFroms?: string[];
}> {
  return invoke<{
    matched: number;
    success: number;
    failed: number;
    errors: string[];
    inboxTotal?: number;
    diagRules?: Array<{ name: string; conditionField: string; conditionValue: string; action: string; actionTarget: string | null }>;
    diagFroms?: string[];
  }>("email_apply_rules", { gatewayUrl, accountId });
}

// ---------------------------------------------------------------------------
// 延迟发送（outbox）
// ---------------------------------------------------------------------------

export async function outboxAdd(email: OutboxEmail): Promise<void> {
  return invoke<void>("email_outbox_add", { email });
}

export async function outboxList(accountId: string): Promise<OutboxEmail[]> {
  return invoke<OutboxEmail[]>("email_outbox_list", { accountId });
}

export async function outboxDelete(id: string): Promise<void> {
  return invoke<void>("email_outbox_delete", { id });
}

export async function outboxProcess(gatewayUrl: string): Promise<number> {
  return invoke<number>("email_outbox_process", { gatewayUrl });
}

export interface SaveDraftRequest {
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  useSsl: boolean;
  fromAddress: string;
  fromName?: string | null;
  to: string[];
  cc: string[];
  subject: string;
  bodyHtml: string;
  inReplyTo: string | null;
  attachments?: EmailAttachmentInput[];
}

export async function saveDraft(
  gatewayUrl: string,
  account: EmailAccount,
  payload: SendEmailPayload,
): Promise<void> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const to = parseAddressList(payload.toAddresses);
  const cc = payload.ccAddresses ? parseAddressList(payload.ccAddresses) : [];
  const bodyHtml = payload.bodyHtml ?? textToHtml(payload.bodyText);
  const req: SaveDraftRequest = {
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    useSsl: imapSsl(account),
    fromAddress: account.fromAddress,
    fromName: account.fromName ?? null,
    to,
    cc,
    subject: payload.subject,
    bodyHtml,
    inReplyTo: payload.inReplyTo ?? null,
    attachments: payload.attachments,
  };
  return invoke("email_save_draft", { gatewayUrl, req });
}

export async function getDecryptedPassword(
  accountId: string,
  field: "imap" | "smtp",
): Promise<string> {
  return invoke<string>("email_get_decrypted_password", { accountId, field });
}

// ---------------------------------------------------------------------------
// 收信：前端 → Rust email_sync → Python /email/sync → IMAP
// ---------------------------------------------------------------------------

export async function syncEmail(
  gatewayUrl: string,
  account: EmailAccount,
  mailbox: string = "INBOX",
): Promise<SyncResult> {
  // Rust 侧 field 只接受 "imap" 或 "smtp"
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req: SyncRequest = {
    accountId: account.id,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    mailbox,
    useSsl: imapSsl(account),
    lastUid: account.lastSyncedUid ?? null,
  };
  return invoke<SyncResult>("email_sync", { gatewayUrl, req });
}

// ---------------------------------------------------------------------------
// IMAP IDLE 实时推送：启动/停止指定账号的 IDLE 监听
// ---------------------------------------------------------------------------

export async function startIdle(
  gatewayUrl: string,
  account: EmailAccount,
  mailbox: string = "INBOX",
): Promise<void> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  await invoke("email_start_idle", {
    gatewayUrl,
    req: {
      accountId: account.id,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapUsername: account.imapUsername,
      imapPassword,
      mailbox,
      useSsl: imapSsl(account),
    },
  });
}

export async function stopIdle(gatewayUrl: string, accountId: string): Promise<void> {
  await invoke("email_stop_idle", { gatewayUrl, accountId });
}

// ---------------------------------------------------------------------------
// 文件夹列表：前端 → Rust email_list_folders → Python /email/folders → IMAP
// ---------------------------------------------------------------------------

export interface CreateFolderRequest {
  accountId: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  mailbox: string;
  useSsl: boolean;
}

export async function createFolder(
  gatewayUrl: string,
  account: EmailAccount,
  folderName: string,
): Promise<void> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req: CreateFolderRequest = {
    accountId: account.id,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    mailbox: folderName,
    useSsl: imapSsl(account),
  };
  return invoke("email_create_folder", { gatewayUrl, req });
}

export async function renameFolder(
  gatewayUrl: string,
  account: EmailAccount,
  oldName: string,
  newName: string,
): Promise<void> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req = {
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    useSsl: imapSsl(account),
    oldName,
    newName,
  };
  const resp = await fetch(`${gatewayUrl}/email/rename_folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`重命名文件夹失败: ${resp.status} ${detail}`);
  }
}

export async function deleteFolder(
  gatewayUrl: string,
  account: EmailAccount,
  folderName: string,
): Promise<void> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  const req = {
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    useSsl: imapSsl(account),
    folderName,
  };
  const resp = await fetch(`${gatewayUrl}/email/delete_folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`删除文件夹失败: ${resp.status} ${detail}`);
  }
}

export async function listFolders(
  gatewayUrl: string,
  account: EmailAccount,
): Promise<EmailFolder[]> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  return invoke<EmailFolder[]>("email_list_folders", {
    gatewayUrl,
    req: {
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapUsername: account.imapUsername,
      imapPassword,
      useSsl: imapSsl(account),
    },
  });
}

/// 从本地 SQLite 读取账号的文件夹缓存（不访问 IMAP，立即返回）
export async function getFolders(accountId: string): Promise<EmailFolder[]> {
  return invoke<EmailFolder[]>("email_get_folders", { accountId });
}

/// 连接 IMAP 同步文件夹列表并回写本地缓存
export async function syncFolders(
  gatewayUrl: string,
  account: EmailAccount,
): Promise<EmailFolder[]> {
  const imapPassword = await getDecryptedPassword(account.id, "imap");
  return invoke<EmailFolder[]>("email_sync_folders", {
    gatewayUrl,
    accountId: account.id,
    req: {
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapUsername: account.imapUsername,
      imapPassword,
      useSsl: imapSsl(account),
    },
  });
}

/// 从本地数据库统计各文件夹未读数
export async function getUnreadCounts(
  accountId: string,
): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("email_unread_counts", { accountId });
}

export interface FolderStatistics {
  folder: string;
  count: number;
  size: number;
}

export interface EmailStatistics {
  accountId: string;
  totalCount: number;
  totalSize: number;
  folders: FolderStatistics[];
}

/// 从本地数据库统计账号下各文件夹的邮件数量和占用空间
export async function getEmailStatistics(
  accountId: string,
): Promise<EmailStatistics> {
  return invoke<EmailStatistics>("email_statistics", { accountId });
}

// ---------------------------------------------------------------------------
// 发信：前端 → Rust email_send → Python /email/send → SMTP
// ---------------------------------------------------------------------------

export interface SendEmailPayload {
  toAddresses: string; // 逗号或空格分隔的收件人
  ccAddresses?: string; // 逗号或空格分隔的抄送
  bccAddresses?: string; // 逗号或空格分隔的密送
  subject: string;
  bodyText: string; // 纯文本正文
  bodyHtml?: string | null; // 可选 HTML 正文，若为空则从 bodyText 转换
  inReplyTo?: string | null; // 回复时的 Message-ID
  attachments?: EmailAttachmentInput[]; // 附件列表
}

export interface OpenComposeWindowRequest {
  mode: "compose" | "reply" | "replyAll" | "forward";
  accountId: string;
  baseMessage?: EmailMessage | null;
  /** 预设收件人（点击发件人名称写邮件时使用） */
  presetTo?: string | null;
}

export async function openComposeWindow(
  req: OpenComposeWindowRequest,
): Promise<string> {
  return invoke<string>("email_open_compose_window", { payload: req });
}

export async function sendEmail(
  gatewayUrl: string,
  account: EmailAccount,
  payload: SendEmailPayload,
): Promise<void> {
  const [smtpPassword, imapPassword] = await Promise.all([
    getDecryptedPassword(account.id, "smtp"),
    getDecryptedPassword(account.id, "imap"),
  ]);
  const { useTls, useSsl } = smtpTls(account);
  const to = parseAddressList(payload.toAddresses);
  const cc = payload.ccAddresses ? parseAddressList(payload.ccAddresses) : [];
  const bcc = payload.bccAddresses ? parseAddressList(payload.bccAddresses) : [];
  const bodyHtml = payload.bodyHtml ?? textToHtml(payload.bodyText);

  // 将 bodyHtml 中的 base64 内嵌图片转换为 CID 内联附件。
  // Gmail/Outlook 等主流邮件客户端会剥离 data URI 图片，必须用 cid 引用。
  const { html: htmlWithCid, inlineImages } = extractInlineImagesAsAttachments(bodyHtml);

  const req: SendRequest = {
    accountId: account.id,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpUsername: account.smtpUsername,
    smtpPassword,
    useTls,
    useSsl,
    fromAddress: account.fromAddress,
    fromName: account.fromName ?? null,
    to,
    cc,
    bcc,
    subject: payload.subject,
    bodyHtml: htmlWithCid,
    inReplyTo: payload.inReplyTo ?? null,
    attachments: [...(payload.attachments ?? []), ...inlineImages],
    // IMAP 配置：用于发送成功后保存副本到"已发送"
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapUsername: account.imapUsername,
    imapPassword,
    imapUseSsl: imapSsl(account),
  };
  return invoke("email_send", { gatewayUrl, req });
}

/**
 * 扫描 HTML 中的 data:image/...;base64,... 图片，提取为内联附件，
 * 并把 src 替换为 cid:xxx 引用。
 *
 * 邮件客户端（Gmail/Outlook 等）出于安全考虑会剥离 data URI 图片，
 * 必须把图片作为 MIME 内联附件（带 Content-ID）发送，HTML 中用 cid 引用。
 */
function extractInlineImagesAsAttachments(html: string): {
  html: string;
  inlineImages: EmailAttachmentInput[];
} {
  const inlineImages: EmailAttachmentInput[] = [];
  let idx = 0;
  // 匹配 <img src="data:image/png;base64,xxxx"> 或单引号变体
  const result = html.replace(
    /src=["'](data:image\/([^;]+);base64,([^"']+))["']/gi,
    (_m, _fullDataUrl: string, ext: string, base64: string) => {
      idx += 1;
      const cid = `inline-image-${idx}-${Date.now()}`;
      const mime = `image/${ext.toLowerCase()}`;
      const filename = `image-${idx}.${ext.toLowerCase() === "jpeg" ? "jpg" : ext.toLowerCase()}`;
      inlineImages.push({
        filename,
        contentType: mime,
        data: base64,
        contentId: cid,
      });
      return `src="cid:${cid}"`;
    },
  );
  return { html: result, inlineImages };
}

// ---------------------------------------------------------------------------
// AI 邮件分析（人工单次触发）
// ---------------------------------------------------------------------------

export interface AnalyzeImage {
  /** base64 编码（无 data: 前缀） */
  data: string;
  /** MIME 类型，如 "image/png" */
  mime: string;
}

export interface AnalyzeEmailRequest {
  subject: string;
  fromAddress: string;
  fromName?: string | null;
  date: string;
  bodyText: string;
  bodyHtml?: string | null;
  images?: AnalyzeImage[];
}

export interface AnalyzeEmailResponse {
  summary: string;
  category: string;
  intent: string;
  urgency: string;
  sentiment: string;
  keyInfo: string; // JSON 字符串
}

/// 单次分析最多传入的图片数量
const MAX_ANALYZE_IMAGES = 3;
/// 大图压缩上限（长边像素）
const MAX_IMAGE_DIMENSION = 1024;

/**
 * 从邮件 bodyHtml 中提取 base64 内嵌图片。
 * 只提取 data:image/...;base64,... 格式的图片。
 */
function extractInlineImages(bodyHtml: string | null | undefined): AnalyzeImage[] {
  if (!bodyHtml) return [];
  const images: AnalyzeImage[] = [];
  // 匹配 <img src="data:image/png;base64,xxxx">
  const imgRegex = /<img[^>]+src=["'](data:image\/([^;]+);base64,([^"']+))["']/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(bodyHtml)) !== null) {
    const mime = `image/${match[2].toLowerCase()}`;
    const data = match[3];
    if (data) {
      images.push({ data, mime });
    }
  }
  return images;
}

/**
 * 压缩图片：如果长边超过 MAX_IMAGE_DIMENSION，按比例缩小。
 * 输入为 AnalyzeImage（base64），输出为压缩后的 AnalyzeImage。
 * 压缩使用 canvas，输出 PNG。
 */
async function compressImage(img: AnalyzeImage): Promise<AnalyzeImage> {
  try {
    const blob = await (await fetch(`data:${img.mime};base64,${img.data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const longSide = Math.max(width, height);
    if (longSide <= MAX_IMAGE_DIMENSION) {
      return img; // 无需压缩
    }
    const scale = MAX_IMAGE_DIMENSION / longSide;
    const newW = Math.round(width * scale);
    const newH = Math.round(height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = newW;
    canvas.height = newH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return img;
    ctx.drawImage(bitmap, 0, 0, newW, newH);
    const dataUrl = canvas.toDataURL("image/png");
    // dataUrl 格式：data:image/png;base64,xxxx
    const base64 = dataUrl.split(",")[1] || "";
    return { data: base64, mime: "image/png" };
  } catch {
    // 压缩失败时返回原图
    return img;
  }
}

/**
 * 从邮件中提取并预处理图片，用于 AI 分析。
 * 来源：bodyHtml 中的 base64 内嵌图片 + 附件中的图片（需先下载）。
 * 限制最多 MAX_ANALYZE_IMAGES 张，大图压缩。
 */
export async function prepareAnalyzeImages(
  gatewayUrl: string,
  message: EmailMessage,
  account: EmailAccount | null,
): Promise<AnalyzeImage[]> {
  // 1. 提取 bodyHtml 中的内嵌图片
  const inlineImages = extractInlineImages(message.bodyHtml);

  // 2. 提取附件中的图片
  const attachmentImages: AnalyzeImage[] = [];
  if (message.attachments && account) {
    for (const att of message.attachments) {
      if (attachmentImages.length + inlineImages.length >= MAX_ANALYZE_IMAGES) break;
      if (!att.contentType.startsWith("image/")) continue;
      try {
        const resp = await fetchAttachment(
          gatewayUrl,
          account,
          message.folder,
          message.uid,
          att.filename,
        );
        if (resp.data) {
          attachmentImages.push({ data: resp.data, mime: att.contentType });
        }
      } catch {
        // 附件下载失败时跳过
      }
    }
  }

  // 3. 合并、截断、压缩
  const all = [...inlineImages, ...attachmentImages].slice(0, MAX_ANALYZE_IMAGES);
  return Promise.all(all.map(compressImage));
}

/// 调用 Rust 命令转发到 Python 后端分析邮件（不存储，仅返回结果）
/// 通过 Rust 转发避免前端跨域问题
export async function analyzeEmail(
  gatewayUrl: string,
  message: EmailMessage,
  images: AnalyzeImage[] = [],
): Promise<AnalyzeEmailResponse> {
  const req: AnalyzeEmailRequest = {
    subject: message.subject,
    fromAddress: message.fromAddress,
    fromName: message.fromName ?? null,
    date: message.date,
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml ?? null,
    images,
  };
  return invoke<AnalyzeEmailResponse>("email_analyze", { gatewayUrl, req });
}

/// 从本地 SQLite 读取缓存的 AI 分析结果
export async function getEmailAnalysis(
  uid: string,
  accountId: string,
  folder: string,
): Promise<EmailAnalysis | null> {
  return invoke<EmailAnalysis | null>("email_get_analysis", { uid, accountId, folder });
}

/// 保存 AI 分析结果到本地 SQLite
export async function saveEmailAnalysis(
  analysis: EmailAnalysis,
): Promise<void> {
  return invoke("email_save_analysis", { analysis });
}

// ---------------------------------------------------------------------------
// 邮件搜索（跨文件夹/跨账号，SQL LIKE）
// ---------------------------------------------------------------------------

/// 搜索本地邮件数据库，支持多条件筛选
export async function searchMessages(
  req: EmailSearchRequest,
): Promise<EmailSearchResult[]> {
  return invoke<EmailSearchResult[]>("email_search_messages", { req });
}

// ---------------------------------------------------------------------------
// 批量操作（用户确认 AI 建议后执行）
// ---------------------------------------------------------------------------

/// 批量操作邮件：标记已读/未读、加/取消星标、移动、删除
/// 用户在前端确认 AI 的操作建议后调用此命令实际执行
export async function batchAction(
  gatewayUrl: string,
  req: BatchActionRequest,
): Promise<BatchActionResponse> {
  return invoke<BatchActionResponse>("email_batch_action", { gatewayUrl, req });
}

/// 重置指定账号的 IMAP 连接池（删除账号/修改配置/连接异常时调用）
export async function resetImapPool(
  gatewayUrl: string,
  account: EmailAccount,
): Promise<void> {
  const resp = await fetch(`${gatewayUrl}/email/reset_pool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imapHost: account.imapHost,
      imapUsername: account.imapUsername,
    }),
  });
  if (!resp.ok) {
    // 重置失败不阻塞业务流程，只记录日志
    console.warn("[email] resetImapPool failed:", resp.status);
  }
}
