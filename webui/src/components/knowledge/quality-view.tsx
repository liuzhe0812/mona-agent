import { useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FileQuestion,
  Info,
  Lightbulb,
  Loader2,
  Merge,
  ShieldCheck,
  SkipForward,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useKbStore } from "@/stores/kb-store"
import type { LintResult } from "@/lib/kb-api"
import type { DuplicateGroup } from "@/lib/dedup"

// ── Review type config ──
const REVIEW_TYPE_CONFIG: Record<
  ReviewItem["type"],
  { icon: typeof AlertTriangle; label: string; color: string }
> = {
  contradiction: { icon: AlertTriangle, label: "矛盾", color: "text-amber-500" },
  duplicate: { icon: Copy, label: "可能重复", color: "text-blue-500" },
  "missing-page": { icon: FileQuestion, label: "缺失页面", color: "text-purple-500" },
  suggestion: { icon: Lightbulb, label: "建议", color: "text-emerald-500" },
  confirm: { icon: CheckCircle2, label: "需确认", color: "text-foreground" },
}

// ── Lint type config ──
const LINT_TYPE_CONFIG: Record<
  LintResult["type"],
  { label: string; color: string }
> = {
  "broken-link": { label: "断链", color: "text-amber-500" },
  orphan: { label: "孤立页面", color: "text-blue-500" },
  "no-outlinks": { label: "无出链", color: "text-purple-500" },
}

function SeverityIcon({ severity }: { severity: LintResult["severity"] }) {
  return severity === "warning"
    ? <AlertTriangle className="h-4 w-4 text-amber-500" />
    : <Info className="h-4 w-4 text-blue-500" />
}

