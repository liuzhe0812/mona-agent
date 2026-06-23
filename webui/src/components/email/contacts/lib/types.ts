// 联系人（地址簿）相关类型定义，字段与 Rust 侧 contacts.rs 的 camelCase 序列化对齐

export type ContactSource = "carddav" | "eas" | "manual";

export interface Contact {
  id: string;
  accountId: string;
  source: ContactSource;
  remoteUid?: string | null;
  etag?: string | null;
  displayName: string;
  email?: string | null;
  /** 其他邮箱列表（JSON 数组字符串，由前端解析） */
  emailList?: string | null;
  phone?: string | null;
  organization?: string | null;
  title?: string | null;
  note?: string | null;
  rawVcard?: string | null;
  /** 服务器端最后修改时间（Unix 秒） */
  lastModified?: number | null;
  /** 本地最后更新时间（Unix 秒） */
  updatedAt: number;
}

export interface ContactSyncState {
  accountId: string;
  syncToken?: string | null;
  lastSyncedAt?: number | null;
  lastSyncStatus?: string | null;
  lastError?: string | null;
}

export interface ContactSyncResult {
  added: number;
  updated: number;
  deleted: number;
  total: number;
  error?: string | null;
}

export interface CardDavTestResponse {
  ok: boolean;
  contactsCount?: number;
  error?: string | null;
}

/** 解析 emailList JSON 字段为字符串数组 */
export function parseEmailList(emailList: string | null | undefined): string[] {
  if (!emailList) return [];
  try {
    const arr = JSON.parse(emailList);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** 获取联系人的所有邮箱（主邮箱 + 其他邮箱） */
export function getAllEmails(contact: Contact): string[] {
  const all: string[] = [];
  if (contact.email) all.push(contact.email);
  all.push(...parseEmailList(contact.emailList));
  // 去重
  return Array.from(new Set(all));
}

/** CardDAV 默认配置：根据邮箱域名推断服务地址 */
export function inferCarddavUrl(email: string): string {
  const lower = email.toLowerCase().trim();
  if (lower.endsWith("@qq.com") || lower.endsWith("@foxmail.com")) {
    return "https://dav.qq.com/";
  }
  if (lower.endsWith("@icloud.com")) {
    return "https://contacts.icloud.com/";
  }
  return "";
}

/** ActiveSync 默认配置：根据邮箱域名推断 EAS 服务地址 */
export function inferEasUrl(email: string): string {
  const lower = email.toLowerCase().trim();
  // 腾讯企业邮（exmail.qq.com 域名或使用 ex.exmail.qq.com 服务器）
  if (
    lower.endsWith("@exmail.qq.com") ||
    lower.endsWith("@exmail.cn") ||
    lower.includes("@company.") ||
    lower.includes("@corp.")
  ) {
    return "https://ex.exmail.qq.com/Microsoft-Server-ActiveSync";
  }
  // 网易企业邮
  if (lower.endsWith("@qiye.163.com") || lower.includes("@qiye.")) {
    return "https://qiyemail.qiye.163.com/Microsoft-Server-ActiveSync";
  }
  // Office365 / Exchange Online
  if (
    lower.endsWith("@outlook.com") ||
    lower.endsWith("@hotmail.com") ||
    lower.endsWith("@office365.com") ||
    lower.endsWith("@onmicrosoft.com")
  ) {
    return "https://outlook.office365.com/Microsoft-Server-ActiveSync";
  }
  return "";
}
