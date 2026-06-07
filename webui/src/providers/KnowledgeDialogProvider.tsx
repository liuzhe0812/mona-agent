import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createKnowledgeDraftFromCandidate,
  type ExtractedKnowledgeCandidateDraft,
  type ExtractedKnowledgeDraft,
} from "@/components/notes/notes-ai";

export interface KnowledgeCandidateEntry {
  id: string;
  noteId: string;
  draft: ExtractedKnowledgeCandidateDraft;
  status: "pending" | "saved" | "ignored";
}

type SaveHandler = (candidateId: string, draft: ExtractedKnowledgeDraft) => boolean;

interface KnowledgeDialogContextValue {
  candidates: KnowledgeCandidateEntry[];
  isDialogOpen: boolean;
  openDialog: (candidates: ExtractedKnowledgeCandidateDraft[], noteId: string) => void;
  reopenDialog: () => void;
  saveCandidate: (candidateId: string) => void;
  ignoreCandidate: (candidateId: string) => void;
  clearCandidates: () => void;
  registerSaveHandler: (handler: SaveHandler) => void;
}

const KnowledgeDialogContext = createContext<KnowledgeDialogContextValue | null>(null);

export function useKnowledgeDialog() {
  const value = useContext(KnowledgeDialogContext);
  if (!value) throw new Error("useKnowledgeDialog must be used within KnowledgeDialogProvider");
  return value;
}

export function KnowledgeDialogProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [candidates, setCandidates] = useState<KnowledgeCandidateEntry[]>([]);
  const [open, setOpen] = useState(false);
  const saveHandlerRef = useRef<SaveHandler | null>(null);
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  const registerSaveHandler = useCallback((handler: SaveHandler) => {
    saveHandlerRef.current = handler;
  }, []);

  const openDialog = useCallback(
    (drafts: ExtractedKnowledgeCandidateDraft[], noteId: string) => {
      const entries: KnowledgeCandidateEntry[] = drafts.map((draft, index) => ({
        id: `kc-${index}-${Date.now()}`,
        noteId,
        draft,
        status: "pending" as const,
      }));
      setCandidates(entries);
      setOpen(true);
    },
    [],
  );

  const reopenDialog = useCallback(() => {
    if (candidatesRef.current.length > 0) setOpen(true);
  }, []);

  const saveCandidate = useCallback((candidateId: string) => {
    const entry = candidatesRef.current.find((e) => e.id === candidateId);
    if (!entry || entry.status !== "pending") return;

    const draft = createKnowledgeDraftFromCandidate(entry.draft);
    const handler = saveHandlerRef.current;
    if (handler) {
      const success = handler(candidateId, draft);
      if (!success) return;
    }

    setCandidates((current) =>
      current.map((e) => (e.id === candidateId ? { ...e, status: "saved" as const } : e)),
    );
  }, []);

  const ignoreCandidate = useCallback((candidateId: string) => {
    setCandidates((current) => {
      const next = current.filter((entry) => entry.id !== candidateId);
      if (next.length === 0) setOpen(false);
      return next;
    });
  }, []);

  const clearCandidates = useCallback(() => {
    setCandidates([]);
    setOpen(false);
  }, []);

  const pendingCount = candidates.filter((c) => c.status === "pending").length;

  return (
    <KnowledgeDialogContext.Provider
      value={{
        candidates,
        isDialogOpen: open,
        openDialog,
        reopenDialog,
        saveCandidate,
        ignoreCandidate,
        clearCandidates,
        registerSaveHandler,
      }}
    >
      {children}
      <Dialog open={open && candidates.length > 0} onOpenChange={setOpen}>
        <DialogContent className="max-h-[82vh] max-w-[640px] gap-0 overflow-hidden rounded-xl border-border/70 p-0">
          <DialogHeader className="border-b border-border/65 px-4 py-3 text-left">
            <DialogTitle className="text-[15px]">确认保存知识点</DialogTitle>
            <DialogDescription className="text-[12px]">
              Agent 已从当前笔记里提取候选知识点，确认有价值的内容后再保存。
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] space-y-2 overflow-y-auto px-4 py-3 scrollbar-thin">
            {candidates.map((candidate) => (
              <KnowledgeCandidateCard
                key={candidate.id}
                candidate={candidate}
                onSave={() => saveCandidate(candidate.id)}
                onIgnore={() => ignoreCandidate(candidate.id)}
              />
            ))}
          </div>

          <div className="flex h-11 items-center justify-between border-t border-border/65 px-4 text-[11.5px] text-muted-foreground">
            <span>{pendingCount > 0 ? `${pendingCount} 条待处理` : "已处理完"}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 rounded-md px-2 text-[11.5px]"
              onClick={() => setOpen(false)}
            >
              关闭
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </KnowledgeDialogContext.Provider>
  );
}

function KnowledgeCandidateCard({
  candidate,
  onSave,
  onIgnore,
}: {
  candidate: KnowledgeCandidateEntry;
  onSave: () => void;
  onIgnore: () => void;
}) {
  const isSaved = candidate.status === "saved";
  const draft = candidate.draft;

  return (
    <article className="rounded-lg border border-border/70 bg-background px-3 py-2.5">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="break-words text-[13px] font-semibold leading-5 text-foreground">
            {draft.title}
          </div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">
            {draft.categoryName}
          </div>
        </div>
        {isSaved ? (
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-[#1f9d7a]/25 bg-[#1f9d7a]/8 px-1.5 text-[10.5px] text-[#11745a]">
            <Check className="h-3 w-3" />
            已保存
          </span>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 rounded-md px-1.5 text-[11px] text-[#11745a] hover:text-[#11745a]"
              onClick={onSave}
            >
              保存
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 rounded-md px-1.5 text-[11px] text-muted-foreground"
              onClick={onIgnore}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>
      <p className="mt-1.5 break-words text-[12px] leading-5 text-muted-foreground">
        {draft.summary}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {draft.tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-0.5 rounded-full border border-border/65 bg-muted/25 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </div>
    </article>
  );
}
