import { useEffect, useState } from "react";
import { X, Loader2, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { openExternalUrl } from "@/lib/tauri";
import { useEmailStore } from "./store/emailStore";
import { testConnection } from "./lib/emailApi";
import { inferEasUrl } from "./contacts/lib/types";
import type { EmailAccount } from "./lib/types";

interface NewAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑模式时传入原账号；新增模式为 null */
  editAccount?: EmailAccount | null;
  gatewayUrl?: string;
}

interface PresetConfig {
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

const PRESETS: PresetConfig[] = [
  { label: "Gmail", imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 587 },
  { label: "Outlook", imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587 },
  { label: "QQ", imapHost: "imap.qq.com", imapPort: 993, smtpHost: "smtp.qq.com", smtpPort: 465 },
  { label: "163", imapHost: "imap.163.com", imapPort: 993, smtpHost: "smtp.163.com", smtpPort: 465 },
];

export function NewAccountDialog({
  open,
  onOpenChange,
  editAccount = null,
  gatewayUrl = "",
}: NewAccountDialogProps) {
  const addAccount = useEmailStore((s) => s.addAccount);
  const updateAccount = useEmailStore((s) => s.updateAccount);
  const [displayName, setDisplayName] = useState("");
  const [emailAddress, setEmailAddress] = useState("");
  const [password, setPassword] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [carddavUrl, setCarddavUrl] = useState("");
  const [easUrl, setEasUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isEditMode = !!editAccount;
  const isGmail = imapHost === "imap.gmail.com";

  // 编辑模式：用原账号字段初始化
  useEffect(() => {
    if (!open) return;
    if (editAccount) {
      setDisplayName(editAccount.displayName);
      setEmailAddress(editAccount.fromAddress);
      setPassword(""); // 密码留空，用户不修改则保留原密码
      setImapHost(editAccount.imapHost);
      setImapPort(String(editAccount.imapPort));
      setSmtpHost(editAccount.smtpHost);
      setSmtpPort(String(editAccount.smtpPort));
      setCarddavUrl(editAccount.carddavUrl ?? "");
      setEasUrl(editAccount.easUrl ?? "");
      setError(null);
      setTestResult(null);
      setTestMsg(null);
    } else {
      resetForm();
    }
  }, [open, editAccount]);

  // 邮箱地址变化时自动推断 EAS URL（仅新增模式且用户未手动填写时）
  useEffect(() => {
    if (!open || isEditMode) return;
    if (easUrl) return; // 用户已手动填写，不覆盖
    const inferred = inferEasUrl(emailAddress);
    if (inferred) {
      setEasUrl(inferred);
    }
  }, [emailAddress, open, isEditMode, easUrl]);

  if (!open) return null;

  const applyPreset = (preset: PresetConfig) => {
    setImapHost(preset.imapHost);
    setImapPort(String(preset.imapPort));
    setSmtpHost(preset.smtpHost);
    setSmtpPort(String(preset.smtpPort));
  };

  function resetForm() {
    setDisplayName("");
    setEmailAddress("");
    setPassword("");
    setImapHost("");
    setImapPort("993");
    setSmtpHost("");
    setSmtpPort("587");
    setCarddavUrl("");
    setEasUrl("");
    setError(null);
    setTestResult(null);
    setTestMsg(null);
  }

  const handleClose = () => {
    resetForm();
    onOpenChange(false);
  };

  const buildAccount = (): EmailAccount => {
    // 编辑模式下若密码留空，保留原密码
    const finalPassword = password || editAccount?.imapPassword || "";
    const imapPortNum = parseInt(imapPort, 10) || 993;
    const smtpPortNum = parseInt(smtpPort, 10) || 587;
    return {
      id: editAccount?.id ?? crypto.randomUUID(),
      displayName: displayName || emailAddress,
      imapHost,
      imapPort: imapPortNum,
      imapUsername: emailAddress,
      imapPassword: finalPassword,
      smtpHost,
      smtpPort: smtpPortNum,
      smtpUsername: emailAddress,
      smtpPassword: finalPassword,
      fromAddress: emailAddress,
      lastSyncedUid: editAccount?.lastSyncedUid ?? null,
      carddavUrl: carddavUrl.trim() || null,
      easUrl: easUrl.trim() || null,
      // 993 端口默认 SSL，465 端口默认 SSL，其他端口默认非 SSL
      imapUseSsl: editAccount?.imapUseSsl ?? imapPortNum === 993,
      smtpUseSsl: editAccount?.smtpUseSsl ?? smtpPortNum === 465,
      signatures: editAccount?.signatures ?? [],
    };
  };

  const handleTest = async () => {
    if (!emailAddress || !imapHost) {
      setTestResult("fail");
      setTestMsg("请填写邮箱地址和 IMAP 服务器");
      return;
    }
    if (!password && !editAccount) {
      setTestResult("fail");
      setTestMsg("请填写密码");
      return;
    }
    if (!gatewayUrl) {
      setTestResult("fail");
      setTestMsg("Gateway 未就绪，请确认 Mona 运行时已启动");
      return;
    }
    setTesting(true);
    setTestResult(null);
    setTestMsg(null);
    try {
      // 测试时若密码留空且为编辑模式，使用原密码
      const testAccount: EmailAccount = {
        ...buildAccount(),
        imapPassword: password || editAccount?.imapPassword || "",
      };
      const resp = await testConnection(gatewayUrl, testAccount, testAccount.imapPassword);
      setTestResult("ok");
      setTestMsg(`连接成功，发现 ${resp.folders ?? 0} 个文件夹`);
    } catch (e) {
      setTestResult("fail");
      setTestMsg(String(e));
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async () => {
    if (!emailAddress || !imapHost || !smtpHost) {
      setError("请填写邮箱地址和服务器配置");
      return;
    }
    if (!isEditMode && !password) {
      setError("请填写密码");
      return;
    }
    const account = buildAccount();
    setSubmitting(true);
    setError(null);
    try {
      if (isEditMode) {
        await updateAccount(account);
      } else {
        await addAccount(account);
      }
      resetForm();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-[460px] rounded-lg border border-border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-foreground">
            {isEditMode ? "编辑邮箱账号" : "添加邮箱账号"}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={handleClose}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {!isEditMode && (
          <div className="mb-4 flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-[11.5px]"
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <Field label="显示名称">
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="可选"
              className="h-8 rounded-full px-3 text-[13px]"
            />
          </Field>
          <Field label="邮箱地址">
            <Input
              value={emailAddress}
              onChange={(e) => setEmailAddress(e.target.value)}
              placeholder="you@example.com"
              className="h-8 rounded-full px-3 text-[13px]"
            />
          </Field>
          <Field label={isEditMode ? "密码（留空则不修改）" : "密码"}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isGmail ? "应用专用密码" : "邮箱密码或授权码"}
              className="h-8 rounded-full px-3 text-[13px]"
            />
            {isGmail && (
              <p className="text-[11px] text-muted-foreground">
                Gmail 已停用纯密码登录，需开启两步验证后生成应用专用密码填入上方。
                <a
                  href="https://myaccount.google.com/apppasswords"
                  onClick={(e) => {
                    e.preventDefault();
                    openExternalUrl("https://myaccount.google.com/apppasswords");
                  }}
                  className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline"
                >
                  获取应用专用密码
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="IMAP 服务器">
              <Input
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                placeholder="imap.example.com"
                className="h-8 rounded-full px-3 text-[13px]"
              />
            </Field>
            <Field label="IMAP 端口">
              <Input
                value={imapPort}
                onChange={(e) => setImapPort(e.target.value)}
                className="h-8 rounded-full px-3 text-[13px]"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SMTP 服务器">
              <Input
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.example.com"
                className="h-8 rounded-full px-3 text-[13px]"
              />
            </Field>
            <Field label="SMTP 端口">
              <Input
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                className="h-8 rounded-full px-3 text-[13px]"
              />
            </Field>
          </div>
          <Field label="CardDAV 通讯录地址（可选）">
            <Input
              value={carddavUrl}
              onChange={(e) => setCarddavUrl(e.target.value)}
              placeholder="QQ/Gmail/iCloud 填，如 https://dav.qq.com/"
              className="h-8 rounded-full px-3 text-[13px]"
            />
          </Field>
          <Field label="ActiveSync 通讯录地址（可选，企业邮用）">
            <Input
              value={easUrl}
              onChange={(e) => setEasUrl(e.target.value)}
              placeholder="腾讯企业邮填 https://ex.exmail.qq.com/Microsoft-Server-ActiveSync"
              className="h-8 rounded-full px-3 text-[13px]"
            />
          </Field>
          {testResult && (
            <div
              className={
                testResult === "ok"
                  ? "flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-600"
                  : "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
              }
            >
              {testResult === "ok" && <Check className="h-3.5 w-3.5 shrink-0" />}
              {testMsg}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-3 text-[12px]"
            onClick={handleClose}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-3 text-[12px]"
            disabled={testing || submitting}
            onClick={handleTest}
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            测试连接
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 px-3 text-[12px]"
            disabled={submitting || testing}
            onClick={handleSubmit}
          >
            {submitting ? (isEditMode ? "保存中..." : "添加中...") : isEditMode ? "保存" : "添加"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11.5px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
