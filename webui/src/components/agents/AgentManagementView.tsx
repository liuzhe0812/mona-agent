import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  FileClock,
  ImagePlus,
  MessageSquarePlus,
  Play,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";

import { AgentAvatar } from "@/components/room/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  getAgentDetail,
  listAgentChangeProposals,
  listAgentInstructionHistory,
  listAgentInstructions,
  listAgentSkills,
} from "@/lib/api";
import type {
  AgentChangeProposal,
  AgentDetailPayload,
  AgentInstruction,
  AgentInstructionHistoryItem,
  AgentSkill,
} from "@/lib/types";
import { useClientContextOrNull } from "@/providers/ClientProvider";

type Tab = "overview" | "identity" | "runtime" | "permissions" | "skills";
type SkillAction = "enable" | "disable" | "archive" | "restore" | "enable_scripts" | "disable_scripts";
const MAX_AVATAR_FILE_BYTES = 2 * 1024 * 1024;

const INSTRUCTION_LABELS: Record<AgentInstruction["key"], string> = {
  soul: "SOUL.md · 个性",
  agents: "AGENTS.md · 规则",
  user: "USER.md · 用户偏好",
  memory: "MEMORY.md · 长期记忆",
};

function commaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ConfigFields({
  detail,
  onSave,
}: {
  detail: AgentDetailPayload;
  onSave: (update: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(detail.config.displayName ?? detail.agent.displayName);
  const [avatar, setAvatar] = useState(detail.config.avatar ?? "");
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(detail.config.enabled);
  const [saving, setSaving] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const chooseAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
      setAvatarError("请选择 PNG、JPEG、WebP 或 GIF 图片");
      return;
    }
    if (file.size > MAX_AVATAR_FILE_BYTES) {
      setAvatarError("头像图片不能超过 2 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setAvatarError("读取头像失败");
        return;
      }
      setAvatar(reader.result);
      setAvatarError(null);
    };
    reader.onerror = () => setAvatarError("读取头像失败");
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ display_name: name || null, avatar: avatar || null, enabled });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid max-w-2xl gap-4">
      <label className="grid gap-1.5 text-ui">
        <span className="text-caption text-muted-foreground">显示名称</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
      </label>
      <div className="grid gap-2 text-ui">
        <span className="text-caption text-muted-foreground">头像</span>
        <div className="flex items-center gap-4 rounded-xl border border-dashed border-border/70 bg-muted/20 p-4 transition-colors hover:border-theme/50 hover:bg-muted/35">
          <AgentAvatar
            agentId={detail.agent.id}
            displayName={detail.agent.displayName}
            avatarUrl={avatar || detail.agent.avatarUrl}
            className="h-16 w-16 shrink-0 ring-2 ring-background ring-offset-2 ring-offset-muted/20"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => avatarInputRef.current?.click()}>
                <ImagePlus className="h-4 w-4" />
                {avatar ? "更换头像" : "选择本地图片"}
              </Button>
              {avatar ? (
                <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => { setAvatar(""); setAvatarError(null); }}>
                  <Trash2 className="h-3.5 w-3.5" />移除
                </Button>
              ) : null}
            </div>
            <p className="mt-2 text-caption text-muted-foreground">从本机选择 PNG、JPEG、WebP 或 GIF，最大 2 MB。</p>
          </div>
        </div>
        <input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={chooseAvatar} className="sr-only" />
        {avatarError ? <p className="text-caption text-destructive">{avatarError}</p> : null}
      </div>
      <label className="flex items-center gap-2 text-ui">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        启用此 Agent（停用后保留会话、记忆和 Skills）
      </label>
      <div><Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存基本设置"}</Button></div>
    </div>
  );
}

