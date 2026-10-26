import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createStockVibeRequestId, getStockVibeRequest, type StockVibeRequestRecord } from "@/lib/stock-vibe-api";
import { getStockVibeDataSettings, parseStockVibeDataSettings, updateStockVibeDataSettings, type StockVibeDataSettings } from "@/lib/stock-vibe-data-settings-api";

export interface StockVibeDataSettingsProps { onError: (message: string) => void; onSaved?: () => void; }
const STORAGE = "mona.stock-vibe.data-settings.pending.v1";
const UUID = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;
const SOURCE: Record<StockVibeDataSettings["source"], string> = { settings: "Mona 本地设置", environment: "环境变量", unconfigured: "未设置" };
function pendingId(): string | null { try { const id = localStorage.getItem(STORAGE); return id && UUID.test(id) ? id : null; } catch { return null; } }

export function StockVibeDataSettings({ onError, onSaved }: StockVibeDataSettingsProps) {
  const [settings, setSettings] = useState<StockVibeDataSettings | null>(null), [loading, setLoading] = useState(true);
  const [token, setToken] = useState(""), [fieldError, setFieldError] = useState("");
  const [pending, setPending] = useState(pendingId), [notice, setNotice] = useState("");
  const dispatching = useRef(false), revision = useRef(0), errorRef = useRef(onError), savedRef = useRef(onSaved);
  errorRef.current = onError; savedRef.current = onSaved;
  useEffect(() => {
    let active = true; const observed = revision.current;
    void getStockVibeDataSettings().then((value) => { if (active && revision.current === observed) setSettings(value); }).catch(() => { if (active && revision.current === observed) errorRef.current("行情数据设置暂时无法读取，请重新打开查看。已有设置没有改变。"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const accept = useCallback((record: StockVibeRequestRecord, id: string) => {
    if (record.request_id?.replace(/-/g, "").toLowerCase() !== id.replace(/-/g, "").toLowerCase() || record.method !== "PUT" || record.path !== "/host/data-settings" || record.receipt_owner !== "mona_settings" || record.source !== null) return;
    const code = record.receipt?.status_code, signed = /^[a-f\d]{64}$/i.test(record.receipt_sha256 ?? "");
    if (record.status === "completed" && signed && code && code >= 200 && code < 300) {
      const value = parseStockVibeDataSettings(record.receipt?.body);
      revision.current += 1; localStorage.removeItem(STORAGE); setPending(null); setSettings(value); setToken(""); setNotice("行情数据设置已更新。"); savedRef.current?.();
    } else if (record.status === "rejected" && ((record.error_category === "not_dispatched" && record.receipt === null) || Boolean(signed && code && code >= 400 && code < 500))) {
      localStorage.removeItem(STORAGE); setPending(null); errorRef.current("这次数据设置没有保存，请检查输入后重新保存。");
    }
  }, []);
  useEffect(() => {
    if (!pending) return;
    let active = true, reading = false, warned = false;
    const poll = async () => {
      if (reading || dispatching.current) return; reading = true;
      try { const record = await getStockVibeRequest(pending); if (active) accept(record, pending); }
      catch { if (active && !warned) { warned = true; errorRef.current("数据设置的提交结果仍在核对，原请求已保留，没有重复保存。"); } }
      finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 3000); return () => { active = false; window.clearInterval(timer); };
  }, [accept, pending]);
  async function save(clear = false) {
    if (dispatching.current || pending) return;
    const value = clear ? "" : token.trim();
    if (!clear && !value) { setFieldError("请输入新的 Tushare 凭据。"); return; }
    if (value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) { setFieldError("凭据不能包含控制字符，长度不能超过 512 个字符。"); return; }
    const id = createStockVibeRequestId();
    try { localStorage.setItem(STORAGE, id); } catch { errorRef.current("无法保存请求核对信息，本次尚未修改数据设置。请检查本机存储后重试。"); return; }
    dispatching.current = true; setPending(id); setNotice(""); setFieldError("");
    try { accept(await updateStockVibeDataSettings(id, value), id); }
    catch { errorRef.current("数据设置的提交结果暂未确认，系统会核对原请求，请勿重复保存。"); }
    finally { dispatching.current = false; }
  }
  return <div className="space-y-4 text-caption">
    <p className="text-muted-foreground">部分 A 股行情和因子评测需要 Tushare 凭据及对应数据权限；未配置时仍可浏览方法和已有报告。</p>
    <dl className="grid grid-cols-2 gap-4"><div><dt className="text-muted-foreground">配置状态</dt><dd className="mt-1 font-medium">{settings ? settings.tushare_configured ? "已配置" : "未配置" : loading ? "正在读取…" : "暂未读到状态"}</dd></div><div><dt className="text-muted-foreground">当前来源</dt><dd className="mt-1">{settings ? SOURCE[settings.source] : "待确认"}</dd></div></dl>
    {settings?.source === "environment" && <p className="rounded-md bg-muted p-3 text-muted-foreground">{settings.tushare_configured ? "当前使用环境变量，它优先于本地设置。" : "环境变量当前为空或空白，本地设置不会覆盖它。"}保存或清除只修改 Mona 本地设置，不会改变环境来源。</p>}
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="space-y-1.5"><label htmlFor="stock-vibe-tushare-token">新的 Tushare 凭据</label><Input id="stock-vibe-tushare-token" type="password" autoComplete="new-password" spellCheck={false} maxLength={512} value={token} disabled={Boolean(pending)} placeholder="输入新值以保存或替换" onChange={(event) => { setToken(event.target.value); setFieldError(""); }} aria-invalid={Boolean(fieldError)} />{fieldError && <p role="alert" className="text-destructive">{fieldError}</p>}</div>
      <div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" disabled={Boolean(pending)} onClick={() => { void save(true); }}>清除本地设置</Button><Button type="submit" className="bg-[hsl(var(--info))] text-[hsl(var(--background))] hover:bg-[hsl(var(--info))]/90" disabled={Boolean(pending) || !token.trim()}>{pending ? "正在核对保存结果…" : "保存凭据"}</Button></div>
    </form>
    {notice && <p role="status">{notice}</p>}
    {pending && <p role="status" className="text-muted-foreground">正在核对本次请求，系统不会重复保存。关闭后再打开仍可继续核对。</p>}
    <p className="text-muted-foreground">已保存的凭据不会回显。配置状态不代表数据权限已验证；更新用于后续任务，已有研究不会重新执行。</p>
  </div>;
}
