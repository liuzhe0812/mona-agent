import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { AlertCircle, GitBranch, GitGraph, GitMerge, LoaderCircle, RefreshCw, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DevelopmentDiff } from "./DevelopmentDiff";
import { gitActionsApi, type GitCommitDetail, type GitGraphCommit } from "./git-actions-api";
import { layoutGitGraph } from "./DevelopmentGitGraphLayout";

const SCROLL_THRESHOLD = 96;
const LANE_STROKES = ["stroke-info", "stroke-success", "stroke-warning", "stroke-destructive"];
const LANE_FILLS = ["fill-info", "fill-success", "fill-warning", "fill-destructive"];

function shortHash(hash: string) {
  return hash.slice(0, 7);
}

function commitTime(value: number | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function refIcon(ref: GitGraphCommit["refs"][number]) {
  return ref.kind === "tag" ? <Tag className="h-3 w-3" /> : <GitBranch className="h-3 w-3" />;
}

function laneStroke(index: number) {
  return LANE_STROKES[index % LANE_STROKES.length];
}

function laneFill(index: number) {
  return LANE_FILLS[index % LANE_FILLS.length];
}

function isRelated(path: { relatedHashes: string[] }, hash: string | null) {
  return Boolean(hash && path.relatedHashes.includes(hash));
}

export function DevelopmentGitGraph({ session, open, onOpenChange }: {
  session: { id: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [commits, setCommits] = useState<GitGraphCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [diff, setDiff] = useState<{ path: string; value: string } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const loadingMoreRef = useRef(false);

  const loadInitial = useCallback(async (refresh = false) => {
    const request = ++generation.current;
    detailGeneration.current += 1;
    loadingMoreRef.current = false;
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError("");
    if (!refresh) {
      setCommits([]);
      setHasMore(false);
      setSelectedHash(null);
    }
    setExpandedHash(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError("");
    setDiff(null);
    setDiffLoading(false);
    setDiffError("");
    try {
      const result = await gitActionsApi.graph(session.id, 0);
      if (request !== generation.current) return;
      setCommits(result.commits);
      setHasMore(result.hasMore);
      setSelectedHash(result.commits[0]?.hash ?? null);
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "无法读取 Git 图谱。");
    } finally {
      if (request === generation.current) { setLoading(false); setRefreshing(false); }
    }
  }, [session.id]);

  useEffect(() => {
    if (open) void loadInitial();
    else {
      generation.current += 1;
      detailGeneration.current += 1;
      setLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
      setDetailLoading(false);
      setDiffLoading(false);
      loadingMoreRef.current = false;
    }
  }, [loadInitial, open]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading || loadingMore || refreshing || loadingMoreRef.current) return;
    const request = generation.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError("");
    try {
      const result = await gitActionsApi.graph(session.id, commits.length);
      if (request === generation.current) {
        setCommits((current) => [...current, ...result.commits]);
        setHasMore(result.hasMore);
      }
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "无法读取更多提交。");
    } finally {
      if (request === generation.current) { loadingMoreRef.current = false; setLoadingMore(false); }
    }
  }, [commits.length, hasMore, loading, loadingMore, refreshing, session.id]);

  const loadDetail = useCallback(async (hash: string) => {
    const request = ++detailGeneration.current;
    setDetailLoading(true);
    setDetailError("");
    setDetail(null);
    setDiff(null);
    setDiffError("");
    try {
      const value = await gitActionsApi.commitDetail(session.id, hash);
      if (request === detailGeneration.current) setDetail(value);
    } catch (cause) {
      if (request === detailGeneration.current) setDetailError(cause instanceof Error ? cause.message : "无法读取提交详情。");
    } finally {
      if (request === detailGeneration.current) setDetailLoading(false);
    }
  }, [session.id]);

  const selectCommit = (hash: string) => {
    setSelectedHash(hash);
    if (expandedHash === hash) {
      detailGeneration.current += 1;
      setExpandedHash(null);
      setDetail(null);
      setDiff(null);
      return;
    }
    setExpandedHash(hash);
    void loadDetail(hash);
  };

  const loadFileDiff = async (hash: string, path: string) => {
    const request = ++detailGeneration.current;
    setDiffLoading(true);
    setDiffError("");
    setDiff(null);
    try {
      const value = await gitActionsApi.commitDetail(session.id, hash, path);
      if (request === detailGeneration.current) setDiff({ path, value: value.diff });
    } catch (cause) {
      if (request === detailGeneration.current) setDiffError(cause instanceof Error ? cause.message : "无法读取文件差异。");
    } finally {
      if (request === detailGeneration.current) setDiffLoading(false);
    }
  };

  const onGraphScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight <= SCROLL_THRESHOLD) void loadMore();
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} className="flex h-[min(78vh,720px)] max-w-5xl flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-5xl">
      <DialogHeader className="sr-only"><DialogTitle>Git 图谱</DialogTitle><DialogDescription>查看提交历史和文件差异。</DialogDescription></DialogHeader>
      <Button type="button" variant="ghost" size="icon" aria-label="关闭 Git 图谱" className="absolute right-2 top-2 z-30 h-8 w-8" onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></Button>
      <section className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-muted/30 px-4">
          <div className="flex min-w-0 items-center gap-2"><GitGraph className="h-4 w-4" /><h2 className="truncate text-ui font-medium">Git 图谱</h2></div>
          <Button type="button" variant="ghost" size="icon" disabled={loading || loadingMore || refreshing} aria-label="刷新 Git 图谱" title="刷新 Git 图谱" className="mr-8 h-8 w-8" onClick={() => void loadInitial(true)}><RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /></Button>
        </div>
        {loading ? <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"><LoaderCircle className="h-5 w-5 animate-spin" /></div>
          : error && commits.length === 0 ? <div className="flex min-h-0 flex-1 items-center justify-center p-6"><div role="alert" className="flex max-w-md items-start gap-3 rounded-lg border border-border bg-card p-4 text-ui"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" /><p className="break-words">{error}</p><Button variant="outline" size="sm" onClick={() => void loadInitial()}>重试</Button></div></div>
            : <>
              {error && <p role="alert" className="shrink-0 px-4 py-2 text-caption text-destructive">{error}<Button variant="ghost" size="sm" onClick={() => void loadMore()}>重试</Button></p>}
              <GraphList commits={commits} selectedHash={selectedHash} onSelect={selectCommit} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} onScroll={onGraphScroll} />
              {expandedHash && <CommitDetailPanel commit={detail?.commit ?? commits.find((item) => item.hash === expandedHash) ?? null} detail={detail} loading={detailLoading} error={detailError} diff={diff} diffLoading={diffLoading} diffError={diffError} onSelectFile={(path) => void loadFileDiff(expandedHash, path)} />}
            </>}
      </section>
    </DialogContent>
  </Dialog>;
}

