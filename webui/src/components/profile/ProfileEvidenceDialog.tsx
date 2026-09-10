import { useEffect, useMemo, useState } from "react";
import { ExternalLink, FileText, Loader2 } from "lucide-react";

import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  fetchProfileEvidence,
  type EvidenceRef,
  type ProfileArtifact,
} from "@/lib/profile-api";

interface ProfileEvidenceDialogProps {
  refs: string[];
  evidenceIndex?: Record<string, EvidenceRef>;
  artifacts?: ProfileArtifact[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSession?: (sessionKey: string) => void;
  onOpenArtifact?: (artifact: ProfileArtifact) => void;
}

function kindLabel(kind: EvidenceRef["kind"]): string {
  return {
    user_message: "用户消息",
    note: "笔记",
    artifact: "成果",
    explicit_context: "你已确认",
  }[kind];
}

export function ProfileEvidenceDialog({
  refs,
  evidenceIndex,
  artifacts = [],
  open,
  onOpenChange,
  onOpenSession,
  onOpenArtifact,
}: ProfileEvidenceDialogProps) {
  const [loaded, setLoaded] = useState<EvidenceRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const local = refs
      .map((ref) => evidenceIndex?.[ref])
      .filter((item): item is EvidenceRef => !!item);
    setLoaded(local);
    setError(null);
    setLoading(true);
    void Promise.allSettled(refs.map((ref) => fetchProfileEvidence(ref)))
      .then((results) => {
        if (cancelled) return;
        const items = results.map((result, index) => {
          if (result.status === "fulfilled") return result.value;
          const fallback = evidenceIndex?.[refs[index]];
          return fallback ? { ...fallback, available: false } : null;
        }).filter((item): item is EvidenceRef => !!item);
        setLoaded(items);
        const unavailable = results.filter((result) => result.status === "rejected").length;
        if (unavailable > 0) setError(`${unavailable} 条原始依据当前不可访问，已显示保存的摘要。`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceIndex, open, refs]);

  const artifactById = useMemo(
    () => new Map(artifacts.map((artifact) => [artifact.id, artifact])),
    [artifacts],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[78vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-4 text-left">
          <DialogTitle>支撑这项观察的记录</DialogTitle>
          <DialogDescription>只展示本次画像实际引用的有限来源摘要。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {loading && loaded.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-caption text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />正在读取依据…
            </div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive">
              {error}
            </div>
          ) : null}
          {loaded.map((item) => {
            const artifact = item.artifact_id ? artifactById.get(item.artifact_id) : undefined;
            return (
              <article key={item.ref} className="rounded-lg border border-border/70 bg-card/60 p-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
                        {kindLabel(item.kind)}
                      </span>
                      <h3 className="min-w-0 truncate text-ui font-medium">{item.title || "未命名记录"}</h3>
                    </div>
                    <div className="mt-1 text-micro text-muted-foreground">
                      {item.occurred_at ? `记录时间：${new Date(item.occurred_at).toLocaleString("zh-CN")}` : "记录时间未知"}
                      {item.available === false ? " · 原始来源暂不可用" : ""}
                    </div>
                    <div className="mt-3 text-caption leading-6 text-foreground">
                      <MarkdownTextRenderer>{item.excerpt || "暂无摘要"}</MarkdownTextRenderer>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.session_key && onOpenSession ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className="h-7 gap-1.5"
                          onClick={() => onOpenSession(item.session_key!)}
                        >
                          <ExternalLink className="h-3 w-3" />打开原会话
                        </Button>
                      ) : null}
                      {artifact && onOpenArtifact ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className="h-7 gap-1.5"
                          onClick={() => onOpenArtifact(artifact)}
                        >
                          <ExternalLink className="h-3 w-3" />打开成果
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
          {!loading && !error && loaded.length === 0 ? (
            <p className="py-10 text-center text-caption text-muted-foreground">暂无可访问的依据。</p>
          ) : null}
        </div>
        <DialogFooter className="shrink-0 border-t border-border/60 px-5 py-3">
          <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
