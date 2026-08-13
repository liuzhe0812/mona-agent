import { useEffect, useMemo, useState } from "react";
import {
  BookUser,
  RefreshCw,
  Loader2,
  Search,
  Plus,
  Trash2,
  Mail,
  Phone,
  Building2,
  Briefcase,
  Edit3,
  X,
  Check,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { StatusNotice } from "@/components/ui/status-notice";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useEmailStore } from "../store/emailStore";
import * as contactsApi from "./lib/contactsApi";
import {
  getAllEmails,
  parseEmailList,
  type Contact,
  type ContactSyncState,
} from "./lib/types";

interface ContactsViewProps {
  gatewayUrl: string;
}

export function ContactsView({ gatewayUrl }: ContactsViewProps) {
  const accounts = useEmailStore((s) => s.accounts);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Contact>>({});
  const [syncing, setSyncing] = useState(false);
  const [syncStates, setSyncStates] = useState<Record<string, ContactSyncState>>({});
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const selectedAccount = useEmailStore((s) =>
    s.accounts.find((a) => a.id === s.selectedAccountId) ?? null,
  );

  const loadContacts = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await contactsApi.listContacts();
      setContacts(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadSyncStates = async () => {
    const states: Record<string, ContactSyncState> = {};
    for (const acc of accounts) {
      try {
        const st = await contactsApi.getContactSyncState(acc.id);
        if (st) states[acc.id] = st;
      } catch {
        // 忽略单个账号查询失败
      }
    }
    setSyncStates(states);
  };

  useEffect(() => {
    void loadContacts();
  }, []);

  useEffect(() => {
    void loadSyncStates();
  }, [accounts]);

  // 搜索过滤（本地，避免频繁 invoke）
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      return (
        c.displayName.toLowerCase().includes(q) ||
        (c.email ?? "").toLowerCase().includes(q) ||
        (c.phone ?? "").toLowerCase().includes(q) ||
        (c.organization ?? "").toLowerCase().includes(q)
      );
    });
  }, [contacts, searchQuery]);

  const selected = filtered.find((c) => c.id === selectedId) ?? null;

  const handleSync = async () => {
    if (!selectedAccount || !gatewayUrl) return;
    setSyncing(true);
    setError(null);
    try {
      // 联系人来源：邮件自动收集 + CSV 导入。同步按钮仅刷新本地列表。
      await loadContacts();
      await loadSyncStates();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const handleAdd = () => {
    setEditing(true);
    setEditForm({
      displayName: "",
      email: "",
      phone: "",
      organization: "",
      title: "",
      note: "",
      accountId: selectedAccount?.id ?? "",
      source: "manual",
    });
    setSelectedId(null);
  };

  const handleEdit = () => {
    if (!selected) return;
    setEditing(true);
    setEditForm({ ...selected });
  };

  const handleSave = async () => {
    if (!editForm.displayName || !editForm.displayName.trim()) {
      setError("显示名不能为空");
      return;
    }
    setError(null);
    try {
      const now = Math.floor(Date.now() / 1000);
      const contact: Contact = {
        id: editForm.id ?? "",
        accountId: editForm.accountId ?? selectedAccount?.id ?? "",
        source: editForm.source ?? "manual",
        remoteUid: editForm.remoteUid ?? null,
        etag: editForm.etag ?? null,
        displayName: editForm.displayName.trim(),
        email: editForm.email?.trim() || null,
        emailList: editForm.emailList ?? null,
        phone: editForm.phone?.trim() || null,
        organization: editForm.organization?.trim() || null,
        title: editForm.title?.trim() || null,
        note: editForm.note?.trim() || null,
        rawVcard: editForm.rawVcard ?? null,
        lastModified: editForm.lastModified ?? null,
        updatedAt: now,
      };
      if (contact.id) {
        await contactsApi.updateContact(contact.id, {
          displayName: contact.displayName,
          email: contact.email,
          phone: contact.phone,
          organization: contact.organization,
          title: contact.title,
          note: contact.note,
        });
      } else {
        const id = await contactsApi.addContact(contact);
        setSelectedId(id);
      }
      setEditing(false);
      await loadContacts();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`确定删除联系人「${selected.displayName}」吗？`)) return;
    try {
      await contactsApi.deleteContact(selected.id);
      setSelectedId(null);
      await loadContacts();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditForm({});
  };

  // 解析 CSV 一行（支持引号包裹的逗号）— 仅用于前端兜底，实际解析在后端
  const handleImportCsv = async () => {
    if (!selectedAccount) return;
    setImporting(true);
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!selected || typeof selected !== "string") {
        setImporting(false);
        return;
      }
      const result = await contactsApi.importCsv(selectedAccount.id, selected);
      await loadContacts();
      setError(`导入完成：新增 ${result.added} 个联系人，跳过 ${result.skipped} 行`);
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 工具栏 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!selectedAccount || syncing || !gatewayUrl}
          onClick={() => void handleSync()}
          className="h-7 gap-1.5 px-2.5 text-caption text-info-strong hover:bg-info/10 hover:text-info-strong"
        >
          {syncing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          刷新联系人
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleAdd}
          className="h-7 gap-1.5 px-2.5 text-caption text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          新建
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!selectedAccount || importing}
          onClick={() => void handleImportCsv()}
          className="h-7 gap-1.5 px-2.5 text-caption text-muted-foreground hover:text-foreground"
        >
          {importing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          导入 CSV
        </Button>
        <div className="flex-1" />
        {selectedAccount && syncStates[selectedAccount.id] && (
          <span className="text-micro text-muted-foreground">
            上次同步：{formatSyncTime(syncStates[selectedAccount.id].lastSyncedAt)}
          </span>
        )}
      </div>

      {error && (
        <StatusNotice
          tone="danger"
          className="shrink-0 rounded-none border-x-0 border-t-0 px-3 py-1.5"
          action={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setError(null)}
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              aria-label="关闭"
            >
              <X className="h-3 w-3" />
            </Button>
          }
        >
          {error}
        </StatusNotice>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 左：列表 */}
        <div className="flex w-[280px] shrink-0 flex-col border-r border-border bg-background">
          <div className="p-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索联系人..."
                className="h-7 rounded-full pl-7 text-ui"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-caption text-muted-foreground">
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                加载中...
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                className="py-8"
                icon={<BookUser className="h-5 w-5" />}
                title={searchQuery ? "没有匹配的联系人" : "还没有联系人"}
                action={
                  !searchQuery ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleAdd}
                      className="h-7 gap-1 text-caption text-info-strong hover:bg-info/10 hover:text-info-strong"
                    >
                      <Plus className="h-3 w-3" />
                      新建联系人
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="flex flex-col">
                {filtered.map((c) => {
                  const isSelected = c.id === selectedId;
                  return (
                    <Button
                      key={c.id}
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setSelectedId(c.id);
                        setEditing(false);
                      }}
                      className={cn(
                        "h-auto w-full justify-start gap-2 rounded-none border-b border-border/40 px-3 py-2 text-left font-normal",
                        isSelected ? "bg-info/10 hover:bg-info/10" : "hover:bg-accent",
                      )}
                    >
                      <Avatar name={c.displayName} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-caption font-medium text-foreground">
                          {c.displayName}
                        </div>
                        <div className="truncate text-micro text-muted-foreground">
                          {c.email || c.phone || "—"}
                        </div>
                      </div>
                      {(c.source === "carddav" || c.source === "auto") && (
                        <span className="shrink-0 rounded-md bg-info/10 px-1 py-0.5 text-micro font-medium text-info-strong">
                          {c.source === "auto" ? "自动" : "同步"}
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 右：详情/编辑 */}
        <div className="min-w-0 flex-1 bg-background">
          {editing ? (
            <ContactEditor
              form={editForm}
              onChange={setEditForm}
              onSave={() => void handleSave()}
              onCancel={handleCancelEdit}
            />
          ) : selected ? (
            <ContactDetail
              contact={selected}
              onEdit={handleEdit}
              onDelete={() => void handleDelete()}
            />
          ) : (
            <EmptyState
              className="h-full"
              icon={<BookUser className="h-5 w-5" />}
              title='选择左侧联系人查看详情，或点击"新建"添加'
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 联系人详情
// ---------------------------------------------------------------------------

function ContactDetail({
  contact,
  onEdit,
  onDelete,
}: {
  contact: Contact;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const allEmails = getAllEmails(contact);
  const otherEmails = parseEmailList(contact.emailList);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar name={contact.displayName} size={40} />
          <div>
            <div className="text-body font-semibold text-foreground">
              {contact.displayName}
            </div>
            {contact.organization && (
              <div className="text-micro text-muted-foreground">
                {contact.organization}
                {contact.title ? ` · ${contact.title}` : ""}
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onEdit}
            className="h-7 gap-1.5 px-2 text-caption text-muted-foreground hover:text-foreground"
          >
            <Edit3 className="h-3.5 w-3.5" />
            编辑
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="h-7 gap-1.5 px-2 text-caption text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-3">
          {allEmails.length > 0 && (
            <Field icon={Mail} label="邮箱">
              <div className="flex flex-col gap-1">
                <div className="text-ui text-foreground">{contact.email}</div>
                {otherEmails.map((e) => (
                  <div key={e} className="text-ui text-muted-foreground">
                    {e}
                  </div>
                ))}
              </div>
            </Field>
          )}
          {contact.phone && (
            <Field icon={Phone} label="电话">
              <div className="text-ui text-foreground">{contact.phone}</div>
            </Field>
          )}
          {contact.organization && (
            <Field icon={Building2} label="公司">
              <div className="text-ui text-foreground">{contact.organization}</div>
            </Field>
          )}
          {contact.title && (
            <Field icon={Briefcase} label="职务">
              <div className="text-ui text-foreground">{contact.title}</div>
            </Field>
          )}
          {contact.note && (
            <Field label="备注">
              <div className="whitespace-pre-wrap text-ui text-foreground">
                {contact.note}
              </div>
            </Field>
          )}
          <div className="mt-2 text-micro text-muted-foreground">
            来源：{contact.source === "carddav" ? "CardDAV 同步" : "手动添加"}
            {contact.updatedAt && ` · 更新于 ${formatSyncTime(contact.updatedAt)}`}
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  icon: Icon,
  label,
  children,
}: {
  icon?: React.ElementType;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 border-b border-border/40 pb-3">
      <div className="flex w-20 shrink-0 items-center gap-1.5 text-micro text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 联系人编辑器
// ---------------------------------------------------------------------------

function ContactEditor({
  form,
  onChange,
  onSave,
  onCancel,
}: {
  form: Partial<Contact>;
  onChange: (form: Partial<Contact>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const update = (key: keyof Contact, value: string) => {
    onChange({ ...form, [key]: value });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <span className="text-ui font-medium text-foreground">
          {form.id ? "编辑联系人" : "新建联系人"}
        </span>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onSave}
            className="h-7 gap-1.5 px-2 text-caption text-info-strong hover:bg-info/10"
          >
            <Check className="h-3.5 w-3.5" />
            保存
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="h-7 gap-1.5 px-2 text-caption text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
            取消
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-3">
          <EditField label="显示名" required>
            <Input
              value={form.displayName ?? ""}
              onChange={(e) => update("displayName", e.target.value)}
              placeholder="张三"
              className="h-8 text-ui"
            />
          </EditField>
          <EditField label="邮箱">
            <Input
              value={form.email ?? ""}
              onChange={(e) => update("email", e.target.value)}
              placeholder="zhangsan@example.com"
              className="h-8 text-ui"
            />
          </EditField>
          <EditField label="电话">
            <Input
              value={form.phone ?? ""}
              onChange={(e) => update("phone", e.target.value)}
              placeholder="13800138000"
              className="h-8 text-ui"
            />
          </EditField>
          <EditField label="公司">
            <Input
              value={form.organization ?? ""}
              onChange={(e) => update("organization", e.target.value)}
              placeholder="公司名称"
              className="h-8 text-ui"
            />
          </EditField>
          <EditField label="职务">
            <Input
              value={form.title ?? ""}
              onChange={(e) => update("title", e.target.value)}
              placeholder="工程师"
              className="h-8 text-ui"
            />
          </EditField>
          <EditField label="备注">
            <Textarea
              value={form.note ?? ""}
              onChange={(e) => update("note", e.target.value)}
              placeholder="备注信息"
              className="min-h-[60px] text-ui"
            />
          </EditField>
        </div>
      </div>
    </div>
  );
}

function EditField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-micro text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 头像（首字母）
// ---------------------------------------------------------------------------

function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const colors = [
    "bg-blue-500",
    "bg-green-500",
    "bg-purple-500",
    "bg-orange-500",
    "bg-pink-500",
    "bg-teal-500",
  ];
  const colorIdx = name.charCodeAt(0) % colors.length;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-medium text-white",
        colors[colorIdx],
      )}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initial}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function formatSyncTime(unixSec: number | null | undefined): string {
  if (!unixSec) return "从未";
  const date = new Date(unixSec * 1000);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return date.toLocaleDateString();
}