function GraphList({ commits, selectedHash, onSelect, hasMore, loadingMore, onLoadMore, onScroll }: {
  commits: GitGraphCommit[]; selectedHash: string | null; onSelect: (hash: string) => void;
  hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; onScroll: (event: UIEvent<HTMLDivElement>) => void;
}) {
  const [hoveredHash, setHoveredHash] = useState<string | null>(null);
  const layout = useMemo(() => layoutGitGraph(commits), [commits]);
  const expandedHeight = layout.height + layout.rowHeight;
  const graphWidth = Math.max(layout.width + 12, 56);
  const tableStyle = { gridTemplateColumns: "minmax(260px,1fr) 128px 112px 84px" };

  return <div className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
    {commits.length === 0 ? <div className="flex h-full items-center justify-center p-6 text-ui text-muted-foreground">没有提交记录</div> : <div className="min-h-0 overflow-auto">
      <div className="grid min-w-[760px]" style={{ gridTemplateColumns: `minmax(56px, ${layout.width + 12}px) minmax(0, 1fr)` }}>
        <div className="border-b border-r border-border bg-muted/30 px-3 py-2 text-ui font-medium text-muted-foreground">图谱</div>
        <div className="grid border-b border-border bg-muted/30 text-ui font-medium text-muted-foreground" style={tableStyle}><div className="border-r border-border px-3 py-2">说明</div><div className="border-r border-border px-3 py-2">日期</div><div className="border-r border-border px-3 py-2">作者</div><div className="px-3 py-2">提交</div></div>
        <div className="relative border-r border-border bg-muted/10" style={{ height: expandedHeight }}>
          <svg className="absolute inset-0 overflow-visible" width={graphWidth} height={expandedHeight} viewBox={`0 0 ${graphWidth} ${expandedHeight}`} role="img" aria-label="提交关系图">
            {layout.paths.map((path) => <path key={path.id} d={path.path} className={`fill-none stroke-[2] opacity-55 transition-opacity ${laneStroke(path.laneIndex)} ${hoveredHash && !isRelated(path, hoveredHash) ? "opacity-30" : ""} ${isRelated(path, hoveredHash) ? "opacity-100" : ""}`} />)}
            {layout.rows.map((row) => {
              const selected = row.commit.hash === selectedHash;
              const hovered = row.commit.hash === hoveredHash;
              return <g key={row.commit.hash}><circle cx={row.x} cy={row.y} r={selected ? 4.25 : 4} className={`stroke-background stroke-2 transition-all ${laneFill(row.laneIndex)} ${hoveredHash && !selected && !hovered ? "opacity-80" : ""}`} />{selected && <circle cx={row.x} cy={row.y} r={5.5} className={`fill-none stroke ${laneStroke(row.laneIndex)}`} />}</g>;
            })}
          </svg>
        </div>
        <div className="min-w-0">
          {layout.rows.map((row) => {
            const selected = row.commit.hash === selectedHash;
            const hovered = row.commit.hash === hoveredHash;
            return <button key={row.commit.hash} type="button" className={`grid w-full min-w-0 items-center border-y border-transparent text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none ${selected ? "border-b-border bg-muted/60" : ""} ${hovered && !selected ? "bg-muted/30" : ""}`} style={{ ...tableStyle, height: layout.rowHeight }} onClick={() => onSelect(row.commit.hash)} onMouseEnter={() => setHoveredHash(row.commit.hash)} onMouseLeave={() => setHoveredHash(null)}>
              <span className="min-w-0 px-3"><span className="flex min-w-0 items-center gap-2">
                {row.commit.refs.length > 0 && <span className="flex min-w-0 shrink-0 items-center gap-1 overflow-hidden">{row.commit.refs.slice(0, 4).map((ref) => <span key={`${row.commit.hash}:${ref.name}`} className={`inline-flex h-5 min-w-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-caption text-muted-foreground ${ref.kind === "head" ? "border-info bg-info/10 text-foreground" : ref.kind === "tag" ? "border-success" : ""}`}>{refIcon(ref)}<span className="max-w-32 truncate">{ref.name}</span></span>)}</span>}
                <span className="truncate text-ui">{row.commit.subject || shortHash(row.commit.hash)}</span>{row.commit.parents.length > 1 && <GitMerge className="h-3 w-3 shrink-0 text-warning" />}
              </span></span>
              <span className={`truncate border-l border-transparent px-3 text-ui text-muted-foreground ${selected ? "border-border" : ""}`}>{commitTime(row.commit.authoredAtMs)}</span>
              <span className={`truncate border-l border-transparent px-3 text-ui text-muted-foreground ${selected ? "border-border" : ""}`}>{row.commit.authorName || ""}</span>
              <span className={`truncate border-l border-transparent px-3 font-mono text-caption text-muted-foreground ${selected ? "border-border" : ""}`}>{shortHash(row.commit.hash)}</span>
            </button>;
          })}
          {hasMore && <div className="flex h-10 items-center border-b border-border px-3"><Button type="button" variant="ghost" size="sm" disabled={loadingMore} className="w-full" onClick={onLoadMore}>{loadingMore ? "正在加载…" : "加载更多"}</Button></div>}
        </div>
      </div>
    </div>}
  </div>;
}