function RuntimeFields({
  detail,
  onSave,
}: {
  detail: AgentDetailPayload;
  onSave: (update: Record<string, unknown>) => Promise<void>;
}) {
  const [preset, setPreset] = useState(detail.config.modelPreset ?? "");
  const [temperature, setTemperature] = useState(detail.config.temperature?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(detail.config.maxTokens?.toString() ?? "");
  const [reasoning, setReasoning] = useState(detail.config.reasoningEffort ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        model_preset: preset.trim() || null,
        temperature: temperature.trim() ? Number(temperature) : null,
        max_tokens: maxTokens.trim() ? Number(maxTokens) : null,
        reasoning_effort: reasoning.trim() || null,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid max-w-2xl gap-4">
      <p className="text-caption leading-5 text-muted-foreground">模型预设来自全局模型设置；留空则继承 Agent 包和全局默认值。</p>
      <label className="grid gap-1.5 text-ui"><span className="text-caption text-muted-foreground">模型预设名称</span><Input value={preset} onChange={(event) => setPreset(event.target.value)} placeholder="例如 default / fast" /></label>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="grid gap-1.5 text-ui"><span className="text-caption text-muted-foreground">温度</span><Input type="number" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(event.target.value)} /></label>
        <label className="grid gap-1.5 text-ui"><span className="text-caption text-muted-foreground">最大输出 Token</span><Input type="number" min="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} /></label>
        <label className="grid gap-1.5 text-ui"><span className="text-caption text-muted-foreground">推理强度</span><Input value={reasoning} onChange={(event) => setReasoning(event.target.value)} placeholder="可选" /></label>
      </div>
      <div><Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存运行设置"}</Button></div>
    </div>
  );
}

