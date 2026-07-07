import { invoke } from "@tauri-apps/api/core";
import type {
  CardDavTestResponse,
  Contact,
  ContactSyncResult,
  ContactSyncState,
} from "./types";

// ---------------------------------------------------------------------------
// 本地 CRUD（直接读写 SQLite，不走 gateway）
// ---------------------------------------------------------------------------

/** 列出联系人，可按账号过滤 */
export async function listContacts(accountId?: string): Promise<Contact[]> {
  return invoke<Contact[]>("contact_list", { accountId: accountId ?? null });
}

/** 模糊搜索联系人（按名字/邮箱/电话/公司） */
export async function searchContacts(query: string, limit?: number): Promise<Contact[]> {
  return invoke<Contact[]>("contact_search", { query, limit: limit ?? 20 });
}

/** 新增联系人，返回生成的 id */
export async function addContact(contact: Contact): Promise<string> {
  return invoke<string>("contact_add", { contact });
}

/** 更新联系人指定字段 */
export async function updateContact(
  id: string,
  fields: Partial<Omit<Contact, "id" | "accountId" | "source" | "updatedAt">>,
): Promise<void> {
  return invoke("contact_update", { id, fields });
}

/** 删除联系人 */
export async function deleteContact(id: string): Promise<void> {
  return invoke("contact_delete", { id });
}

/** 清空账号下的联系人（可按来源过滤） */
export async function clearAccountContacts(
  accountId: string,
  source?: "carddav" | "eas" | "manual",
): Promise<number> {
  return invoke<number>("contact_clear_account", { accountId, source: source ?? null });
}

/** CSV 导入结果 */
export interface CsvImportResult {
  added: number;
  skipped: number;
}

/** 从指定 CSV 文件导入联系人（后端自动检测 GBK/UTF-8 编码） */
export async function importCsv(accountId: string, filePath: string): Promise<CsvImportResult> {
  return invoke<CsvImportResult>("contact_import_csv", { accountId, filePath });
}

// ---------------------------------------------------------------------------
// 同步状态
// ---------------------------------------------------------------------------

export async function getContactSyncState(accountId: string): Promise<ContactSyncState | null> {
  return invoke<ContactSyncState | null>("contact_get_sync_state", { accountId });
}

// ---------------------------------------------------------------------------
// CardDAV 同步（经 Rust 转发到 Python gateway）
// ---------------------------------------------------------------------------

export interface ContactSyncRequest {
  accountId: string;
  carddavUrl: string;
  username: string;
  password: string;
}

export interface CardDavTestRequest {
  carddavUrl: string;
  username: string;
  password: string;
}

/** 触发 CardDAV 同步（仅下载） */
export async function syncContacts(
  gatewayUrl: string,
  req: ContactSyncRequest,
): Promise<ContactSyncResult> {
  return invoke<ContactSyncResult>("contact_sync", { gatewayUrl, req });
}

/** 测试 CardDAV 连接 */
export async function testCarddav(
  gatewayUrl: string,
  req: CardDavTestRequest,
): Promise<CardDavTestResponse> {
  return invoke<CardDavTestResponse>("contact_test_carddav", { gatewayUrl, req });
}

// ---------------------------------------------------------------------------
// Exchange ActiveSync 同步（经 Rust 转发到 Python gateway）
// ---------------------------------------------------------------------------

export interface EASSyncRequest {
  accountId: string;
  easUrl: string;
  username: string;
  password: string;
}

export interface EASTestRequest {
  easUrl: string;
  username: string;
  password: string;
  accountId?: string;
}

/** 触发 EAS 同步（仅下载） */
export async function syncContactsEas(
  gatewayUrl: string,
  req: EASSyncRequest,
): Promise<ContactSyncResult> {
  return invoke<ContactSyncResult>("contact_sync_eas", { gatewayUrl, req });
}

/** 测试 EAS 连接 */
export async function testEas(
  gatewayUrl: string,
  req: EASTestRequest,
): Promise<CardDavTestResponse> {
  return invoke<CardDavTestResponse>("contact_test_eas", { gatewayUrl, req });
}