// ── Dedup group card ──
function DedupGroupCard({
  group,
  onMerge,
  onSkip,
  merging,
}: {
  group: DuplicateGroup
  onMerge: () => void
  onSkip: () => void
  merging: boolean
}) {
  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
      <div className="flex items-start gap-3">
        <Copy className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
              重复实体
            </span>
            <span className="text-sm font-medium">检测到可能重复的页面</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{group.reason}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {group.slugs.map((slug) => (
              <span
                key={slug}
                className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                {slug}
              </span>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onMerge} disabled={merging}>
              {merging ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Merge className="mr-1 h-3 w-3" />}
              合并
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={onSkip} disabled={merging}>
              <SkipForward className="mr-1 h-3 w-3" />
              跳过
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

type SubTab = "review" | "lint"

export function QualityView() {
  const [subTab, setSubTab] = useState<SubTab>("review")

  // Review store
  const reviewItems = useReviewStore((s) => s.items)
  const resolveItem = useReviewStore((s) => s.resolveItem)
  const dismissItem = useReviewStore((s) => s.dismissItem)
  const clearResolved = useReviewStore((s) => s.clearResolved)
  const persistReviews = useKbStore((s) => s.persistReviews)

  // Lint store
  const lintResults = useLintStore((s) => s.results)
  const lintRunning = useLintStore((s) => s.running)

  // KB store
  const dedupGroups = useKbStore((s) => s.dedupGroups)
  const mergeGroup = useKbStore((s) => s.mergeGroup)
  const dismissGroup = useKbStore((s) => s.dismissGroup)
  const runLint = useKbStore((s) => s.runLint)
  const runDedup = useKbStore((s) => s.runDedup)
  const loadWikiPage = useKbStore((s) => s.loadWikiPage)

  const [dedupRunning, setDedupRunning] = useState(false)
  const [mergingSlugs, setMergingSlugs] = useState<string | null>(null)

  const pendingReviews = reviewItems.filter((i) => !i.resolved)
  const resolvedReviews = reviewItems.filter((i) => i.resolved)

  const handleRunDedup = async () => {
    setDedupRunning(true)
    try { await runDedup() } finally { setDedupRunning(false) }
  }

  const handleMerge = async (group: DuplicateGroup) => {
    setMergingSlugs(group.slugs.join(","))
    try { await mergeGroup(group) } finally { setMergingSlugs(null) }
  }

  // Lint grouped
  const lintGrouped = lintResults.reduce(
    (acc, r) => { if (!acc[r.type]) acc[r.type] = []; acc[r.type].push(r); return acc },
    {} as Record<string, LintResult[]>,
  )
  const lintWarnings = lintResults.filter((r) => r.severity === "warning").length
  const lintInfos = lintResults.filter((r) => r.severity === "info").length

  return (
    <div className="flex h-full flex-col">
      {/* Header with sub-tabs */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSubTab("review")}
            className={`rounded-md px-3 py-1 text-sm transition-colors ${
              subTab === "review"
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            审查
            {pendingReviews.length > 0 && (
              <span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                {pendingReviews.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setSubTab("lint")}
            className={`rounded-md px-3 py-1 text-sm transition-colors ${
              subTab === "lint"
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            质量检查
            {lintResults.length > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                {lintResults.length}
              </span>
            )}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {subTab === "review" && (
            <>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleRunDedup} disabled={dedupRunning}>
                {dedupRunning ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Copy className="mr-1 h-3 w-3" />}
                检测重复
              </Button>
              {resolvedReviews.length > 0 && (
                <Button variant="ghost" size="sm" className="text-xs" onClick={() => { clearResolved(); persistReviews() }}>
                  清除已处理
                </Button>
              )}
            </>
          )}
          {subTab === "lint" && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => runLint()} disabled={lintRunning}>
              {lintRunning ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <ShieldCheck className="mr-1 h-3 w-3" />}
              运行检查
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {subTab === "review" ? (
          <ReviewContent
            items={reviewItems}
            dedupGroups={dedupGroups}
            mergingSlugs={mergingSlugs}
            resolveItem={resolveItem}
            dismissItem={dismissItem}
            persistReviews={persistReviews}
            onMerge={handleMerge}
            onDismissGroup={dismissGroup}
            onRunDedup={handleRunDedup}
            dedupRunning={dedupRunning}
          />
        ) : (
          <LintContent
            results={lintResults}
            running={lintRunning}
            grouped={lintGrouped}
            warnings={lintWarnings}
            infos={lintInfos}
            onNavigate={(page) => {
              loadWikiPage(page)
              const switchFn = (window as unknown as Record<string, unknown>).__kbSwitchToWiki as
                | ((path?: string) => void) | undefined
              switchFn?.(page)
            }}
          />
        )}
      </div>
    </div>
  )
}

// ── Review sub-content ──
function ReviewContent({
  items,
  dedupGroups,
  mergingSlugs,
  resolveItem,
  dismissItem,
  persistReviews,
  onMerge,
  onDismissGroup,
  onRunDedup,
  dedupRunning,
}: {
  items: ReviewItem[]
  dedupGroups: DuplicateGroup[]
  mergingSlugs: string | null
  resolveItem: (id: string, action: string) => void
  dismissItem: (id: string) => void
  persistReviews: () => void
  onMerge: (group: DuplicateGroup) => void
  onDismissGroup: (group: DuplicateGroup) => void
  onRunDedup: () => void
  dedupRunning: boolean
}) {
  if (items.length === 0 && dedupGroups.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <CheckCircle2 className="h-10 w-10 opacity-30" />
        <p className="text-sm">暂无审查项</p>
        <p className="text-xs">编译源文件后自动生成</p>
        <Button size="sm" variant="outline" className="mt-2 text-xs" onClick={onRunDedup} disabled={dedupRunning}>
          {dedupRunning ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Copy className="mr-1 h-3 w-3" />}
          检测重复实体
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {dedupGroups.length > 0 && (
        <div className="mb-2">
          <h3 className="mb-2 text-sm font-medium text-blue-500">重复实体检测</h3>
          <div className="flex flex-col gap-3">
            {dedupGroups.map((group) => (
              <DedupGroupCard
                key={group.slugs.join(",")}
                group={group}
                onMerge={() => onMerge(group)}
                onSkip={() => onDismissGroup(group)}
                merging={mergingSlugs === group.slugs.join(",")}
              />
            ))}
          </div>
        </div>
      )}
      {items.map((item) => {
        const config = REVIEW_TYPE_CONFIG[item.type] ?? REVIEW_TYPE_CONFIG.confirm
        const Icon = config.icon
        return (
          <div
            key={item.id}
            className={`rounded-lg border p-4 transition-opacity ${item.resolved ? "opacity-50" : ""}`}
          >
            <div className="flex items-start gap-3">
              <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${config.color}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">{config.label}</span>
                  <span className="text-sm font-medium">{item.title}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                {item.sourcePath && (
                  <p className="mt-1 text-xs text-muted-foreground">来源: {item.sourcePath}</p>
                )}
                {item.affectedPages && item.affectedPages.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">关联: {item.affectedPages.join(", ")}</p>
                )}
                {!item.resolved && (
                  <div className="mt-3 flex items-center gap-2">
                    {item.options.map((opt) => (
                      <Button
                        key={opt.action}
                        size="sm"
                        variant={opt.action === "skip" ? "ghost" : "outline"}
                        className="h-7 text-xs"
                        onClick={() => { resolveItem(item.id, opt.action); persistReviews() }}
                      >
                        {opt.label}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => { dismissItem(item.id); persistReviews() }}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      忽略
                    </Button>
                  </div>
                )}
                {item.resolved && (
                  <span className="mt-2 inline-block text-xs text-muted-foreground">
                    已处理: {item.resolvedAction}
                  </span>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Lint sub-content ──
function LintContent({
  results,
  running,
  grouped,
  warnings,
  infos,
  onNavigate,
}: {
  results: LintResult[]
  running: boolean
  grouped: Record<string, LintResult[]>
  warnings: number
  infos: number
  onNavigate: (page: string) => void
}) {
  if (results.length === 0 && !running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <ShieldCheck className="h-10 w-10 opacity-30" />
        <p className="text-sm">暂无检查结果</p>
        <p className="text-xs">点击上方"运行检查"按钮开始</p>
      </div>
    )
  }

  if (running) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        <span className="text-sm">正在检查...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {results.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {warnings} 警告, {infos} 提示
        </p>
      )}
      {Object.entries(grouped).map(([type, items]) => {
        const config = LINT_TYPE_CONFIG[type as LintResult["type"]] ?? {
          label: type,
          color: "text-muted-foreground",
        }
        return (
          <div key={type}>
            <div className="mb-2 flex items-center gap-2">
              <span className={`text-sm font-medium ${config.color}`}>{config.label}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {items.length}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {items.map((item, i) => (
                <button
                  key={`${item.page}-${i}`}
                  className="flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent"
                  onClick={() => onNavigate(item.page)}
                >
                  <SeverityIcon severity={item.severity} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.page}</p>
                    <p className="text-xs text-muted-foreground">{item.detail}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
