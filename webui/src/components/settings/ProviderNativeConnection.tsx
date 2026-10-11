import { useRef, useState } from "react";
import { Check, ChevronDown, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DevelopmentLogin } from "@/components/development/DevelopmentLogin";
import { developmentApi, isCodeBuddyConnected, type DevExecutor, type DevModel, type NativeLoginStatus } from "@/lib/development-api";
import { modelKey, useModelPreferences } from "@/components/models/model-sources";
import { ProviderMark } from "@/components/models/ProviderMark";
import { modelPresentation } from "./model-presentation";

export function ProviderNativeConnection({ executor, onChanged, onLoginStateChanged, loginActionLabel, dialogLayout = false, search = "", managementView = "brand", showModels = true, showControls = true }: {
  executor: DevExecutor; onChanged: () => void; search?: string; managementView?: "brand" | "model"; showModels?: boolean; showControls?: boolean;
  onLoginStateChanged?: (state: NativeLoginStatus["state"]) => void; loginActionLabel?: string; dialogLayout?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const pending = useRef(false);
  const { hiddenNative, setNativeVisible } = useModelPreferences();
  const refresh = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await developmentApi.probe(undefined, executor.id); onChanged(); }
    catch { setError("暂时无法检查连接，请稍后重试。"); }
    finally { pending.current = false; setBusy(false); }
  };
  const detected = executor.programAvailable ?? !!executor.executable;
  const models = executor.models.filter((model) => model.id || executor.id === "codebuddy")
    .map((model) => !model.id ? { ...model, label: "默认模型" } : model)
    .filter((model) => `${model.label} ${model.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const compareNames = (a: DevModel, b: DevModel) => modelPresentation({ id: a.id, name: a.label }, { id: executor.id, label: executor.name }).name
    .localeCompare(modelPresentation({ id: b.id, name: b.label }, { id: executor.id, label: executor.name }).name, undefined, { numeric: true });
  const modelHidden = (model: DevModel) => hiddenNative.includes(modelKey({ provider: `native:${executor.id}`, model: model.id, executor: executor.id }));
  const shownModels = models.filter((model) => !modelHidden(model));
  if (managementView === "model") shownModels.sort(compareNames);
  const hiddenModels = models.filter(modelHidden).sort(compareNames);
  const namedModelCount = shownModels.filter((model) => model.id).length;
  const keys = models.map((model) => modelKey({ provider: `native:${executor.id}`, model: model.id, executor: executor.id }));
  const allVisible = keys.every((key) => !hiddenNative.includes(key));
  const connected = executor.id === "codebuddy" ? isCodeBuddyConnected(executor)
    : executor.id === "codex" ? executor.probe?.authMode === "chatgpt" : executor.probe?.authentication === "ready";
  const accountConfirmed = executor.probe?.authentication === "ready";
  const canRefresh = (executor.id === "codebuddy" && detected) || !detected;
  const programAvailable = executor.programAvailable ?? executor.available;
  const statusLabel = connected ? "已连接" : !detected ? `需安装 ${executor.name}`
    : executor.id === "codebuddy" && accountConfirmed ? "暂时无法获取模型" : "未连接";
  const disconnect = async () => {
    if ((executor.id !== "codex" && executor.id !== "claude") || busy || !connected || !window.confirm(`断开 ${executor.name} 连接？`)) return;
    setBusy(true); setError("");
    try { await developmentApi.logout(executor.id); onChanged(); }
    catch { setError("暂时无法断开连接，请稍后重试。"); }
    finally { setBusy(false); }
  };
  const renderModel = (model: DevModel) => {
        const key = modelKey({ provider: `native:${executor.id}`, model: model.id, executor: executor.id });
        const visible = !hiddenNative.includes(key);
        const contextWindow = model.contextWindow ? `${model.contextWindow >= 1_000_000 ? model.contextWindow / 1_000_000 : Math.round(model.contextWindow / 1000)}${model.contextWindow >= 1_000_000 ? "M" : "K"}` : undefined;
        const modelTitle = [model.description, contextWindow ? `上下文窗口：${contextWindow}` : undefined,
          !model.id ? executor.probe?.defaultModel ? `当前默认：${executor.probe.defaultModel}` : "使用 CodeBuddy 默认模型" : undefined]
          .filter(Boolean).join("\n");
        const markProvider = executor.id === "codex" ? "openai" : executor.id === "claude" ? "anthropic" : `native:${executor.id}`;
        const presentation = modelPresentation({ id: model.id, name: model.label }, { id: markProvider, label: executor.name });
        return <div key={model.id} title={modelTitle || undefined} className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/60">
          <div className={`flex min-w-0 flex-1 items-center gap-2.5${connected ? "" : " opacity-50"}`}>
            {presentation.icon ? <img src={presentation.icon} alt="" className="h-4 w-4 shrink-0 object-contain opacity-60 dark:invert" /> : <ProviderMark provider={markProvider} label={executor.name} className="h-4 w-4" />}
            <span className="truncate text-ui">{presentation.name}</span>
          </div>
          <Switch checked={connected && visible} disabled={!connected} onCheckedChange={(checked) => setNativeVisible([key], checked)} aria-label={`${executor.name} ${model.label} 在选择器中显示`} /></div>;

  };
  return <div className="space-y-3 text-caption" aria-label={`${executor.name} 连接`}>
    {showControls && dialogLayout ? <div className="space-y-2">
      {!connected && !detected ? <p className="text-muted-foreground">需安装 {executor.name}</p> : null}
      {connected ? <span className="flex items-center gap-1.5 text-success"><Check className="h-3.5 w-3.5" />已连接</span>
        : executor.id === "codebuddy" && accountConfirmed ? <span role="status" className="text-muted-foreground">{statusLabel}</span> : null}
      {!connected && !(executor.id === "codebuddy" && accountConfirmed)
        ? <DevelopmentLogin executor={executor.id} authorizationRequired={executor.probe?.authentication === "required"}
            disabled={busy || !programAvailable} onChanged={() => void refresh()} onStateChanged={onLoginStateChanged}
            compactNotice actionLabel={loginActionLabel ?? (executor.id === "codex" ? "连接 ChatGPT" : executor.id === "claude" ? "使用本机 Claude Code 账号" : "连接 CodeBuddy")} />
        : null}
      {error && <p role="alert" className="max-w-md rounded-lg bg-destructive/5 px-2.5 py-2 text-micro leading-relaxed text-destructive">{error}</p>}
    </div> : showControls && <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {connected ? <span className="flex items-center gap-1.5 text-success"><Check className="h-3.5 w-3.5" />已连接</span>
          : executor.id === "codebuddy" && executor.probe && detected
            ? <span role="status" className="break-words text-muted-foreground">{statusLabel}</span>
            : <span className="text-muted-foreground">{statusLabel}</span>}
        {!connected && !(executor.id === "codebuddy" && accountConfirmed)
          ? <DevelopmentLogin executor={executor.id} authorizationRequired={executor.probe?.authentication === "required"} disabled={busy || !programAvailable} onChanged={() => void refresh()} onStateChanged={onLoginStateChanged} actionLabel={loginActionLabel ?? (executor.id === "codex" ? "连接 ChatGPT" : executor.id === "claude" ? "使用本机 Claude Code 账号" : "连接 CodeBuddy")} />
          : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {connected && (executor.id === "codex" || executor.id === "claude") && <Button variant="outline" size="sm" disabled={busy} onClick={() => void disconnect()}>断开连接</Button>}
        {canRefresh && <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8" aria-label="更多连接操作"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canRefresh && <DropdownMenuItem disabled={busy} onSelect={() => void refresh()}>{executor.id === "codebuddy" && detected ? "刷新连接与模型" : "重新检测"}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>
      {error && <p role="alert" className="basis-full text-destructive">{error}</p>}
    </div>}
    {showModels && !models.length && executor.id === "codebuddy" && <p className="text-muted-foreground">{search.trim() ? "没有匹配的模型" : "暂未获取模型信息"}</p>}
    {showModels && shownModels.length > 0 && <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 px-2">
        <button type="button" className="flex items-center gap-2 py-2 text-caption text-muted-foreground" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "" : "-rotate-90"}`} />{managementView === "model" ? "对话" : executor.id === "codex" ? "OPENAI" : executor.id === "claude" ? "ANTHROPIC" : executor.name}{namedModelCount ? ` ${namedModelCount}` : ""}</button>
        {showControls && <Button variant="ghost" size="sm" disabled={!connected} aria-label={`${executor.name} ${allVisible ? "全部隐藏" : "全部显示"}`} onClick={() => setNativeVisible(keys, !allVisible)}>{allVisible ? "全部隐藏" : "全部显示"}</Button>}
      </div>
      {expanded && shownModels.map(renderModel)}
    </div>}
    {showModels && hiddenModels.length > 0 && <div className="mt-4 space-y-1">
      <button type="button" className="flex h-8 w-full items-center gap-2 px-2 text-left text-caption text-muted-foreground" aria-expanded={hiddenExpanded || !!search.trim()} onClick={() => setHiddenExpanded((value) => !value)}>
        <ChevronDown className={`h-4 w-4 ${hiddenExpanded || search.trim() ? "" : "-rotate-90"}`} />未显示 {hiddenModels.length}
      </button>
      {(hiddenExpanded || !!search.trim()) && hiddenModels.map(renderModel)}
    </div>}
  </div>;
}
