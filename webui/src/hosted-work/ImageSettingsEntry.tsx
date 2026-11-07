import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AdminRequestError, isValidPriceAmount } from "./model-admin-api";
import { requestImageSettings, type ImageConfiguration, type ImageSettings } from "./image-admin-api";

type Draft = { enabled: boolean; amount: string };
const toDraft = (configuration: ImageConfiguration): Draft => ({
  enabled: configuration.enabled, amount: configuration.price?.amount_per_image ?? "",
});

export function ImageSettingsEntry({ token, onSaved }: { token: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ImageSettings | null>(null);
  const [availability, setAvailability] = useState<ImageSettings["availability"] | null>(null);
  const [latest, setLatest] = useState<ImageSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [priceError, setPriceError] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    if (open) {
      setBusy(true); setSnapshot(null); setDraft(null); setLatest(null); setPriceError(""); setConflict(false); setProblem("");
    }
    requestImageSettings(token, undefined, controller.signal).then(settings => {
      if (controller.signal.aborted) return;
      setAvailability(settings.availability);
      if (open) { setSnapshot(settings); setDraft(toDraft(settings.configuration)); }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setAvailability(null);
        if (open) setProblem("无法读取生图配置，请检查管理员登录后重试。");
      }
    }).finally(() => { if (open && !controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [open, token]);

  async function save() {
    if (!draft || !snapshot || busy || conflict || !snapshot.synchronized) return;
    const amount = draft.amount.trim();
    if ((!amount && draft.enabled) || amount && !isValidPriceAmount(amount)) {
      setPriceError("请填写有效价格，最多六位小数。");
      return;
    }
    const configuration: ImageConfiguration = { enabled: draft.enabled,
      price: amount ? { amount_per_image: amount } : null };
    setBusy(true); setProblem(""); setPriceError("");
    try {
      const saved = await requestImageSettings(token, { expected_revision: snapshot.revision, configuration });
      setAvailability(saved.availability);
      setOpen(false); setNotice("生图配置已保存。"); onSaved();
    } catch (error) {
      if (error instanceof AdminRequestError && error.code === "configuration_changed") {
        setConflict(true); setProblem("配置已变化，请刷新状态后核对草稿。");
      } else if (error instanceof AdminRequestError && error.field === "price") {
        setPriceError("请填写有效价格，最多六位小数。");
      } else if (error instanceof AdminRequestError && error.code === "work_busy") {
        setProblem("工作台正在处理任务，请结束后再保存。");
      } else setProblem("配置未保存，请检查管理员登录或连接后重试。");
    } finally { setBusy(false); }
  }

  async function refreshConflict() {
    if (!snapshot || busy) return;
    setBusy(true);
    try {
      const next = await requestImageSettings(token);
      setAvailability(next.availability);
      if (JSON.stringify(next.configuration) === JSON.stringify(snapshot.configuration)) {
        setSnapshot(next); setConflict(false); setLatest(null); setProblem("状态已更新，可以继续保存草稿。");
      } else {
        setLatest(next); setProblem("生图配置已被修改，请加载最新配置后核对。");
      }
    } catch { setProblem("无法刷新配置，请检查管理员登录或连接后重试。"); }
    finally { setBusy(false); }
  }

  return <div className="border-t border-border pt-4" role="group" aria-label="GPT 生图">
    <div className="flex flex-wrap items-center justify-between gap-3"><div>
      <p className="text-ui font-medium">GPT 生图</p>
      <p className="text-caption text-muted-foreground">{availability?.message ?? "生图配置状态暂不可用。"}</p>
    </div><Button type="button" variant="outline" onClick={() => { setNotice(""); setOpen(true); }}>设置 GPT 生图</Button></div>
    {notice && <p role="status" className="mt-2 text-caption text-muted-foreground">{notice}</p>}
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" showCloseButton={false}>
        <DialogHeader><DialogTitle>GPT 生图设置</DialogTitle><DialogDescription>{snapshot?.availability.message
          ?? (busy ? "正在读取生图配置。" : "生图配置状态暂不可用。")}</DialogDescription></DialogHeader>
        {busy && !draft ? <p className="text-ui text-muted-foreground">正在读取配置…</p> : draft && snapshot && <div className="space-y-4">
          <div className="flex items-center justify-between gap-3"><span className="text-ui font-medium">启用生图</span>
            <Switch aria-label="启用生图" checked={draft.enabled} disabled={busy} onCheckedChange={enabled => {
              setDraft(previous => previous ? { ...previous, enabled } : previous); setProblem("");
            }} /></div>
          <div className="space-y-2"><label htmlFor="image-price" className="text-ui font-medium">每张图片价格（元）</label>
            <Input id="image-price" inputMode="decimal" value={draft.amount} disabled={busy} aria-invalid={!!priceError}
              onChange={event => { setDraft({ ...draft, amount: event.target.value }); setPriceError(""); setProblem(""); }} />
            <p className={priceError ? "text-caption text-destructive" : "text-caption text-muted-foreground"}>
              {priceError || "输入 0 表示免费。"}</p></div>
          {!snapshot.synchronized && <p className="text-caption text-muted-foreground">配置尚未同步，暂不能保存。</p>}
        </div>}
        {problem && <p role="alert" className="text-ui text-muted-foreground">{problem}</p>}
        <DialogFooter>
          {conflict && !latest && <Button type="button" variant="outline" disabled={busy} onClick={() => void refreshConflict()}>刷新状态</Button>}
          {latest && <Button type="button" variant="outline" disabled={busy} onClick={() => {
            setSnapshot(latest); setDraft(toDraft(latest.configuration)); setLatest(null); setConflict(false); setPriceError(""); setProblem("");
          }}>加载最新配置</Button>}
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button type="button" disabled={busy || !draft || !snapshot?.synchronized || conflict} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
