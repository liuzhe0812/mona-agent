import { decodeImapUtf7 } from "./imapUtf7";

const FOLDER_DISPLAY_NAMES: Record<string, string> = {
  inbox: "收件箱",
  "sent messages": "已发送",
  "已发邮件": "已发送",
  drafts: "草稿箱",
  "deleted messages": "已删除",
  junk: "垃圾邮件",
  trash: "回收站",
  outbox: "发件箱",
  archive: "归档",
  starred: "星标邮件",
  flagged: "红旗邮件",
};

// 文件夹排序优先级：数字越小越靠前，未列出的统一归为 100
const FOLDER_PRIORITY: Record<string, number> = {
  inbox: 0,
  "sent messages": 1,
  "已发邮件": 1,
  sent: 1,
  drafts: 2,
  "deleted messages": 3,
  trash: 3,
  junk: 4,
  outbox: 5,
  archive: 6,
  starred: 7,
  flagged: 7,
};

// 容器型文件夹，本身不存放邮件，强制排在所有正常文件夹之后
const LOW_PRIORITY_FOLDERS = new Set(["其他文件夹"]);
const LOW_PRIORITY_VALUE = 1000;

export function getFolderDisplayName(name: string): string {
  const decoded = decodeImapUtf7(name);
  const key = decoded.toLowerCase().trim();
  return FOLDER_DISPLAY_NAMES[key] ?? decoded;
}

// 「已发送」类文件夹：发出去的邮件不存在未读语义，UI 不展示未读标识
export function isSentFolder(name: string): boolean {
  if (!name) return false;
  const decoded = decodeImapUtf7(name).toLowerCase().trim();
  return (
    decoded.includes("sent") ||
    decoded.includes("已发送") ||
    decoded.includes("已发邮件")
  );
}

// 是否应展示为未读：已发送文件夹的邮件一律视为已读
export function isUnreadMessage(message: { isRead: boolean; folder: string }): boolean {
  return !message.isRead && !isSentFolder(message.folder);
}

// 文件夹未读数：已发送文件夹恒为 0
export function getFolderUnreadCount(
  folderName: string,
  counts: Record<string, number>,
): number {
  if (isSentFolder(folderName)) return 0;
  return counts[folderName] ?? 0;
}

// 稳定排序：按预定义优先级 + 名称字母序，保证本地缓存与 IMAP 同步后顺序一致
export function sortFolders<T extends { name: string }>(folders: T[]): T[] {
  return [...folders].sort((a, b) => {
    const aName = a.name.trim();
    const bName = b.name.trim();
    const pa = LOW_PRIORITY_FOLDERS.has(aName)
      ? LOW_PRIORITY_VALUE
      : FOLDER_PRIORITY[aName.toLowerCase()] ?? 100;
    const pb = LOW_PRIORITY_FOLDERS.has(bName)
      ? LOW_PRIORITY_VALUE
      : FOLDER_PRIORITY[bName.toLowerCase()] ?? 100;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name, "zh");
  });
}
