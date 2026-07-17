import { invoke } from "@tauri-apps/api/core";
import { Boxes, CheckCircle2, Loader2, RefreshCw, Search, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { MetricCard, PanelCard, StatusPill, TaskFailureNotice, secondaryButtonClass } from "./SystemUi";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import type { SoftwareActionResult } from "./useSystemData";

type AppRisk = "safe" | "optional" | "unsafe";

interface WindowsAppEntry {
  id: string;
  appIds: string[];
  name: string;
  description: string;
  recommendation: AppRisk;
  removalMethod: string;
  installed: boolean;
  selectedByDefault: boolean;
}

interface WindowsAppCatalogResult {
  items: WindowsAppEntry[];
  total: number;
  installedCount: number;
  sourceVersion: string;
}

const riskMeta: Record<AppRisk, { label: string; tone: "green" | "orange" | "red"; description: string }> = {
  safe: { label: "通常可移除", tone: "green", description: "不是 Windows 核心组件，需要时通常可从商店重新安装。" },
  optional: { label: "按需保留", tone: "orange", description: "可能与设备、账户或常用功能有关，请确认自己是否使用。" },
  unsafe: { label: "高风险", tone: "red", description: "可能影响商店、浏览器、终端、游戏或系统故障排查能力。" },
};

interface WindowsAppsPanelProps {
  onHandoff: (task: SystemAgentHandoffTask) => void;
}

export function WindowsAppsPanel({ onHandoff }: WindowsAppsPanelProps) {
  const [data, setData] = useState<WindowsAppCatalogResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState<"all" | AppRisk>("all");
  const [installedOnly, setInstalledOnly] = useState(true);
  const [pending, setPending] = useState<WindowsAppEntry | null>(null);
  const [lastAttempt, setLastAttempt] = useState<WindowsAppEntry | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [working, setWorking] = useState("");
  const [result, setResult] = useState<SoftwareActionResult | null>(null);
  const [dismissedFailure, setDismissedFailure] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try { setData(await invoke<WindowsAppCatalogResult>("system_list_windows_apps")); }
    catch (nextError) { setError(String(nextError)); }
    finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); }, []);

  const visible = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return (data?.items ?? []).filter((item) => {
      if (installedOnly && !item.installed) return false;
      if (risk !== "all" && item.recommendation !== risk) return false;
      return !keyword || `${item.name} ${item.description} ${item.appIds.join(" ")}`.toLocaleLowerCase().includes(keyword);
    });
  }, [data, query, risk, installedOnly]);

  const remove = async (item: WindowsAppEntry) => {
    setLastAttempt(item);
    setWorking(item.id);
    setResult(null);
    setDismissedFailure(false);
    try {
      const next = await invoke<SoftwareActionResult>("system_remove_windows_app", {
        id: item.id,
        riskAcknowledged: item.recommendation !== "unsafe" || acknowledged,
      });
      setResult(next);
      setPending(null);
      setAcknowledged(false);
      await refresh();
    } catch (nextError) {
      setResult({ success: false, message: String(nextError), exitCode: null, residuals: [] });
      setPending(null);
    } finally { setWorking(""); }
  };

  const safeCount = data?.items.filter((item) => item.recommendation === "safe").length ?? 86;
  const unsafeCount = data?.items.filter((item) => item.recommendation === "unsafe").length ?? 7;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="完整目录" value={`${data?.total ?? 141} 项`} detail="覆盖 Windows 与 OEM 应用" icon={<Boxes className="h-4 w-4" />} />
        <MetricCard label="本机已安装" value={loading ? "检测中" : `${data?.installedCount ?? 0} 项`} detail="默认只显示已安装项目" icon={<CheckCircle2 className="h-4 w-4" />} accent="violet" />
        <MetricCard label="通常可移除" value={`${safeCount} 项`} detail="仍由你逐项确认" icon={<ShieldCheck className="h-4 w-4" />} accent="green" />
        <MetricCard label="高风险" value={`${unsafeCount} 项`} detail="展示但不会自动选择" icon={<ShieldAlert className="h-4 w-4" />} accent="orange" />
      </div>

      {result?.success && <div role="status" className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3 text-xs text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" />{result.message || "卸载完成"}</div>}
      {result && !result.success && !dismissedFailure && <TaskFailureNotice title={`卸载 ${lastAttempt?.name ?? "Windows 应用"} 失败`} detail={result.message || "Windows 未返回详细原因"} onRetry={lastAttempt ? () => void remove(lastAttempt) : undefined} onHandoff={() => { setDismissedFailure(true); onHandoff({ id: crypto.randomUUID(), title: `卸载 ${lastAttempt?.name ?? "Windows 应用"}`, action: "卸载软件", target: lastAttempt?.name ?? "Windows 应用", arguments: { id: lastAttempt?.id, appIds: lastAttempt?.appIds }, error: result.message || "Windows 未返回详细原因" }); }} onDismiss={() => setDismissedFailure(true)} />}

      <PanelCard title="Windows 预装应用" action={<span className="text-[11px] text-muted-foreground">完整目录 {data?.total ?? 141} 项</span>}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><input aria-label="搜索预装应用" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索应用名称或 App ID" className="h-9 w-full rounded-lg border bg-background pl-9 pr-3 text-xs outline-none focus:border-blue-500" /></div>
          <select aria-label="预装应用风险筛选" value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)} className="h-9 rounded-lg border bg-background px-2.5 text-xs"><option value="all">全部风险</option><option value="safe">通常可移除</option><option value="optional">按需保留</option><option value="unsafe">高风险</option></select>
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border bg-background px-3 text-xs"><input type="checkbox" checked={installedOnly} onChange={(event) => setInstalledOnly(event.target.checked)} />仅本机已安装</label>
          <button type="button" className={secondaryButtonClass} onClick={() => void refresh()} disabled={loading}><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />刷新</button>
        </div>
        {error && <div role="alert" className="mb-3 rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-400">预装应用读取失败：{error}</div>}
        <div className="max-h-[480px] overflow-auto rounded-xl border border-border/60">
          <table className="w-full min-w-[720px] table-fixed text-left text-xs">
            <colgroup><col className="w-[210px]" /><col /><col className="w-[105px]" /><col className="w-[95px]" /><col className="w-[78px]" /></colgroup>
            <thead className="sticky top-0 z-10 bg-card text-muted-foreground"><tr><th className="px-3 py-2.5 font-medium">应用</th><th className="font-medium">说明</th><th className="font-medium">建议</th><th className="font-medium">状态</th><th /></tr></thead>
            <tbody>{visible.map((item) => { const meta = riskMeta[item.recommendation]; return <tr key={item.id} className="border-t border-border/50 transition hover:bg-muted/25"><td className="px-3 py-2.5"><p className="truncate font-medium" title={item.name}>{item.name}</p><p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={item.appIds.join(", ")}>{item.appIds[0]}</p></td><td className="pr-3"><p className="truncate text-muted-foreground" title={item.description}>{item.description}</p></td><td><StatusPill tone={meta.tone}>{meta.label}</StatusPill></td><td><StatusPill tone={item.installed ? "blue" : "neutral"}>{item.installed ? "已安装" : "未安装"}</StatusPill></td><td className="pr-3 text-right"><button type="button" className="text-blue-600 hover:underline disabled:text-muted-foreground disabled:no-underline" disabled={!item.installed || Boolean(working)} onClick={() => { setPending(item); setAcknowledged(false); setResult(null); }}>{working === item.id ? "卸载中" : "卸载"}</button></td></tr>; })}</tbody>
          </table>
          {!loading && visible.length === 0 && <p className="py-12 text-center text-xs text-muted-foreground">没有符合条件的应用</p>}
        </div>
        <div className="mt-3 flex gap-2 rounded-lg border border-blue-500/15 bg-blue-500/[0.04] p-3 text-[11px] leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" /><p>目录用于识别 Windows 预装与 OEM 应用。Mona 不会默认全选，也不会因 AI 建议直接卸载；每个项目都需要你确认。</p></div>
      </PanelCard>

      <AlertDialog open={Boolean(pending)} onOpenChange={(open) => { if (!open && !working) { setPending(null); setAcknowledged(false); } }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>卸载“{pending?.name ?? "Windows 应用"}”？</AlertDialogTitle><AlertDialogDescription>{pending ? riskMeta[pending.recommendation].description : ""} 卸载后可能需要从 Microsoft Store 或厂商渠道重新安装。</AlertDialogDescription></AlertDialogHeader>{pending?.recommendation === "unsafe" && <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-xs leading-5"><input className="mt-1" type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span><strong className="text-red-700 dark:text-red-400">我已了解该应用被标记为高风险</strong><br /><span className="text-muted-foreground">移除后可能影响 Windows 核心体验或难以重新安装。</span></span></label>}<AlertDialogFooter><AlertDialogCancel disabled={Boolean(working)}>取消</AlertDialogCancel><AlertDialogAction disabled={Boolean(working) || (pending?.recommendation === "unsafe" && !acknowledged)} onClick={(event) => { event.preventDefault(); if (pending) void remove(pending); }} className={pending?.recommendation === "unsafe" ? "bg-red-600 text-white hover:bg-red-700" : "bg-blue-600 text-white hover:bg-blue-700"}>{working && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}确认卸载</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