function PermissionFields({
  detail,
  onSave,
}: {
  detail: AgentDetailPayload;
  onSave: (update: Record<string, unknown>) => Promise<void>;
}) {
  const [inheritTools, setInheritTools] = useState(detail.config.grantedTools === null);
  const [tools, setTools] = useState((detail.config.grantedTools ?? detail.effective.allowedTools ?? []).join(", "));
  const [delegation, setDelegation] = useState(detail.config.delegationEnabled);
  const [saving, setSaving] = useState(false);
  const allowed = detail.definition.toolAllowlist;
  const actualTools = detail.effective.allowedTools ?? null;
  const save = async () => {
    setSaving(true);
    try {
      await onSave({ granted_tools: inheritTools ? null : commaList(tools), delegation_enabled: delegation });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="grid max-w-2xl gap-4">
      <div className="rounded-lg border border-border/65 bg-muted/25 p-3 text-caption leading-5 text-muted-foreground">
        Agent 的实际工具始终受平台安全规则和 Agent 包上限约束。这里只能进一步收窄，不能新增包未声明的工具。
      </div>
      <label className="flex items-center gap-2 text-ui">
        <input type="checkbox" checked={inheritTools} onChange={(event) => setInheritTools(event.target.checked)} />
        继承 Agent 包与平台允许的工具
      </label>
      <label className="grid gap-1.5 text-ui">
        <span className="text-caption text-muted-foreground">允许工具（逗号分隔；取消继承后，留空即不允许任何工具）</span>
        <Textarea value={tools} disabled={inheritTools} onChange={(event) => setTools(event.target.value)} rows={3} placeholder={allowed.join(", ")} />
      </label>
      <p className="text-caption text-muted-foreground">实际范围：{actualTools === null ? "继承平台当前可用工具" : actualTools.length ? actualTools.join(", ") : "无工具"}</p>
      <p className="text-caption text-muted-foreground">包声明上限：{allowed.length ? allowed.join(", ") : detail.agent.id === "mona" ? "平台内置工具" : "无"}</p>
      <label className="flex items-center gap-2 text-ui">
        <input type="checkbox" checked={delegation} disabled={!detail.definition.canDelegate} onChange={(event) => setDelegation(event.target.checked)} />
        允许委派子任务 {detail.definition.canDelegate ? "" : "（此 Agent 包未允许）"}
      </label>
      <div><Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存能力设置"}</Button></div>
    </div>
  );
}

function ProposalCards({
  proposals,
  onResolve,
}: {
  proposals: AgentChangeProposal[];
  onResolve: (proposal: AgentChangeProposal, approve: boolean) => void;
}) {
  if (proposals.length === 0) return null;
  return (
    <section className="mt-6 grid gap-3">
      <h3 className="text-ui font-medium">待确认的 Agent 变更</h3>
      {proposals.map((proposal) => {
        const preview = proposal.preview;
        const title = proposal.kind === "skill_install"
          ? `安装 Skill：${String(preview.skillName ?? "")}`
          : `修改 ${String(preview.filename ?? "指令文件")}`;
        return (
          <article key={proposal.id} className="rounded-lg border border-amber-500/35 bg-amber-500/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-ui">{title}</strong><span className="text-caption text-muted-foreground">{new Date(proposal.expiresAt).toLocaleString()}</span></div>
            {proposal.kind === "instruction_patch" ? (
              <div className="mt-3 grid gap-2"><details><summary className="cursor-pointer text-caption text-muted-foreground">现有内容</summary><pre className="mt-1 max-h-36 overflow-auto rounded-md bg-background/55 p-2 text-caption whitespace-pre-wrap">{String(preview.before ?? "")}</pre></details><div><p className="mb-1 text-caption text-muted-foreground">拟写入内容</p><pre className="max-h-44 overflow-auto rounded-md bg-background/75 p-2 text-caption whitespace-pre-wrap">{String(preview.after ?? "")}</pre></div></div>
            ) : (
              <div className="mt-2 grid gap-2 text-caption text-muted-foreground"><p>{Array.isArray(preview.files) ? `${preview.files.length} 个文件` : ""}{preview.hasScripts ? " · 包含脚本，脚本仍会保持禁用" : ""}</p>{Array.isArray(preview.files) ? preview.files.map((file, index) => { const row = file as Record<string, unknown>; return <details key={`${String(row.path ?? "file")}:${index}`}><summary className="cursor-pointer">{String(row.path ?? "文件")}</summary><pre className="mt-1 max-h-44 overflow-auto rounded-md bg-background/75 p-2 text-caption whitespace-pre-wrap text-foreground">{String(row.content ?? "")}</pre></details>; }) : null}</div>
            )}
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => onResolve(proposal, true)}>批准</Button>
              <Button size="sm" variant="outline" onClick={() => onResolve(proposal, false)}>拒绝</Button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

export function AgentManagementView({
  agentId,
  onBack,
  onStartDirect,
}: {
  agentId: string;
  onBack: () => void;
  onStartDirect: () => void;
}) {
  const context = useClientContextOrNull();
  const [tab, setTab] = useState<Tab>("overview");
  const [detail, setDetail] = useState<AgentDetailPayload | null>(null);
  const [instructions, setInstructions] = useState<AgentInstruction[]>([]);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [proposals, setProposals] = useState<AgentChangeProposal[]>([]);
  const [selectedInstruction, setSelectedInstruction] = useState<AgentInstruction["key"]>("soul");
  const [draftInstruction, setDraftInstruction] = useState("");
  const [history, setHistory] = useState<AgentInstructionHistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [skillName, setSkillName] = useState("");
  const [skillContent, setSkillContent] = useState("---\nname: example-skill\ndescription: Explain what this skill does.\n---\n\n# Instructions\n");

  const token = context?.token ?? "";
  const client = context?.client ?? null;
  const selected = useMemo(
    () => instructions.find((instruction) => instruction.key === selectedInstruction) ?? null,
    [instructions, selectedInstruction],
  );

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [nextDetail, nextInstructions, nextSkills, nextProposals] = await Promise.all([
        getAgentDetail(token, agentId),
        listAgentInstructions(token, agentId),
        listAgentSkills(token, agentId),
        listAgentChangeProposals(token, agentId),
      ]);
      setDetail(nextDetail);
      setInstructions(nextInstructions);
      setSkills(nextSkills);
      setProposals(nextProposals);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加载 Agent 管理信息");
    } finally {
      setLoading(false);
    }
  }, [agentId, token]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    setTab("overview");
    setSelectedInstruction("soul");
  }, [agentId]);
  useEffect(() => {
    setDraftInstruction(selected?.content ?? "");
    if (!token) return;
    void listAgentInstructionHistory(token, agentId, selectedInstruction).then(setHistory).catch(() => setHistory([]));
  }, [agentId, selected, selectedInstruction, token]);
  useEffect(() => {
    if (!client) return;
    return client.onAgentsUpdated((changedAgentId) => {
      if (changedAgentId === agentId) void reload();
    });
  }, [agentId, client, reload]);

  const saveConfig = async (update: Record<string, unknown>) => {
    if (!client || !detail) return;
    try {
      await client.updateAgentConfig(agentId, update, detail.config.revision);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存设置失败");
      throw cause;
    }
  };
  const saveInstruction = async () => {
    if (!client) return;
    try {
      await client.saveAgentInstruction(agentId, selectedInstruction, draftInstruction);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存指令失败"); }
  };
  const restoreInstruction = async (commit: string) => {
    if (!client) return;
    try { await client.restoreAgentInstruction(agentId, selectedInstruction, commit); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "恢复版本失败"); }
  };
  const actOnSkill = async (name: string, action: SkillAction) => {
    if (!client) return;
    try { await client.actOnAgentSkill(agentId, name, action); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "更新 Skill 失败"); }
  };
  const stageSkill = async () => {
    if (!client || !skillName.trim()) return;
    const name = skillName.trim();
    const content = skillContent.replace(/^name:\s*example-skill\s*$/m, `name: ${name}`);
    try { await client.stageAgentSkill(agentId, name, content); setSkillName(""); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "暂存 Skill 失败"); }
  };
  const resolveProposal = async (proposal: AgentChangeProposal, approve: boolean) => {
    if (!client || !proposal.token) { setError("该变更缺少确认令牌，请刷新后重试"); return; }
    try { await client.resolveAgentChange(agentId, proposal.id, proposal.token, approve); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : "处理变更失败"); }
  };

  if (loading && !detail) return <div className="flex h-full items-center justify-center text-muted-foreground">正在加载 Agent 管理…</div>;
  if (!detail) return <div className="flex h-full items-center justify-center text-destructive">{error ?? "Agent 不存在"}</div>;

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/50 px-5 py-3">
        <Button variant="ghost" size="icon" aria-label="返回会话" onClick={onBack}><ChevronLeft className="h-4 w-4" /></Button>
        <AgentAvatar agentId={detail.agent.id} displayName={detail.agent.displayName} avatarUrl={detail.agent.avatarUrl} className="h-9 w-9" />
        <div className="min-w-0 flex-1"><h1 className="truncate text-title-sm">{detail.agent.displayName}</h1></div>
        <Button size="sm" className="gap-1.5" onClick={onStartDirect} disabled={!detail.agent.enabled}><MessageSquarePlus className="h-4 w-4" />新建对话</Button>
      </header>
      {error ? <div className="mx-5 mt-3 flex items-center justify-between rounded-md border border-destructive/35 bg-destructive/5 px-3 py-2 text-caption text-destructive"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="关闭"><X className="h-3.5 w-3.5" /></button></div> : null}
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 overflow-x-auto border-b border-border/45 px-5 py-2"><TabsList className="h-8"><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="identity">个性与规则</TabsTrigger><TabsTrigger value="runtime">模型与运行</TabsTrigger><TabsTrigger value="permissions">能力与权限</TabsTrigger><TabsTrigger value="skills">Skills 与数据</TabsTrigger></TabsList></div>
        <TabsContent value="overview" className="m-0 min-h-0 flex-1 overflow-auto p-6">
          <div className="mx-auto max-w-3xl"><ConfigFields key={`${agentId}:${detail.config.revision}`} detail={detail} onSave={saveConfig} /><section className="mt-8 rounded-lg border border-border/65 p-4"><h2 className="text-ui font-medium">来源</h2><dl className="mt-3 grid gap-2 text-caption sm:grid-cols-2"><div><dt className="text-muted-foreground">包</dt><dd>{detail.definition.packageId || "Mona 平台"}</dd></div><div><dt className="text-muted-foreground">版本</dt><dd>{detail.definition.packageVersion || "—"}</dd></div></dl></section><section className="mt-4 rounded-lg border border-border/65 p-4"><h2 className="text-ui font-medium">私有数据</h2><p className="mt-1 text-caption text-muted-foreground">停用不会删除这些数据；记忆可在“个性与规则”中查看、编辑和恢复历史。</p><dl className="mt-3 grid gap-2 text-caption sm:grid-cols-2"><div><dt className="text-muted-foreground">记忆</dt><dd>{detail.data.memoryFiles} 个文件 · {formatBytes(detail.data.memoryBytes)}</dd></div><div><dt className="text-muted-foreground">Skills</dt><dd>{detail.data.skillFiles} 个文件 · {formatBytes(detail.data.skillBytes)}</dd></div></dl></section></div>
        </TabsContent>
        <TabsContent value="identity" className="m-0 min-h-0 flex-1 overflow-auto p-6">
          <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[12rem_minmax(0,1fr)]"><aside className="flex flex-col gap-1">{(Object.keys(INSTRUCTION_LABELS) as AgentInstruction["key"][]).map((key) => <button key={key} type="button" onClick={() => setSelectedInstruction(key)} className={`rounded-md px-3 py-2 text-left text-ui ${selectedInstruction === key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted/60"}`}>{INSTRUCTION_LABELS[key]}</button>)}</aside><div><div className="mb-3 flex items-center justify-between"><div><h2 className="text-ui font-medium">{INSTRUCTION_LABELS[selectedInstruction]}</h2><p className="text-caption text-muted-foreground">手动保存会记录版本；AI 修改会先生成待确认变更。</p></div><Button size="sm" className="gap-1.5" onClick={() => void saveInstruction()}><Save className="h-3.5 w-3.5" />保存</Button></div><Textarea value={draftInstruction} onChange={(event) => setDraftInstruction(event.target.value)} className="min-h-[22rem] font-mono text-caption" /><section className="mt-5"><h3 className="mb-2 flex items-center gap-1.5 text-ui font-medium"><FileClock className="h-4 w-4" />版本历史</h3><div className="grid gap-1">{history.length ? history.map((item) => <div key={item.sha} className="flex items-center gap-2 rounded-md border border-border/55 px-3 py-2 text-caption"><span className="min-w-0 flex-1 truncate">{item.message}</span><span className="shrink-0 text-muted-foreground">{item.timestamp}</span><Button size="sm" variant="ghost" onClick={() => void restoreInstruction(item.sha)}>恢复</Button></div>) : <p className="text-caption text-muted-foreground">保存后将显示版本历史。</p>}</div></section><ProposalCards proposals={proposals.filter((proposal) => proposal.kind === "instruction_patch")} onResolve={resolveProposal} /></div></div>
        </TabsContent>
        <TabsContent value="runtime" className="m-0 min-h-0 flex-1 overflow-auto p-6"><div className="mx-auto max-w-3xl"><RuntimeFields key={`${agentId}:${detail.config.revision}`} detail={detail} onSave={saveConfig} /></div></TabsContent>
        <TabsContent value="permissions" className="m-0 min-h-0 flex-1 overflow-auto p-6"><div className="mx-auto max-w-3xl"><PermissionFields key={`${agentId}:${detail.config.revision}`} detail={detail} onSave={saveConfig} /></div></TabsContent>
        <TabsContent value="skills" className="m-0 min-h-0 flex-1 overflow-auto p-6"><div className="mx-auto grid max-w-4xl gap-6"><section className="rounded-lg border border-border/65 p-4"><h2 className="text-ui font-medium">添加专属 Skill</h2><p className="mt-1 text-caption text-muted-foreground">Skill 先暂存并显示确认卡片，批准前不会被 Agent 加载。</p><div className="mt-4 grid gap-3"><Input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="skill 名称，例如 valuation-check" /><Textarea value={skillContent} onChange={(event) => setSkillContent(event.target.value)} rows={10} className="font-mono text-caption" /><div><Button onClick={() => void stageSkill()} disabled={!skillName.trim()}>暂存并请求确认</Button></div></div></section><section><h2 className="mb-3 text-ui font-medium">已安装 Skills</h2><div className="grid gap-2">{skills.map((skill) => <article key={`${skill.source}:${skill.name}:${skill.archived}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 p-3"><div className="min-w-0 flex-1"><p className="truncate text-ui font-medium">{skill.name}</p><p className="text-caption text-muted-foreground">{skill.source}{skill.archived ? " · 已归档" : skill.enabled ? " · 已启用" : " · 已停用"}{skill.hasScripts ? skill.scriptsEnabled ? " · 脚本已允许" : " · 脚本未允许" : ""}</p></div>{skill.source === "private" && !skill.archived ? <Button size="sm" variant="ghost" onClick={() => void actOnSkill(skill.name, "archive")}><Archive className="h-3.5 w-3.5" /></Button> : null}{skill.source === "private" && skill.archived ? <Button size="sm" variant="ghost" onClick={() => void actOnSkill(skill.name, "restore")}><ArchiveRestore className="h-3.5 w-3.5" /></Button> : null}{!skill.archived ? <Button size="sm" variant="outline" onClick={() => void actOnSkill(skill.name, skill.enabled ? "disable" : "enable")}>{skill.enabled ? "停用" : "启用"}</Button> : null}{skill.source === "private" && skill.hasScripts && !skill.archived ? <Button size="sm" variant="outline" className="gap-1" onClick={() => void actOnSkill(skill.name, skill.scriptsEnabled ? "disable_scripts" : "enable_scripts")}><Play className="h-3.5 w-3.5" />{skill.scriptsEnabled ? "禁止脚本" : "允许脚本"}</Button> : null}</article>)}</div></section><ProposalCards proposals={proposals.filter((proposal) => proposal.kind === "skill_install")} onResolve={resolveProposal} /><section className="rounded-lg border border-border/60 bg-muted/20 p-4 text-caption leading-5 text-muted-foreground"><ShieldCheck className="mb-2 h-4 w-4 text-theme" />安装 Skill 不会自动增加工具、连接或密钥权限。包含脚本的私有 Skill 即使安装成功，脚本仍需要在这里单独允许。</section></div></TabsContent>
      </Tabs>
    </section>
  );
}
