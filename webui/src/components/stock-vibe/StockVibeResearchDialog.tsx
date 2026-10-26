import { useEffect, useState } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { StockVibeNativeResearchOrigin, StockVibeResearchTask, StockVibeScenarioMode } from "@/lib/stock-vibe-api";
import { STOCK_RESEARCH_TASKS } from "@/lib/stock-vibe-workbench";
import { StockVibeResearch } from "./StockVibeResearch";
import { StockVibeSavedResearch } from "./StockVibeSavedResearch";
import { StockVibeScenarios } from "./StockVibeScenarios";

export interface StockVibeResearchTarget {
  symbol: string | null;
  mode: StockVibeScenarioMode;
  task?: StockVibeResearchTask;
  resume?: { sessionId: string; attemptId?: string };
  saved?: { sessionId: string; attemptId: string };
  artifactId?: string;
  originalScope?: boolean;
  journalOperationId?: string;
  journalFilename?: string;
  question?: string;
  /** 问题由「追问」直接带来时，打开即派发，不再让人在弹窗里重打一遍。 */
  autoSubmit?: boolean;
  nativeResearch?: StockVibeNativeResearchOrigin;
  strategyCreation?: boolean;
  strategyDraftId?: string;
  strategyName?: string;
}

function researchIdentity(target: StockVibeResearchTarget): string {
  if (target.journalOperationId) return `journal:${target.journalOperationId}`;
  if (target.strategyDraftId && !target.resume) return `strategy:${target.strategyDraftId}`;
  if (target.nativeResearch && !target.resume) return `native:${target.nativeResearch.strategy_id ?? target.nativeResearch.swarm_id}:${target.nativeResearch.strategy_version ?? ""}:${target.nativeResearch.task_id ?? ""}:${target.symbol}:${target.task}`;
  return target.resume ? `session:${target.resume.sessionId}` : `${target.symbol}:${target.task}:${target.mode}:${target.question ?? ""}`;
}

export function StockVibeResearchDialog({ target, open, onOpenChange, enabled, modelAvailable, onOpenModel, onChanged, onStrategyRegistered, onOpenStrategy }: {
  target: StockVibeResearchTarget | null; open: boolean; onOpenChange: (open: boolean) => void;
  enabled: boolean; modelAvailable: boolean; onOpenModel: () => void; onChanged: () => void;
  onStrategyRegistered?: (id: string) => void; onOpenStrategy?: (id: string) => void;
}) {
  const [activeResearch, setActiveResearch] = useState<StockVibeResearchTarget | null>(null);
  const [continued, setContinued] = useState<{ source: StockVibeResearchTarget; research: StockVibeResearchTarget } | null>(null);
  const [files, setFiles] = useState<Record<string, File | null>>({});
  useEffect(() => {
    setContinued(null);
    if (target && !target.saved && !target.artifactId) setActiveResearch(target);
  }, [target]);
  const displayed = continued?.source === target ? continued.research : target;
  const readOnly = Boolean(displayed?.saved || displayed?.artifactId);
  const identity = activeResearch ? researchIdentity(activeResearch) : "";
  const researchOpen = open && !readOnly && Boolean(activeResearch && displayed && researchIdentity(activeResearch) === researchIdentity(displayed));
  const continueSaved = (sessionId: string) => {
    if (!displayed || !target) return;
    const next = { symbol: null, mode: displayed.mode, resume: { sessionId } };
    setContinued({ source: target, research: next });
    setActiveResearch(next);
  };
  return <>
    {activeResearch && <StockVibeResearch key={identity} symbol={activeResearch.symbol} mode={activeResearch.mode} enabled
      open={researchOpen} onOpenChange={onOpenChange} canSubmit={enabled && modelAvailable}
      title={activeResearch.strategyCreation ? activeResearch.nativeResearch?.strategy_id ? "用 AI 修改策略" : "用 AI 创建策略" : activeResearch.journalOperationId ? `成交复盘解读${activeResearch.journalFilename ? ` · ${activeResearch.journalFilename}` : ""}` : activeResearch.task ? STOCK_RESEARCH_TASKS[activeResearch.task].label : "研究详情"}
      journalOperationId={activeResearch.journalOperationId}
      nativeResearch={activeResearch.nativeResearch}
      strategyCreation={activeResearch.strategyCreation} strategyDraftId={activeResearch.strategyDraftId}
      strategyName={activeResearch.strategyName}
      onStrategyRegistered={onStrategyRegistered} onOpenStrategy={onOpenStrategy}
      context={activeResearch.symbol && activeResearch.task && !activeResearch.resume
        ? { symbol: activeResearch.symbol, task: activeResearch.task, mode: activeResearch.mode } : undefined}
      resumeSession={activeResearch.resume}
      resumeScope={activeResearch.originalScope && activeResearch.symbol && activeResearch.task
        ? { symbol: activeResearch.symbol, task: activeResearch.task, mode: activeResearch.mode } : undefined}
      initialQuestion={activeResearch.resume ? "" : activeResearch.question ?? (activeResearch.task ? STOCK_RESEARCH_TASKS[activeResearch.task].question : "")}
      autoSend={!activeResearch.resume && activeResearch.autoSubmit === true}
      attachmentFile={files[identity] ?? null} onAttachmentFileChange={(file) => setFiles((current) => ({ ...current, [identity]: file }))}
      onChanged={onChanged} onOpenModel={!modelAvailable ? onOpenModel : undefined} />}
    <Dialog open={open && readOnly} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="scrollbar-scope max-h-[88dvh] max-w-4xl overflow-y-auto">
        <DialogHeader><DialogTitle>{displayed?.artifactId ? "观察记录" : displayed?.task ? STOCK_RESEARCH_TASKS[displayed.task].label : "研究报告"}{displayed?.symbol ? ` · ${displayed.symbol.slice(0, 6)}` : ""}</DialogTitle></DialogHeader>
        {displayed?.saved ? <StockVibeSavedResearch sessionId={displayed.saved.sessionId} attemptId={displayed.saved.attemptId}
          embedded title="本次研究" closeLabel="关闭" onClose={() => onOpenChange(false)} onResume={continueSaved} />
          : displayed?.artifactId && <StockVibeScenarios symbol={displayed.symbol} mode={displayed.mode} focusArtifactId={displayed.artifactId} />}
      </DialogContent>
    </Dialog>
  </>;
}
