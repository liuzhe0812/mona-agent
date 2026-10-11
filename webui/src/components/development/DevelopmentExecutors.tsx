import { useEffect, useRef, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { developmentApi, executorLabels, type DevExecutor, type ExecutorId, type ExecutorSettings, type NativeProbe } from "@/lib/development-api";
import { isTauri } from "@/lib/tauri";
import { DevelopmentLogin } from "./DevelopmentLogin";

const nativeIds: ExecutorId[] = ["codex", "claude", "codebuddy"];
const stageLabels: Record<string, string> = { discovery: "程序定位", dependency: "配套依赖", launch: "程序启动", protocol: "原生协议", authentication: "认证确认", ready: "连接就绪" };
const sourceLabels: Record<string, string> = { configured: "指定路径", path: "系统命令路径", standard_location: "标准安装位置", npm_platform_package: "Codex 官方平台包", desktop_application: "Codex 桌面应用" };

export function DevelopmentExecutors({ open, onClose, projectId, executors, onChanged }: {
  open: boolean; onClose: () => void; projectId?: string; executors: DevExecutor[]; onChanged: () => void;
}) {
  const [settings, setSettings] = useState<ExecutorSettings>();
  const [values, setValues] = useState<Record<string, string | null>>({});
  const [results, setResults] = useState<Record<string, NativeProbe>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const dirty = !!settings && Object.keys(settings.values).some((key) => (values[key] || null) !== (settings.values[key] || null));
  useEffect(() => {
    const epoch = ++generation.current;
    if (!open) return;
    let alive = true;
    setError(""); setResults({}); setSettings(undefined); setBusy("");
    void developmentApi.executorSettings().then((data) => { if (alive) { setSettings(data); setValues(data.values); } })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "读取设置失败"); });
    return () => { alive = false; if (generation.current === epoch) generation.current += 1; };
  }, [open, projectId]);
  const execute = async (key: string, action: (current: () => boolean) => Promise<unknown>) => {
    const epoch = generation.current;
    const current = () => generation.current === epoch;
    setBusy(key); setError("");
    try { await action(current); if (current()) onChanged(); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "操作未完成"); }
    finally { if (current()) setBusy(""); }
  };
  const save = () => settings && execute("save", async (current) => {
    const saved = await developmentApi.updateExecutorSettings(settings, values);
    if (current()) { setSettings(saved); setValues(saved.values); setResults({}); }
  });
  const pick = (executor: ExecutorId) => execute(`pick:${executor}`, async (current) => {
    const { open: choose } = await import("@tauri-apps/plugin-dialog");
    const file = await choose({ directory: false, multiple: false, title: `选择 ${executorLabels[executor]} 原生程序` });
    if (current() && typeof file === "string") setValues((old) => ({ ...old, [`${executor}Path`]: file }));
  });
  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}><DialogContent className="max-h-[85vh] max-w-2xl overflow-auto">
    <DialogHeader><DialogTitle>开发执行者</DialogTitle><DialogDescription>连接本地原生 Agent。只共享项目规则和项目 Skills，不加载用户行为配置、MCP 或 Hooks。认证与项目上下文分开。</DialogDescription></DialogHeader>
    {nativeIds.map((executor) => {
      const configured = executors.find((item) => item.id === executor);
      const result = dirty ? undefined : results[executor] ?? configured?.probe;
      return <section key={executor} className="space-y-2 border-t border-border/60 pt-4">
        <div className="flex items-center justify-between"><h3 className="text-body font-medium">{executorLabels[executor]}</h3>
          {result?.stage && <span className="text-caption text-muted-foreground">{stageLabels[result.stage] ?? "检查状态"}</span>}</div>
        <label className="block space-y-1"><span className="text-caption text-muted-foreground">原生程序路径（留空自动查找）</span>
          <div className="flex gap-2"><Input disabled={!!busy || !settings} aria-label={`${executorLabels[executor]} 程序路径`} value={values[`${executor}Path`] ?? ""} onChange={(e) => setValues((old) => ({ ...old, [`${executor}Path`]: e.target.value }))} />
            {isTauri() && <Button variant="outline" size="icon" aria-label={`选择 ${executorLabels[executor]} 程序`} onClick={() => void pick(executor)} disabled={!!busy}><FolderOpen className="h-4 w-4" /></Button>}</div></label>
        {executor === "codebuddy" && <label className="block space-y-1"><span className="text-caption text-muted-foreground">API Key 所在的环境变量名称（不要填写密钥）</span>
          <Input disabled={!!busy || !settings} aria-label={`${executorLabels[executor]} 认证环境变量`} value={values[`${executor}ApiKeyEnv`] ?? ""} onChange={(e) => setValues((old) => ({ ...old, [`${executor}ApiKeyEnv`]: e.target.value }))} />
          <span className="text-micro text-muted-foreground">{settings?.credentialPresent[executor] ? "当前进程可读取此认证来源" : "当前进程未发现此认证来源；设置环境变量后需重新启动开发服务"}</span></label>}
        <p className="text-caption text-muted-foreground">{result?.reason || configured?.reason || "尚未检查"}</p>
        {result?.executable && <p className="break-all text-micro text-muted-foreground">{sourceLabels[result.source ?? ""] ?? "实际程序"}：{result.executable}</p>}
        {(result?.version || result?.sdkVersion) && <p className="text-caption text-muted-foreground">{result.version ? `CLI ${result.version}` : "CLI 版本待核对"}{result.sdkVersion ? ` · SDK ${result.sdkVersion}` : ""}</p>}
        {result?.nextAction && <p className="text-caption">{result.nextAction}</p>}
        {result?.protocolVerified && result.authentication !== "ready" && <p className="text-caption text-muted-foreground">原生握手已完成；这不代表模型认证或开发任务已验收。</p>}
        {result?.state === "ready" && <p className="text-caption text-success">连接就绪；具体任务仍遵守原生权限确认。</p>}
        {result?.errorCode && <details className="text-micro text-muted-foreground"><summary className="cursor-pointer">诊断信息</summary><code>{result.errorCode}</code></details>}
        <div className="flex gap-2"><Button variant="outline" size="sm" disabled={!projectId || !settings || !!busy || dirty} onClick={() => void execute(`probe:${executor}`, async (current) => {
          const data = await developmentApi.probe(projectId!, executor); if (current()) setResults((old) => ({ ...old, [executor]: data }));
        })}><RefreshCw className={`mr-1 h-3.5 w-3.5 ${busy === `probe:${executor}` ? "animate-spin" : ""}`} />{busy === `probe:${executor}` ? "正在检查…" : "检查连接"}</Button>
        </div>
        {open && projectId && executor !== "claude" && <DevelopmentLogin key={`${projectId}:${executor}`} projectId={projectId} executor={executor}
          disabled={!settings || !!busy || dirty} configRevision={settings?.revision} onChanged={() => {
            setResults((old) => { const next = { ...old }; delete next[executor]; return next; }); onChanged();
          }} />}
      </section>;
    })}
    {dirty && <p className="text-caption text-muted-foreground">先保存修改，再使用新的程序路径和认证来源检查连接。</p>}
    {!projectId && <p className="text-caption text-muted-foreground">打开项目后可以检查连接和认证；保存路径不会自动启动任务。</p>}
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>关闭</Button><Button disabled={!!busy || !settings} onClick={() => void save()}>保存设置</Button></div>
  </DialogContent></Dialog>;
}
