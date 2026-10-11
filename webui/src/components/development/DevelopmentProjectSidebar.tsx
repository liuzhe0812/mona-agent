import { useEffect, useLayoutEffect, useState } from "react";
import { ArrowLeft, FolderPlus, PanelLeft } from "lucide-react";
import { DevelopmentProjectHeader } from "./DevelopmentProjectHeader";
import { DevelopmentSessionRow } from "./DevelopmentSessionRow";
import { DevelopmentLoading } from "./DevelopmentLoading";
import { Button } from "@/components/ui/button";
import { developmentApi, type DevProject, type DevSession } from "@/lib/development-api";

type Props = {
  projects: DevProject[]; activeSessionId: string | null; visible: boolean; refreshKey: number;
  projectsLoading?: boolean; projectsError?: string;
  creatingProjectId?: string | null;
  onOpenProject: () => void; onSelectSession: (session: DevSession) => void;
  onToggleProjects?: () => void;
  onCreate: (project: DevProject) => void; onRename: (session: DevSession) => void;
  onUpdate: (session: DevSession, changes: Partial<Pick<DevSession, "pinned" | "archived">>) => void;
  onDelete: (session: DevSession) => Promise<void>; onOpenTerminal: (session: DevSession) => void | Promise<void>;
  onSessions: (project: string, sessions: DevSession[]) => void;
  onProjectChanged: (project: DevProject) => void;
  onReload: () => void;
};

function ProjectGroup({ project, hoverOwner, onHoverOpen, ...props }: Omit<Props, "projects" | "onOpenProject" | "onToggleProjects"> & {
  project: DevProject; hoverOwner: string | null; onHoverOpen: (owner: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [inspecting, setInspecting] = useState(false);
  const [sessions, setSessions] = useState<DevSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  const [archived, setArchived] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!props.visible || (!expanded && !inspecting)) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const rows = await developmentApi.sessions(project.id);
        if (!disposed) { setSessions(rows); setLoaded(true); setError(""); props.onSessions(project.id, rows); }
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : "会话列表读取失败"); }
      finally { if (!disposed) timer = setTimeout(poll, 2500); }
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [project.id, expanded, inspecting, props.visible, props.refreshKey, props.onSessions, retry]);
  const activeSession = sessions.find((session) => session.id === props.activeSessionId && !session.parentSessionId);
  // 恢复归档会话时同步列表；按身份和归档状态判断，避免轮询覆盖手动切换的视图。
  useLayoutEffect(() => {
    if (activeSession) setArchived(activeSession.archived);
  }, [activeSession?.id, activeSession?.archived]);
  const filtered = sessions.filter((s) => !s.parentSessionId && s.archived === archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const rows = all ? filtered : filtered.slice(0, 8);
  return <section className="mb-1.5" aria-label={`项目 ${project.displayName}`}>
    <DevelopmentProjectHeader project={project} sessions={loaded && !error ? sessions : null} sessionsError={error} expanded={expanded} visible={props.visible}
      hoverEnabled={hoverOwner === `project:${project.id}`} onHoverOpen={() => onHoverOpen(`project:${project.id}`)}
      creating={!!props.creatingProjectId} onToggle={() => setExpanded(!expanded)} onInspect={setInspecting}
      onCreate={() => { setExpanded(true); setArchived(false); props.onCreate(project); }} onChanged={props.onProjectChanged} onReload={() => { setRetry((n) => n + 1); props.onReload(); }}
      onViewArchived={() => { setArchived(true); setExpanded(true); setAll(false); }} />
    {expanded && <div className="mt-0.5 space-y-px pl-5">
      {archived && <div className="flex flex-wrap items-center justify-between gap-1 px-3 py-1">
        <span className="text-caption font-medium text-muted-foreground">归档任务</span>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-1" onClick={() => { setArchived(false); setAll(false); }}><ArrowLeft className="h-3.5 w-3.5" />返回任务列表</Button>
      </div>}
      {rows.map((session) => <DevelopmentSessionRow key={session.id} project={project} session={session}
        active={props.activeSessionId === session.id} visible={props.visible}
        hoverEnabled={hoverOwner === `task:${session.id}`} onHoverOpen={() => onHoverOpen(`task:${session.id}`)}
        onSelect={() => props.onSelectSession(session)} onRename={() => props.onRename(session)}
        onUpdate={(changes) => props.onUpdate(session, changes)}
        onDelete={() => props.onDelete(session)} onOpenTerminal={() => props.onOpenTerminal(session)} />)}
      {error ? <button type="button" title={error} aria-label="会话列表读取失败，点击重试" aria-description={error} className="block w-full max-w-full truncate whitespace-nowrap px-3 py-2 text-left text-caption text-destructive" onClick={() => setRetry((n) => n + 1)}>会话读取失败 · 重试</button> : !loaded ? <DevelopmentLoading label="正在读取任务…" variant="list" /> : !rows.length ? <p className="px-3 py-2 text-caption text-muted-foreground">{archived ? "暂无归档任务" : "暂无会话"}</p> : null}
      {filtered.length > 8 && <button type="button" className="px-3 py-2 text-caption text-muted-foreground hover:text-foreground" onClick={() => setAll(!all)}>{all ? "收起" : `显示更多 · ${filtered.length - 8}`}</button>}
    </div>}
  </section>;
}

export function DevelopmentProjectSidebar({ projects, projectsLoading = false, projectsError, onOpenProject, onToggleProjects, ...props }: Props) {
  const [hoverOwner, setHoverOwner] = useState<string | null>(null);
  return <aside aria-label="开发项目列表" className="flex h-full min-w-0 flex-col bg-sidebar/30">
    <div className="flex h-12 shrink-0 items-center gap-1 px-3"><span className="flex-1 text-caption font-medium text-muted-foreground">项目</span><Button size="icon" variant="ghost" className="h-7 w-7" aria-label="打开开发项目" onClick={onOpenProject}><FolderPlus className="h-4 w-4" /></Button>
      {onToggleProjects && <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="切换项目列表" title="收起项目列表" onClick={onToggleProjects}><PanelLeft className="h-4 w-4" /></Button>}
    </div>
    <div aria-busy={projectsLoading} className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">{projects.map((project) => <ProjectGroup key={project.id} project={project} hoverOwner={hoverOwner} onHoverOpen={setHoverOwner} {...props} />)}
      {!projects.length && (projectsLoading ? <DevelopmentLoading label="正在读取项目…" variant="list" /> : !projectsError && <p className="px-3 py-4 text-caption text-muted-foreground">添加本地项目后，会话显示在项目下方。</p>)}
    </div>
  </aside>;
}
