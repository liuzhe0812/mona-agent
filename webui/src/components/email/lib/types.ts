export interface EmailAccount {
  id: string;
  displayName: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  fromAddress: string;
  /** 发信名称（发邮件时 From 头的显示名），为空时使用 fromAddress */
  fromName?: string | null;
  lastSyncedUid?: string | null;
  /** CardDAV 地址簿服务地址（为空表示不同步通讯录） */
  carddavUrl?: string | null;
  /** Exchange ActiveSync 服务地址（企业邮通讯录同步，为空表示不使用） */
  easUrl?: string | null;
  /** IMAP 是否使用 SSL */
  imapUseSsl: boolean;
  /** SMTP 是否使用 SSL（465 端口），587 用 STARTTLS */
  smtpUseSsl: boolean;
  /** 签名列表 */
  signatures?: EmailSignature[];
}

export interface EmailSignature {
  id: string;
  name: string;
  /** 签名内容（HTML） */
  content: string;
  isDefault?: boolean;
}

export interface EmailRule {
  id: string;
  accountId: string;
  name: string;
  /** 条件字段：from_contains / subject_contains / to_contains */
  conditionField: string;
  conditionValue: string;
  /** 动作：move / mark_read / star / delete */
  action: string;
  /** 动作目标（move 时为目标文件夹） */
  actionTarget?: string | null;
  enabled?: boolean;
  priority?: number;
}

export interface OutboxEmail {
  id: string;
  accountId: string;
  toAddresses: string;
  ccAddresses?: string | null;
  bccAddresses?: string | null;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  inReplyTo?: string | null;
  attachmentsJson?: string | null;
  /** 计划发送时间（ISO 8601） */
  scheduledAt: string;
  /** 状态：pending / sent / failed */
  status: string;
  error?: string | null;
  createdAt: string;
}

export interface EmailMessage {
  uid: string;
  accountId: string;
  folder: string;
  subject: string;
  fromAddress: string;
  fromName?: string | null;
  toAddresses: string;
  ccAddresses?: string | null;
  date: string;
  bodyText: string;
  bodyHtml?: string | null;
  hasAttachments: boolean;
  isRead: boolean;
  isStarred: boolean;
  rawSize: number;
  messageId?: string | null;
  attachments?: EmailAttachment[];
  /** 正文是否已拉取（按需拉取模式下，未拉取时点击邮件才加载） */
  bodyFetched?: boolean;
  /** 拉取正文失败时的错误信息（用于 UI 显示，避免永远 loading） */
  bodyError?: string | null;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  partId: string;
}

export interface EmailFolder {
  name: string;
  delimiter: string;
  hasChildren: boolean;
  flags: string;
  unreadCount?: number;
}

// ---------------------------------------------------------------------------
// AI 邮件分析结果（人工单次触发）
// ---------------------------------------------------------------------------

export type EmailCategory =
  | "work"
  | "personal"
  | "finance"
  | "notification"
  | "marketing"
  | "social";

export type EmailIntent =
  | "needs_reply"
  | "needs_action"
  | "notify_only"
  | "needs_approval"
  | "spam";

export type EmailUrgency = "high" | "normal" | "low";
export type EmailSentiment = "positive" | "neutral" | "negative";

export interface KeyInfoItem {
  date?: string;
  description?: string;
  value?: string;
  currency?: string;
  context?: string;
  task?: string;
  url?: string;
}

export interface EmailKeyInfo {
  dates: KeyInfoItem[];
  amounts: KeyInfoItem[];
  deadlines: KeyInfoItem[];
  links: KeyInfoItem[];
}

export interface EmailAnalysis {
  uid: string;
  accountId: string;
  folder: string;
  summary: string;
  category: string;
  intent: string;
  urgency: string;
  sentiment: string;
  keyInfo: string; // JSON 字符串，由前端解析为 EmailKeyInfo
  analyzedAt: string;
}

// ---------------------------------------------------------------------------
// 邮件搜索（跨文件夹/跨账号）
// ---------------------------------------------------------------------------

export interface EmailSearchResult {
  uid: string;
  accountId: string;
  folder: string;
  subject: string;
  fromAddress: string;
  fromName?: string | null;
  toAddresses: string;
  date: string;
  hasAttachments: boolean;
  isRead: boolean;
  isStarred: boolean;
  rawSize: number;
}

export interface EmailSearchRequest {
  accountId?: string;
  folder?: string;
  keyword?: string;
  fromAddress?: string;
  fromName?: string;
  dateFrom?: string;
  dateTo?: string;
  isRead?: boolean;
  isStarred?: boolean;
  hasAttachments?: boolean;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// 批量操作
// ---------------------------------------------------------------------------

export type EmailBatchAction =
  | "mark_read"
  | "mark_unread"
  | "star"
  | "unstar"
  | "move"
  | "delete";

export interface BatchActionTarget {
  uid: string;
  accountId: string;
  folder: string;
}

export interface BatchActionRequest {
  action: EmailBatchAction;
  messages: BatchActionTarget[];
  destFolder?: string | null;
}

export interface BatchActionResponse {
  success: number;
  failed: number;
  errors: string[];
}
