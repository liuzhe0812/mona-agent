import { useEffect, useState } from "react";
import { Loader2, LockKeyhole } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getFolders, listAccounts } from "@/components/email/lib/emailApi";
import { getFolderDisplayName } from "@/components/email/lib/folderUtils";
import type { EmailAccount, EmailFolder } from "@/components/email/lib/types";
import { useLicense } from "@/hooks/useLicense";
import {
  readEmailScheduleConfig, writeEmailScheduleConfig, type EmailScheduleConfig,
} from "@/lib/tauri";

interface EmailExtractionSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSubscribe: () => void;
  onAddEmailAccount: () => void;
  onOpenEmail: () => void;
}

export function EmailExtractionSettingsDialog({
  open, onOpenChange, onOpenSubscribe, onAddEmailAccount, onOpenEmail,
}: EmailExtractionSettingsDialogProps) {
  const { licenseActive } = useLicense();
  const [config, setConfig] = useState<EmailScheduleConfig | null>(null);
  const [sources, setSources] = useState<{ account: EmailAccount; folders: EmailFolder[] }[]>([]);
  const [leadMinutes, setLeadMinutes] = useState("");
  const [skipSenders, setSkipSenders] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<"folders" | "leadMinutes" | null>(null);
  const [error, setError] = useState<"load" | "save" | null>(null);

  useEffect(() => {
    if (!open || !licenseActive) return;
    let cancelled = false;
    setConfig(null);
    setFieldError(null);
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        const [nextConfig, accounts] = await Promise.all([
          readEmailScheduleConfig(), listAccounts(),
        ]);
        const nextSources = await Promise.all(accounts.map(async (account) => ({
          account,
          folders: await getFolders(account.id),
        })));
        if (cancelled) return;
        setConfig(nextConfig);
        setSources(nextSources);
        setLeadMinutes(String(nextConfig.leadMinutes));
        setSkipSenders(nextConfig.skipSenders.join(", "));
      } catch (cause) {
        console.error("[email-extraction-settings] load failed", cause);
        if (!cancelled) setError("load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, licenseActive]);

  const save = async () => {
    if (!config || saving || !licenseActive) return;
    if (config.enabled && config.folders.length === 0) {
      setFieldError("folders");
      return;
    }
    const minutes = Number(leadMinutes);
    if (!leadMinutes.trim() || !Number.isInteger(minutes) || minutes < 0) {
      setFieldError("leadMinutes");
      return;
    }
    setFieldError(null);
    setSaving(true);
    try {
      await writeEmailScheduleConfig({
        ...config,
        leadMinutes: minutes,
        skipSenders: skipSenders.split(/[,，\n]/).map((sender) => sender.trim()).filter(Boolean),
      });
      onOpenChange(false);
    } catch (cause) {
      console.error("[email-extraction-settings] save failed", cause);
      setError("save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>邮件提取</DialogTitle>
            <DialogDescription>
              从新邮件识别与你有关的日程和待办。这些设置对下方所有邮箱生效。
            </DialogDescription>
          </DialogHeader>
          {!licenseActive ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <LockKeyhole className="h-5 w-5 text-muted-foreground" aria-hidden />
              <p className="text-ui">邮件提取是 Pro 功能</p>
              <Button onClick={() => { onOpenChange(false); onOpenSubscribe(); }}>升级 Pro</Button>
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 py-6 text-caption text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" />正在加载邮件提取设置…
            </div>
          ) : config && (
            <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
              {sources.length === 0 ? (
                <div className="space-y-3 py-3">
                  <p className="text-ui text-muted-foreground">添加邮箱后，即可选择从哪些新邮件提取日程和待办。</p>
                  <Button variant="outline" onClick={onAddEmailAccount}>添加邮箱</Button>
                </div>
              ) : (
                <>
                  <label className="flex items-center gap-2 text-ui">
                    <Checkbox
                      checked={config.enabled}
                      onCheckedChange={(checked) => setConfig({ ...config, enabled: checked === true })}
                    />
                    自动从新邮件提取日程和待办
                  </label>

                  <section className="space-y-3" aria-labelledby="email-extraction-sources">
                    <div className="flex items-center justify-between">
                      <h3 id="email-extraction-sources" className="text-caption font-medium">提取来源</h3>
                      <Button variant="ghost" size="sm" onClick={onOpenEmail}>管理邮箱</Button>
                    </div>
                    {sources.map(({ account, folders }) => {
                      const visibleFolders = folders.filter((folder) => !/junk|spam|trash|deleted|draft|垃圾|已删除|草稿|回收站/i.test(
                        `${folder.name} ${getFolderDisplayName(folder.name)}`,
                      ));
                      return (
                        <div key={account.id} role="group" aria-label={account.displayName} className="space-y-2 border-b border-border/40 pb-3 last:border-0 last:pb-0">
                          <div>
                            <p className="text-ui font-medium">{account.displayName}</p>
                            <p className="text-caption text-muted-foreground">{account.fromAddress}</p>
                          </div>
                          {visibleFolders.length === 0 ? (
                            <p className="text-caption text-muted-foreground">请先在邮件页面同步此邮箱的文件夹。</p>
                          ) : (
                            <div className="flex flex-wrap gap-x-4 gap-y-2">
                              {visibleFolders.map((folder) => {
                                const key = `${account.id}:${folder.name}`;
                                return (
                                  <label key={key} className="flex items-center gap-2 text-ui">
                                    <Checkbox
                                      checked={config.folders.includes(key)}
                                      onCheckedChange={(checked) => {
                                        setConfig({ ...config, folders: checked === true
                                          ? [...config.folders, key]
                                          : config.folders.filter((value) => value !== key) });
                                        setFieldError(null);
                                      }}
                                    />
                                    {getFolderDisplayName(folder.name)}
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <p className="text-caption text-muted-foreground">仅处理所选文件夹之后收到的新邮件，不扫描历史邮件。</p>
                    {fieldError === "folders" && <p className="text-caption text-destructive" role="alert">请至少选择一个提取文件夹。</p>}
                  </section>

                  <fieldset className="space-y-2">
                    <legend className="text-caption font-medium">处理方式</legend>
                    <label className="flex items-start gap-2 text-ui">
                      <input type="radio" name="email-extraction-mode" checked={config.createMode === "confirm"}
                        onChange={() => setConfig({ ...config, createMode: "confirm" })} className="mt-1 accent-primary" />
                      <span>确认后创建<span className="block text-caption text-muted-foreground">日程和待办进入收集箱，等待你确认。</span></span>
                    </label>
                    <label className="flex items-start gap-2 text-ui">
                      <input type="radio" name="email-extraction-mode" checked={config.createMode === "auto"}
                        onChange={() => setConfig({ ...config, createMode: "auto" })} className="mt-1 accent-primary" />
                      <span>明确的日程直接创建<span className="block text-caption text-muted-foreground">待办和存疑日程仍进入收集箱。</span></span>
                    </label>
                  </fieldset>

                  <div className="space-y-2">
                    <Label htmlFor="email-extraction-lead">提前提醒（分钟）</Label>
                    <Input id="email-extraction-lead" type="number" min={0} step={1} value={leadMinutes}
                      onChange={(event) => { setLeadMinutes(event.target.value); setFieldError(null); }}
                      aria-invalid={fieldError === "leadMinutes"} />
                    {fieldError === "leadMinutes" && <p className="text-caption text-destructive" role="alert">请输入零或正整数。</p>}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email-extraction-skip">跳过这些发件人</Label>
                    <Textarea id="email-extraction-skip" rows={3} value={skipSenders}
                      onChange={(event) => setSkipSenders(event.target.value)}
                      placeholder="输入邮箱地址或域名，用逗号或换行分隔" />
                  </div>
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>关闭</Button>
            {licenseActive && <Button disabled={!config || loading || saving || sources.length === 0} onClick={() => void save()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}保存
            </Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={error !== null} onOpenChange={(next) => {
        if (!next) {
          if (error === "load") onOpenChange(false);
          setError(null);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{error === "load" ? "加载邮件提取设置失败" : "保存邮件提取设置失败"}</AlertDialogTitle>
            <AlertDialogDescription>{error === "load" ? "请关闭后重新打开设置重试。" : "设置未能确认保存，请重试。"}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogAction>知道了</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
