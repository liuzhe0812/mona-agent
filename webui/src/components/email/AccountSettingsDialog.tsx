import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useEmailStore } from "./store/emailStore";
import type { EmailAccount } from "./lib/types";

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !account) return;
    setDisplayName(account.displayName);
    setFromName(account.fromName ?? "");
    setEmailAddress(account.fromAddress);
    setImapUsername(account.imapUsername);
    setImapHost(account.imapHost);
    setImapPort(String(account.imapPort));
    setImapSsl(account.imapPort === 993);
    setSmtpHost(account.smtpHost);
    setSmtpPort(String(account.smtpPort));
    setSmtpSsl(account.smtpPort === 465);
    setError(null);
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
        smtpHost: smtpHost.trim(),
        smtpPort: parseInt(smtpPort, 10) || 587,
      };
      await updateAccount(updated);
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
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
        className="max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">邮箱设置</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5">
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
    </Dialog>
  );
}
