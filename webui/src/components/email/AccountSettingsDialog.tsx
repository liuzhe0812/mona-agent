import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Star, Edit3, Check, X as XIcon, Filter, PlayCircle, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEmailStore } from "./store/emailStore";
import type { EmailAccount, EmailRule, EmailSignature } from "./lib/types";
import * as emailApi from "./lib/emailApi";
import { getFolderDisplayName } from "./lib/folderUtils";
import {
  readEmailScheduleConfig,
  writeEmailScheduleConfig,
  isTauri,
  type EmailScheduleConfig,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface AccountSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: EmailAccount | null;
}

export function AccountSettingsDialog({
  open,
  onOpenChange,
  account,
}: AccountSettingsDialogProps) {
  const updateAccount = useEmailStore((s) => s.updateAccount);
  const gatewayUrl = useEmailStore((s) => s.gatewayUrl);
  const foldersByAccount = useEmailStore((s) => s.foldersByAccount);
  const [displayName, setDisplayName] = useState("");
  const [fromName, setFromName] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [imapUsername, setImapUsername] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSsl, setImapSsl] = useState(true);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpSsl, setSmtpSsl] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [signatures, setSignatures] = useState<EmailSignature[]>([]);
  const [editingSigId, setEditingSigId] = useState<string | null>(null);
  const [sigDraft, setSigDraft] = useState<EmailSignature | null>(null);
  const [rules, setRules] = useState<EmailRule[]>([]);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<EmailRule | null>(null);
  const [applyingRules, setApplyingRules] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const [applyResultOpen, setApplyResultOpen] = useState(false);
  const [applyResultText, setApplyResultText] = useState("");
  // AI 日程提取配置（全局共享，UI 入口在账号设置里）
  const [scheduleConfig, setScheduleConfig] = useState<EmailScheduleConfig | null>(null);
  const [scheduleSaveError, setScheduleSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !account) return;
    setDisplayName(account.displayName);
    setFromName(account.fromName ?? "");
    setEmailAddress(account.fromAddress);
    setImapUsername(account.imapUsername);
    setImapHost(account.imapHost);
    setImapPort(String(account.imapPort));
    setImapSsl(account.imapUseSsl);
    setSmtpHost(account.smtpHost);
    setSmtpPort(String(account.smtpPort));
    setSmtpSsl(account.smtpUseSsl);
    setNewPassword("");
    setSignatures(account.signatures ?? []);
    setEditingSigId(null);
    setSigDraft(null);
    setEditingRuleId(null);
    setRuleDraft(null);
    setError(null);
    // 加载规则
    void emailApi.listRules(account.id).then(setRules).catch(() => setRules([]));
    // 加载 AI 日程提取配置（全局，每次打开对话框刷新一次）
    setScheduleConfig(null);
    setScheduleSaveError(null);
    if (isTauri()) {
      void readEmailScheduleConfig()
        .then((cfg) => setScheduleConfig(cfg))
        .catch((e) => setScheduleSaveError(`加载配置失败: ${e}`));
    }
  }, [open, account]);

  // 注意：不能在这里 return null（即使 !open），否则 Radix Dialog 会被立即卸载，
  // 跳过关闭动画和 body 样式清理，导致 pointer-events:none 残留在 body 上，
  // 界面完全无法响应点击（100% 卡死）。始终渲染 Dialog，让 Radix 管理 open/close。
  if (!account) return null;

  const handleImapSslChange = (checked: boolean) => {
    setImapSsl(checked);
    setImapPort(checked ? "993" : "143");
  };

  const handleSmtpSslChange = (checked: boolean) => {
    setSmtpSsl(checked);
    setSmtpPort(checked ? "465" : "587");
  };

  const handleAddSignature = () => {
    const newSig: EmailSignature = {
      id: crypto.randomUUID(),
      name: "新签名",
      content: "",
      isDefault: signatures.length === 0,
    };
    setSignatures((prev) => [...prev, newSig]);
    setEditingSigId(newSig.id);
    setSigDraft({ ...newSig });
  };

  const handleEditSignature = (sig: EmailSignature) => {
    setEditingSigId(sig.id);
    setSigDraft({ ...sig });
  };

  const handleSaveSignature = () => {
    if (!sigDraft || !editingSigId) return;
    setSignatures((prev) => {
      let updated = prev.map((s) =>
        s.id === editingSigId ? { ...sigDraft } : s,
      );
      // 如果设为默认，取消其他默认
      if (sigDraft.isDefault) {
        updated = updated.map((s) =>
          s.id === editingSigId ? s : { ...s, isDefault: false },
        );
      }
      return updated;
    });
    setEditingSigId(null);
    setSigDraft(null);
  };

  const handleCancelEditSignature = () => {
    setEditingSigId(null);
    setSigDraft(null);
  };

  const handleDeleteSignature = (id: string) => {
    setSignatures((prev) => prev.filter((s) => s.id !== id));
  };

  const handleSetDefault = (id: string) => {
    setSignatures((prev) =>
      prev.map((s) => ({ ...s, isDefault: s.id === id })),
    );
  };

  // 规则管理
  const handleAddRule = () => {
    if (!account) return;
    const newRule: EmailRule = {
      id: crypto.randomUUID(),
      accountId: account.id,
      name: "新规则",
      conditionField: "from_contains",
      conditionValue: "",
      action: "mark_read",
      actionTarget: null,
      enabled: true,
      priority: 0,
    };
    setRules((prev) => [...prev, newRule]);
    setEditingRuleId(newRule.id);
    setRuleDraft({ ...newRule });
  };

  const handleSaveRule = async () => {
    if (!ruleDraft || !editingRuleId) return;
    try {
      await emailApi.saveRule(ruleDraft);
      setRules((prev) => prev.map((r) => (r.id === editingRuleId ? { ...ruleDraft } : r)));
    } catch (e) {
      setError(`保存规则失败: ${e}`);
    }
    setEditingRuleId(null);
    setRuleDraft(null);
  };

  const handleDeleteRule = async (id: string) => {
    try {
      await emailApi.deleteRule(id);
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      setError(`删除规则失败: ${e}`);
    }
  };

  const handleApplyRules = () => {
    if (!account || !gatewayUrl) return;
    if (rules.filter((r) => r.enabled).length === 0) {
      setError("没有启用的规则");
      return;
    }
    setApplyConfirmOpen(true);
  };

  const runApplyRules = async () => {
    setApplyConfirmOpen(false);
    if (!account || !gatewayUrl) return;
    setApplyingRules(true);
    setError(null);
    try {
      const result = await emailApi.applyRules(gatewayUrl, account.id);
      const matched = result.matched ?? 0;
      const success = result.success ?? 0;
      const failed = result.failed ?? 0;
      const errs = result.errors ?? [];
      const inboxTotal = result.inboxTotal ?? 0;
      let text = "";
      if (matched === 0) {
        // 诊断模式：显示规则摘要和前几封邮件的发件人，帮助定位匹配失败原因
        const diagRules = result.diagRules ?? [];
        const diagFroms = result.diagFroms ?? [];
        const rulesDesc = diagRules.length > 0
          ? diagRules.map(r => `[${r.conditionField}="${r.conditionValue}" → ${r.action}${r.actionTarget ? ":" + r.actionTarget : ""}]`).join(" ")
          : "";
        const fromsDesc = diagFroms.length > 0
          ? diagFroms.map(f => `"${f}"`).join(", ")
          : "";
        if (inboxTotal === 0) {
          text = "收件箱没有邮件";
        } else if (diagRules.length === 0) {
          text = `没有启用的规则（收件箱共 ${inboxTotal} 封）`;
        } else {
          text = `没有匹配规则的邮件（收件箱共 ${inboxTotal} 封）\n\n规则: ${rulesDesc}\n前 ${diagFroms.length} 封邮件发件人: ${fromsDesc}`;
        }
      } else if (failed === 0) {
        text = `成功处理 ${success} 封邮件`;
      } else {
        const errDetail = errs.slice(0, 3).join("\n");
        text = `匹配 ${matched} 封，成功 ${success} 封，失败 ${failed} 封\n\n失败原因（前 3 条）：\n${errDetail}`;
      }
      setApplyResultText(text);
      setApplyResultOpen(true);
    } catch (e) {
      setError(`应用规则失败: ${e}`);
    } finally {
      setApplyingRules(false);
    }
  };

  const handleToggleRuleEnabled = async (rule: EmailRule) => {
    const updated = { ...rule, enabled: !rule.enabled };
    try {
      await emailApi.saveRule(updated);
      setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)));
    } catch {
      // ignore
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    if (!emailAddress.trim() || !displayName.trim()) {
      setError("邮箱地址和显示名称不能为空");
      return;
    }
    if (!imapHost.trim() || !smtpHost.trim()) {
      setError("收件服务器和发件服务器不能为空");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const updated: EmailAccount = {
        ...account,
        displayName: displayName.trim(),
        fromName: fromName.trim() || null,
        fromAddress: emailAddress.trim(),
        imapUsername: imapUsername.trim() || emailAddress.trim(),
        imapHost: imapHost.trim(),
        imapPort: parseInt(imapPort, 10) || 993,
        imapUseSsl: imapSsl,
        smtpHost: smtpHost.trim(),
        smtpPort: parseInt(smtpPort, 10) || 587,
        smtpUseSsl: smtpSsl,
        signatures,
      };
      await updateAccount(updated, newPassword.trim() || null);
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // AI 日程提取配置：更新单个字段并立即保存到 config.json
  const updateScheduleField = <K extends keyof EmailScheduleConfig>(
    key: K,
    value: EmailScheduleConfig[K],
  ) => {
    setScheduleConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: value };
      if (isTauri()) {
        void writeEmailScheduleConfig(next)
          .then(() => setScheduleSaveError(null))
          .catch((e) => setScheduleSaveError(`保存配置失败: ${e}`));
      }
      return next;
    });
  };

  // 切换当前账号某文件夹的启用状态
  const toggleScheduleFolder = (folderKey: string, checked: boolean) => {
    setScheduleConfig((prev) => {
      if (!prev) return prev;
      const exists = prev.folders.includes(folderKey);
      let folders: string[];
      if (checked && !exists) {
        folders = [...prev.folders, folderKey];
      } else if (!checked && exists) {
        folders = prev.folders.filter((f) => f !== folderKey);
      } else {
        folders = prev.folders;
      }
      const next = { ...prev, folders };
      if (isTauri()) {
        void writeEmailScheduleConfig(next)
          .then(() => setScheduleSaveError(null))
          .catch((e) => setScheduleSaveError(`保存配置失败: ${e}`));
      }
      return next;
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setError(null);
        onOpenChange(v);
      }}
    >
      <DialogContent
        className="max-w-lg"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">邮箱设置</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5">
          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="basic" className="text-[12px]">基础</TabsTrigger>
              <TabsTrigger value="password" className="text-[12px]">密码</TabsTrigger>
              <TabsTrigger value="signatures" className="text-[12px]">签名</TabsTrigger>
              <TabsTrigger value="rules" className="text-[12px]">规则</TabsTrigger>
              <TabsTrigger value="schedule" className="text-[12px]">AI日程</TabsTrigger>
            </TabsList>
            <TabsContent value="basic" className="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {/* 基础 */}
          <section className="space-y-3">
            <h3 className="text-[12px] font-medium text-muted-foreground">基础</h3>
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="acct-email" className="text-[12px]">
                  邮箱地址
                </Label>
                <Input
                  id="acct-email"
                  value={emailAddress}
                  onChange={(e) => setEmailAddress(e.target.value)}
                  className="h-8 rounded-lg text-[13px]"
                  disabled={submitting}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="acct-display" className="text-[12px]">
                  显示名称（前端显示）
                </Label>
                <Input
                  id="acct-display"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="邮箱树中显示的名字"
                  className="h-8 rounded-lg text-[13px]"
                  disabled={submitting}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="acct-from-name" className="text-[12px]">
                  发信名称
                </Label>
                <Input
                  id="acct-from-name"
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                  placeholder="发邮件时收件人看到的发件人名字（留空则用邮箱地址）"
                  className="h-8 rounded-lg text-[13px]"
                  disabled={submitting}
                />
              </div>
            </div>
          </section>

          {/* 服务器 */}
          <section className="space-y-3">
            <h3 className="text-[12px] font-medium text-muted-foreground">服务器</h3>
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="acct-username" className="text-[12px]">
                  账号
                </Label>
                <Input
                  id="acct-username"
                  value={imapUsername}
                  onChange={(e) => setImapUsername(e.target.value)}
                  placeholder="IMAP/SMTP 登录用户名，留空则用邮箱地址"
                  className="h-8 rounded-lg text-[13px]"
                  disabled={submitting}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-[12px]">收件服务器（IMAP）</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                    placeholder="imap.example.com"
                    className="h-8 rounded-lg text-[13px]"
                    disabled={submitting}
                  />
                  <Input
                    value={imapPort}
                    onChange={(e) => setImapPort(e.target.value)}
                    className="h-8 w-20 rounded-lg text-[13px]"
                    disabled={submitting}
                  />
                </div>
                <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Checkbox
                    checked={imapSsl}
                    onCheckedChange={(v) => handleImapSslChange(v === true)}
                    disabled={submitting}
                  />
                  SSL
                </label>
              </div>

              <div className="space-y-1.5">
                <Label className="text-[12px]">发件服务器（SMTP）</Label>
                <div className="flex items-center gap-2">
                  <Input
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.example.com"
                    className="h-8 rounded-lg text-[13px]"
                    disabled={submitting}
                  />
                  <Input
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                    className="h-8 w-20 rounded-lg text-[13px]"
                    disabled={submitting}
                  />
                </div>
                <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Checkbox
                    checked={smtpSsl}
                    onCheckedChange={(v) => handleSmtpSslChange(v === true)}
                    disabled={submitting}
                  />
                  SSL
                </label>
              </div>
            </div>
          </section>
            </TabsContent>
            <TabsContent value="password" className="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {/* 密码 */}
          <section className="space-y-3">
            <h3 className="text-[12px] font-medium text-muted-foreground">登录密码</h3>
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="acct-password" className="text-[12px]">
                  修改密码（留空表示不修改）
                </Label>
                <Input
                  id="acct-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="留空保留原密码；腾讯企业邮需填客户端专用密码"
                  className="h-8 rounded-lg text-[13px]"
                  disabled={submitting}
                  autoComplete="new-password"
                />
                <p className="text-[11px] text-muted-foreground">
                  腾讯企业邮需在网页版「设置 → 客户端专用密码」生成密码，IMAP/SMTP 共用
                </p>
              </div>
            </div>
          </section>
            </TabsContent>
            <TabsContent value="signatures" className="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {/* 签名管理 */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-[12px] font-medium text-muted-foreground">签名</h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={handleAddSignature}
                disabled={submitting}
              >
                <Plus className="h-3 w-3" />
                添加
              </Button>
            </div>
            <div className="space-y-2">
              {signatures.length === 0 && (
                <p className="text-[11px] text-muted-foreground">暂无签名，点击"添加"创建</p>
              )}
              {signatures.map((sig) => (
                <div key={sig.id} className="rounded-lg border border-border/60 bg-muted/20 p-2">
                  {editingSigId === sig.id && sigDraft ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Input
                          value={sigDraft.name}
                          onChange={(e) => setSigDraft({ ...sigDraft, name: e.target.value })}
                          placeholder="签名名称"
                          className="h-7 flex-1 rounded-lg text-[12px]"
                        />
                        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Checkbox
                            checked={sigDraft.isDefault ?? false}
                            onCheckedChange={(v) => setSigDraft({ ...sigDraft, isDefault: v === true })}
                          />
                          默认
                        </label>
                      </div>
                      <Textarea
                        value={sigDraft.content}
                        onChange={(e) => setSigDraft({ ...sigDraft, content: e.target.value })}
                        placeholder="签名内容（支持 HTML）"
                        className="min-h-[80px] rounded-lg text-[12px]"
                      />
                      {sigDraft.content && (
                        <div className="rounded-lg border border-border/40 bg-white p-2">
                          <div className="mb-1 text-[10px] text-muted-foreground">预览</div>
                          <div
                            className="text-[12px] leading-relaxed text-gray-700 [&_a]:text-[#2f7fca] [&_a]:underline [&_img]:max-w-full"
                            dangerouslySetInnerHTML={{ __html: sigDraft.content }}
                          />
                        </div>
                      )}
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={handleCancelEditSignature}
                        >
                          <XIcon className="h-3 w-3" />
                          取消
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          onClick={handleSaveSignature}
                        >
                          <Check className="h-3 w-3" />
                          保存
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] font-medium">{sig.name || "未命名"}</span>
                          {sig.isDefault && (
                            <span className="rounded bg-blue-500/10 px-1 text-[10px] text-blue-600">默认</span>
                          )}
                        </div>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {sig.content ? sig.content.replace(/<[^>]*>/g, "").slice(0, 50) || "（空）" : "（空）"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSetDefault(sig.id)}
                        className="text-muted-foreground hover:text-blue-600"
                        title="设为默认"
                      >
                        <Star className={cn("h-3.5 w-3.5", sig.isDefault && "fill-blue-500 text-blue-500")} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEditSignature(sig)}
                        className="text-muted-foreground hover:text-foreground"
                        title="编辑"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSignature(sig.id)}
                        className="text-muted-foreground hover:text-destructive"
                        title="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
            </TabsContent>
            <TabsContent value="rules" className="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground">
                <Filter className="h-3 w-3" />
                规则
              </h3>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => void handleApplyRules()}
                  disabled={applyingRules || submitting || rules.filter((r) => r.enabled).length === 0 || !gatewayUrl}
                  title="对账号 INBOX 中已有邮件批量应用规则"
                >
                  {applyingRules ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <PlayCircle className="h-3 w-3" />
                  )}
                  对已有邮件运行
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={handleAddRule}
                  disabled={submitting}
                >
                  <Plus className="h-3 w-3" />
                  添加
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {rules.length === 0 && (
                <p className="text-[11px] text-muted-foreground">暂无规则，新邮件将不会被自动分类</p>
              )}
              {rules.map((rule) => (
                <div key={rule.id} className="rounded-lg border border-border/60 bg-muted/20 p-2">
                  {editingRuleId === rule.id && ruleDraft ? (
                    <div className="space-y-2">
                      <Input
                        value={ruleDraft.name}
                        onChange={(e) => setRuleDraft({ ...ruleDraft, name: e.target.value })}
                        placeholder="规则名称"
                        className="h-7 rounded-lg text-[12px]"
                      />
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">当</span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="h-7 rounded-lg border border-border bg-background px-2 text-[11px]"
                            >
                              {ruleDraft.conditionField === "from_contains" ? "发件人包含" :
                                ruleDraft.conditionField === "subject_contains" ? "主题包含" : "收件人包含"}
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem onClick={() => setRuleDraft({ ...ruleDraft, conditionField: "from_contains" })}>发件人包含</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setRuleDraft({ ...ruleDraft, conditionField: "subject_contains" })}>主题包含</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setRuleDraft({ ...ruleDraft, conditionField: "to_contains" })}>收件人包含</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <Input
                          value={ruleDraft.conditionValue}
                          onChange={(e) => setRuleDraft({ ...ruleDraft, conditionValue: e.target.value })}
                          placeholder="关键词"
                          className="h-7 flex-1 rounded-lg text-[11px]"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">则</span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="h-7 rounded-lg border border-border bg-background px-2 text-[11px]"
                            >
                              {ruleDraft.action === "move" ? "移动到" :
                                ruleDraft.action === "mark_read" ? "标记已读" :
                                ruleDraft.action === "star" ? "加星标" : "删除"}
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem onClick={() => setRuleDraft({ ...ruleDraft, action: "mark_read" })}>标记已读</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setRuleDraft({ ...ruleDraft, action: "star" })}>加星标</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setRuleDraft({ ...ruleDraft, action: "move" })}>移动到</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setRuleDraft({ ...ruleDraft, action: "delete" })}>删除</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {ruleDraft.action === "move" && (
                          (() => {
                            const folders = (account && foldersByAccount[account.id]) || [];
                            return (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    type="button"
                                    className="h-7 flex-1 rounded-lg border border-border bg-background px-2 text-left text-[11px] truncate"
                                  >
                                    {ruleDraft.actionTarget || "选择文件夹"}
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                  {folders.length === 0 ? (
                                    <DropdownMenuItem disabled>请先同步文件夹</DropdownMenuItem>
                                  ) : (
                                    folders.map((f) => (
                                      <DropdownMenuItem
                                        key={f.name}
                                        onClick={() => setRuleDraft({ ...ruleDraft, actionTarget: f.name })}
                                      >
                                        {f.name}
                                      </DropdownMenuItem>
                                    ))
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            );
                          })()
                        )}
                      </div>
                      <div className="flex justify-end gap-1">
                        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => { setEditingRuleId(null); setRuleDraft(null); }}>
                          <XIcon className="h-3 w-3" />取消
                        </Button>
                        <Button type="button" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void handleSaveRule()}>
                          <Check className="h-3 w-3" />保存
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={rule.enabled}
                        onCheckedChange={() => void handleToggleRuleEnabled(rule)}
                      />
                      <div className="min-w-0 flex-1">
                        <span className={cn("text-[12px] font-medium", !rule.enabled && "text-muted-foreground line-through")}>
                          {rule.name}
                        </span>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {rule.conditionField === "from_contains" ? "发件人" : rule.conditionField === "subject_contains" ? "主题" : "收件人"}包含"{rule.conditionValue}"
                          {" → "}
                          {rule.action === "move" ? `移动到${rule.actionTarget ?? ""}` : rule.action === "mark_read" ? "标记已读" : rule.action === "star" ? "加星标" : "删除"}
                        </p>
                      </div>
                      <button type="button" onClick={() => { setEditingRuleId(rule.id); setRuleDraft({ ...rule }); }} className="text-muted-foreground hover:text-foreground" title="编辑">
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => void handleDeleteRule(rule.id)} className="text-muted-foreground hover:text-destructive" title="删除">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
            </TabsContent>
            <TabsContent value="schedule" className="mt-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground">
                <CalendarClock className="h-3 w-3" />
                AI 日程提取
              </h3>
            </div>
            <p className="text-[11px] text-muted-foreground">
              配置全局生效。新邮件到达所选文件夹时，AI 自动分析邮件内容并提取日程信息。
            </p>
            {scheduleSaveError && (
              <div className="text-[11px] text-destructive">{scheduleSaveError}</div>
            )}
            {!scheduleConfig ? (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                加载配置中…
              </div>
            ) : (
              <>
                {/* 总开关 */}
                <label className="flex items-center gap-2 text-[12px]">
                  <Checkbox
                    checked={scheduleConfig.enabled}
                    onCheckedChange={(v) => updateScheduleField("enabled", v === true)}
                  />
                  启用 AI 日程提取
                </label>

                {/* 文件夹多选 */}
                <div className="space-y-2">
                  <Label className="text-[12px]">启用提取的文件夹（当前账号）</Label>
                  {(() => {
                    const folders = (account && foldersByAccount[account.id]) || [];
                    // 过滤掉垃圾邮件、已删除、草稿箱等系统文件夹
                    const excludeFolders = (name: string): boolean => {
                      const lower = name.toLowerCase();
                      const decoded = getFolderDisplayName(name);
                      return (
                        lower.includes("junk") ||
                        lower.includes("spam") ||
                        lower.includes("trash") ||
                        lower.includes("deleted") ||
                        lower.includes("draft") ||
                        decoded.includes("垃圾") ||
                        decoded.includes("已删除") ||
                        decoded.includes("草稿") ||
                        decoded.includes("回收站")
                      );
                    };
                    const visibleFolders = folders.filter((f) => !excludeFolders(f.name));
                    if (visibleFolders.length === 0) {
                      return (
                        <p className="text-[11px] text-muted-foreground">
                          请先同步文件夹
                        </p>
                      );
                    }
                    return (
                      <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-2">
                        {visibleFolders.map((f) => {
                          const folderKey = `${account!.id}:${f.name}`;
                          const checked = scheduleConfig.folders.includes(folderKey);
                          return (
                            <label
                              key={f.name}
                              className="flex items-center gap-2 text-[12px]"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(v) =>
                                  toggleScheduleFolder(folderKey, v === true)
                                }
                              />
                              <span className="truncate">{getFolderDisplayName(f.name)}</span>
                              {(f.unreadCount ?? 0) > 0 && (
                                <span className="ml-auto text-[10px] text-muted-foreground">
                                  {f.unreadCount} 未读
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>

                {/* 创建模式 */}
                <div className="space-y-1.5">
                  <Label className="text-[12px]">创建模式</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => updateScheduleField("createMode", "auto")}
                      className={cn(
                        "rounded-lg border px-2 py-1.5 text-left text-[12px] transition-colors",
                        scheduleConfig.createMode === "auto"
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-muted/40"
                      )}
                    >
                      <div className="font-medium">直接创建</div>
                      <div className="text-[10px] text-muted-foreground">AI 解析成功后自动创建</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => updateScheduleField("createMode", "confirm")}
                      className={cn(
                        "rounded-lg border px-2 py-1.5 text-left text-[12px] transition-colors",
                        scheduleConfig.createMode === "confirm"
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-muted/40"
                      )}
                    >
                      <div className="font-medium">确认后创建</div>
                      <div className="text-[10px] text-muted-foreground">弹通知让你确认</div>
                    </button>
                  </div>
                </div>

                {/* 提前提醒量 */}
                <div className="space-y-1">
                  <Label htmlFor="sched-lead" className="text-[12px]">
                    提前提醒量（分钟）
                  </Label>
                  <Input
                    id="sched-lead"
                    type="number"
                    min={0}
                    value={String(scheduleConfig.leadMinutes)}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (!isNaN(n) && n >= 0) {
                        updateScheduleField("leadMinutes", n);
                      }
                    }}
                    className="h-8 rounded-lg text-[13px]"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    日程开始时间 = 邮件中提到的事件时间 - 提前提醒量
                  </p>
                </div>

                {/* 跳过发件人 */}
                <div className="space-y-1">
                  <Label htmlFor="sched-skip" className="text-[12px]">
                    跳过的发件人（逗号分隔）
                  </Label>
                  <Textarea
                    id="sched-skip"
                    value={scheduleConfig.skipSenders.join(", ")}
                    onChange={(e) => {
                      const list = e.target.value
                        .split(/[,，\n]/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                      updateScheduleField("skipSenders", list);
                    }}
                    placeholder="noreply.github.com, notifications@slack.com"
                    className="min-h-[60px] rounded-lg text-[12px]"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    匹配发件人邮箱地址，避免自动化邮件反复触发
                  </p>
                </div>
              </>
            )}
          </section>
            </TabsContent>
          </Tabs>

          {error ? (
            <div className="text-[12px] text-destructive">{error}</div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              className="h-8 text-[12px]"
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      {/* 对已有邮件运行 - 确认弹窗 */}
      <AlertDialog open={applyConfirmOpen} onOpenChange={setApplyConfirmOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">应用规则到已有邮件</AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              将对账号「{account.displayName}」下 INBOX 中已缓存的邮件应用规则，可能需要一些时间。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-[12px]">取消</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 text-[12px]"
              onClick={() => void runApplyRules()}
              disabled={applyingRules}
            >
              {applyingRules ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              继续
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 对已有邮件运行 - 结果弹窗 */}
      <AlertDialog open={applyResultOpen} onOpenChange={setApplyResultOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">应用完成</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line text-[13px]">
              {applyResultText}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction className="h-8 text-[12px]">知道了</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
