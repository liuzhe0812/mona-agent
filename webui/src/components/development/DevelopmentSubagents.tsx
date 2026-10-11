import { useEffect, useRef, useState } from "react";
import { Bot, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ModelSelector } from "@/components/models/ModelSelector";
import { DevelopmentApiError, executorLabels, type DevExecutor, type DevSession } from "@/lib/development-api";
import { developmentModels, developmentModelRoute } from "./development-models";
import { subagentApi, type SubagentPreset, type SubagentSettings } from "./workspace-api";
import { useDevelopmentStore } from "./store";

type Failure = { title: string; message: string; action: "retry" | "reload" | null };
const isBuiltinSubagent = (preset: SubagentPreset) => preset.id === "builtin_explorer" || preset.id === "builtin_worker";

export function DevelopmentSubagents({ projectId, executors, session, onChanged, onManageModels }: {
  projectId: string; executors: DevExecutor[]; session?: Pick<DevSession, "executor" | "model" | "modelProvider">;
  onChanged: () => void; onManageModels?: () => void;
}) {
  const [settings, setSettings] = useState<SubagentSettings | null>(null);
  const draft = useDevelopmentStore((state) => state.subagentDrafts[projectId] ?? null);
  const setDraft = (value: SubagentPreset | null) => useDevelopmentStore.getState().setSubagentDraft(projectId, value);
  const [editorOpen, setEditorOpen] = useState(!!draft);
  const [removing, setRemoving] = useState<SubagentPreset | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const pending = useRef(false);
  const owner = useRef(projectId); owner.current = projectId;

  useEffect(() => {
    setSettings(null);
    setRemoving(null);
    setFailure(null);
    setLoading(true);
    let live = true;
    void subagentApi.list(projectId).then((data) => {
      if (live) setSettings(data);
    }).catch((cause) => {
      if (live) setFailure({ title: "读取子智能体失败", message: cause instanceof Error ? cause.message : "读取配置失败。", action: "retry" });
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, retry]);

  const save = async (presets: SubagentPreset[]) => {
    if (!settings || pending.current) return;
    const target = projectId;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await subagentApi.save(target, { revision: settings.revision, presets });
      if (owner.current !== target) return;
      setSettings(result);
      setDraft(null);
      setEditorOpen(false);
      setRemoving(null);
      onChanged();
    } catch (cause) {
      if (owner.current === target) setFailure({
        title: "保存子智能体失败",
        message: cause instanceof Error ? cause.message : "配置保存失败。",
        action: cause instanceof DevelopmentApiError && cause.code === "conflict" ? "reload" : null,
      });
    } finally {
      pending.current = false;
      if (owner.current === target) setBusy(false);
    }
  };

  const create = () => {
    setDraft({ id: `subagent_${crypto.randomUUID().replaceAll("-", "")}`, name: "", description: "", instructions: "",
      executor: "mona", model: null, provider: null, effort: null, readonly: true, enabled: true });
    setEditorOpen(true);
  };
  const edit = (preset: SubagentPreset) => {
    setDraft({ ...preset, description: preset.description || preset.instructions });
    setEditorOpen(true);
  };

  const options = developmentModels(executors).map((option) => {
    const route = developmentModelRoute(option);
    const active = !draft?.inheritModel && route.executor === draft?.executor && route.model === draft.model && route.provider === draft.provider;
    return { ...option, active, reasoningEffort: active ? draft.effort ?? option.reasoningEffort : option.reasoningEffort };
  });
  const selected = options.find((option) => option.active);
  const builtinDraft = !!draft && isBuiltinSubagent(draft);
  const builtinPreset = builtinDraft ? settings?.presets.find((preset) => preset.id === draft.id) : undefined;
  const description = builtinPreset?.description ?? draft?.description ?? draft?.instructions ?? "";
  const instructions = builtinPreset?.instructions ?? draft?.instructions ?? "";

  return <section className="space-y-3 p-5" aria-label="子智能体配置">
    <div className="flex items-center gap-2">
      <Bot className="h-4 w-4 text-muted-foreground" />
      <h2 className="flex-1 text-ui font-medium">子智能体</h2>
      <Button size="sm" variant="outline" disabled={!settings || busy || settings.presets.filter((preset) => !isBuiltinSubagent(preset)).length >= 32} onClick={create}>
        <Plus className="mr-1 h-3.5 w-3.5" />添加子智能体
      </Button>
    </div>

    <div className="-mx-2 space-y-1">
      {settings?.presets.map((preset) => {
        const route = preset.inheritModel && session
          ? { executor: session.executor, model: session.model, provider: session.modelProvider ?? null } : preset;
        const model = route.model ?? executors.find((executor) => executor.id === route.executor)?.probe?.defaultModel ?? null;
        const option = options.find((option) => {
          const target = developmentModelRoute(option);
          return target.executor === route.executor && target.model === model && target.provider === route.provider;
        });
        const modelName = option?.model ? option.selectionId ? option.model : option.label : model ?? "默认模型";
        return <div key={preset.id} className="group flex h-9 items-center gap-1 rounded-sm px-2 hover:bg-foreground/5">
        <button type="button" className="flex h-full min-w-0 flex-1 items-center gap-3 text-left text-ui font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={preset.name} title="编辑" disabled={busy} onClick={() => edit(preset)}>
          <span className="max-w-[40%] shrink-0 truncate">{preset.name}</span>
          <span className="min-w-0 truncate text-caption font-normal text-muted-foreground" title={modelName}>{modelName}</span>
        </button>
        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`编辑 ${preset.name}`} disabled={busy} onClick={() => edit(preset)}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        {!isBuiltinSubagent(preset) && <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`删除 ${preset.name}`} disabled={busy} onClick={() => setRemoving(preset)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>}
        <Switch size="sm" aria-label={`${preset.name} 启用`} checked={preset.enabled} disabled={busy}
          onCheckedChange={(enabled) => void save(settings.presets.map((item) => item.id === preset.id ? { ...item, enabled } : item))} />
      </div>; })}
    </div>
    {loading && <p role="status" className="text-caption text-muted-foreground">加载中</p>}

    <Dialog open={editorOpen && !!draft} onOpenChange={(open) => {
      if (busy) return;
      setEditorOpen(open);
      if (!open) setDraft(null);
    }}>
      {draft && <DialogContent aria-describedby={undefined} className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{settings?.presets.some((preset) => preset.id === draft.id) ? "编辑子智能体" : "创建子智能体"}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          if (!settings || !draft) return;
          const next = { ...draft, name: builtinPreset?.name ?? draft.name.trim(),
            description: builtinPreset?.description ?? description.trim(), instructions: builtinPreset?.instructions ?? (instructions.trim() || description.trim()) };
          const index = settings.presets.findIndex((preset) => preset.id === next.id);
          const presets = index < 0 ? [...settings.presets, next] : settings.presets.map((preset) => preset.id === next.id ? next : preset);
          void save(presets);
        }}>
          <label className="grid gap-2 text-caption">名称<Input aria-label="子智能体名称" maxLength={80} required disabled={busy || isBuiltinSubagent(draft)} value={draft.name}
            onChange={(event) => setDraft({ ...draft, description, name: event.target.value })} /></label>
          <label className="grid gap-2 text-caption">描述<Textarea aria-label="子智能体描述" maxLength={8000} required disabled={busy} readOnly={builtinDraft} rows={3} value={description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          <label className="grid gap-2 text-caption">执行指令（可选）<Textarea aria-label="子智能体执行指令" maxLength={8000} disabled={busy} readOnly={builtinDraft} rows={4} value={instructions}
            onChange={(event) => setDraft({ ...draft, description, instructions: event.target.value })} /></label>
          <div className="grid gap-2 text-caption"><span>模型</span>
            <label className="flex items-center gap-2"><Checkbox aria-label="跟随主任务模型" checked={draft.inheritModel ?? false} disabled={busy}
              onCheckedChange={(value) => setDraft({ ...draft, description, inheritModel: value === true })} />跟随主任务模型</label>
            <ModelSelector options={options} label={draft.inheritModel ? "跟随主任务模型" : selected?.label ?? draft.model ?? `${executorLabels[draft.executor]} 默认模型`} disabled={busy || draft.inheritModel}
              onSelect={(option, effort) => {
                const route = developmentModelRoute(option, effort);
                setDraft({ ...draft, description, executor: route.executor, model: route.model, provider: route.provider, effort: route.effort });
              }} onManage={onManageModels} />
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="flex items-center gap-2 text-caption"><Checkbox checked={draft.readonly} disabled={busy}
              onCheckedChange={(value) => setDraft({ ...draft, description, readonly: value === true })} />只读</label>
            <label className="flex items-center gap-2 text-caption"><Switch aria-label="编辑器内启用" checked={draft.enabled} disabled={busy}
              onCheckedChange={(enabled) => setDraft({ ...draft, description, enabled })} />启用</label>
          </div>
          <DialogFooter className="border-t border-border/60 pt-4">
            <Button type="button" variant="outline" disabled={busy} onClick={() => { setDraft(null); setEditorOpen(false); }}>取消</Button>
            <Button type="submit" aria-label="保存子智能体" disabled={busy || !draft.name.trim() || !description.trim()}>{busy ? "正在保存…" : "保存"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>}
    </Dialog>

    <Dialog open={!!failure} onOpenChange={(open) => { if (!open && !busy) setFailure(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{failure?.title}</DialogTitle><DialogDescription className="break-words">{failure?.message}</DialogDescription></DialogHeader>
        <DialogFooter>
          {failure?.action && <Button variant="outline" disabled={busy || loading} onClick={() => {
            setFailure(null);
            setRetry((value) => value + 1);
          }}>{failure.action === "reload" ? "重新读取并保留草稿" : "重试"}</Button>}
          <Button onClick={() => setFailure(null)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={!!removing} onOpenChange={(open) => { if (!open && !busy) setRemoving(null); }}>
      <DialogContent><DialogHeader><DialogTitle>删除子智能体配置</DialogTitle>
        <DialogDescription>删除「{removing?.name}」的配置；已创建的子任务和历史记录保留。</DialogDescription>
      </DialogHeader><DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>取消</Button>
        <Button variant="destructive" disabled={busy} onClick={() => settings && removing && void save(settings.presets.filter((preset) => preset.id !== removing.id))}>删除配置</Button>
      </DialogFooter></DialogContent>
    </Dialog>
  </section>;
}