function CommitDetailPanel({ commit, detail, loading, error, diff, diffLoading, diffError, onSelectFile }: {
  commit: GitGraphCommit | null; detail: GitCommitDetail | null; loading: boolean; error: string;
  diff: { path: string; value: string } | null; diffLoading: boolean; diffError: string; onSelectFile: (path: string) => void;
}) {
  return <div className="max-h-[45%] shrink-0 overflow-auto border-t border-border bg-muted/20 px-4 py-3">
    {loading ? <p role="status" className="flex items-center gap-2 text-ui text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />正在读取提交详情…</p>
      : error ? <p role="alert" className="text-ui text-destructive">{error}</p>
        : commit && detail ? <div className="space-y-3">
          <div className="grid gap-3 text-ui md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="min-w-0"><div className="text-caption text-muted-foreground">提交说明</div><div className="break-words">{commit.subject || shortHash(commit.hash)}</div>{detail.body && <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{detail.body}</p>}</div>
            <div className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 text-caption"><div className="min-w-0"><div className="text-muted-foreground">提交</div><div className="truncate font-mono">{commit.hash}</div></div><div className="min-w-0"><div className="text-muted-foreground">作者</div><div className="truncate">{commit.authorName || "-"}</div></div><div className="min-w-0"><div className="text-muted-foreground">日期</div><div className="truncate">{commitTime(commit.authoredAtMs) || "-"}</div></div><div className="min-w-0"><div className="text-muted-foreground">父提交</div><div className="truncate font-mono">{commit.parents.length ? commit.parents.map(shortHash).join(", ") : "-"}</div></div></div>
          </div>
          <div className="space-y-1"><div className="text-caption font-medium">文件</div>{detail.files.length ? <div className="max-h-32 space-y-0.5 overflow-auto">{detail.files.map((file) => <button type="button" key={file.path} className={`flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-ui hover:bg-muted ${diff?.path === file.path ? "bg-muted" : ""}`} onClick={() => onSelectFile(file.path)}><span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span><span className="shrink-0 font-mono text-caption"><span className="text-success">+{file.additions}</span>{" "}<span className="text-destructive">-{file.deletions}</span></span></button>)}</div> : <p className="text-caption text-muted-foreground">此提交没有文件变更。</p>}</div>
          {diffLoading && <p role="status" className="text-caption text-muted-foreground">正在读取文件差异…</p>}
          {diffError && <p role="alert" className="text-caption text-destructive">{diffError}</p>}
          {diff && <div className="max-h-56 overflow-auto rounded-md border border-border/60"><p className="sticky top-0 bg-background px-3 py-2 text-caption">{diff.path}</p>{diff.value ? <DevelopmentDiff value={diff.value} /> : <p className="p-3 text-caption text-muted-foreground">没有可展示的文本差异。</p>}</div>}
        </div> : null}
  </div>;
}
