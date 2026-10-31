import { useEffect, useState } from "react";
import { FileCode2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { developmentApi, type DevExecutor, type DevProject, type DevSession, type ProjectResources } from "@/lib/development-api";
import { DevelopmentCollaboration } from "./DevelopmentCollaboration";
import { DevelopmentGitTools } from "./DevelopmentGitTools";
import { DevelopmentPlan } from "./DevelopmentPlan";
import { useDevelopmentStore, type WorkTab } from "./store";

export function DevelopmentOverview({ project, session, onOpenTool }: {
  project: DevProject; session: DevSession; executors: DevExecutor[]; onOpenTool: (tab: WorkTab) => void;
}) {
  const [resources, setResources] = useState<ProjectResources | null>(null);
  const plan = useDevelopmentStore((s) => s.snapshots[session.id]?.plan);
  const latestRunId = useDevelopmentStore((s) => s.snapshots[session.id]?.runs[0]?.id);
  useEffect(() => {
    let alive = true;
    void developmentApi.resources(project.id).then((value) => { if (alive) setResources(value); })
      .catch((cause) => {
        if (alive) console.warn("[DevelopmentOverview] project resources unavailable",
          cause instanceof Error ? cause.name : "UnknownError");
      });
    return () => { alive = false; };
  }, [project.id]);
  return <TooltipProvider delayDuration={250}><div className="space-y-4 p-5 text-ui">
    <section className="space-y-3">
      <Tooltip><TooltipTrigger asChild><h3 className="truncate pr-6 text-caption text-muted-foreground">{project.displayName}</h3></TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-sm break-all">{project.rootPath}</TooltipContent>
      </Tooltip>
      <DevelopmentGitTools project={project} session={session} visible embedded onOpenReview={() => onOpenTool("review")} />
    </section>
    {plan?.plan.length ? <div className="border-t border-border/50 pt-4"><DevelopmentPlan value={plan} currentRunId={latestRunId} /></div> : null}
    <div className="border-t border-border/50 pt-4"><DevelopmentCollaboration session={session} visible onConfigure={() => onOpenTool("subagents")} onOpenTasks={() => {
      useDevelopmentStore.getState().setSide(session.id, { agentSessionId: undefined });
      onOpenTool("agent");
    }} /></div>
    <details className="border-t border-border/50 pt-4 text-caption">
      <summary className="cursor-pointer text-muted-foreground">项目规则与 Skills</summary>
      <div className="mt-3 space-y-2">
        <p className="break-all text-micro text-muted-foreground">{project.rootPath}</p>
        {resources?.rules.map((rule) => <Button key={rule.path} variant="ghost" size="sm" className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => onOpenTool("workspace")}><FileCode2 className="mr-2 h-3.5 w-3.5 shrink-0" />{rule.path}</Button>)}
        {resources?.skills.map((skill) => <Tooltip key={skill.path}><TooltipTrigger asChild><Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => useDevelopmentStore.getState().appendDraft(session.id, `请按需使用项目 Skill：${skill.name}（${skill.path}）`)}>{skill.name}</Button></TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-sm break-words">{skill.description}</TooltipContent>
        </Tooltip>)}
        {resources && !resources.rules.length && !resources.skills.length && <p className="text-muted-foreground">项目未提供规则或 Skills。</p>}
      </div>
    </details>
  </div></TooltipProvider>;
}
