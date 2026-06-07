import { useState } from "react"
import { AlertTriangle, Copy, FileQuestion, Lightbulb, CheckCircle2, Trash2, Merge, SkipForward, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useKbStore } from "@/stores/kb-store"
import type { DuplicateGroup } from "@/lib/dedup"

const TYPE_CONFIG: Record<
  ReviewItem["type"],
  { icon: typeof AlertTriangle; label: string; color: string }
> = {
  contradiction: { icon: AlertTriangle, label: "矛盾", color: "text-amber-500" },
  duplicate: { icon: Copy, label: "可能重复", color: "text-blue-500" },
  "missing-page": { icon: FileQuestion, label: "缺失页面", color: "text-purple-500" },
  suggestion: { icon: Lightbulb, label: "建议", color: "text-emerald-500" },
  confirm: { icon: CheckCircle2, label: "需确认", color: "text-foreground" },
}

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
        <Copy className="h-5 w-5 shrink-0 mt-0.5 text-blue-500" />
        <div className="flex-1 min-w-0">
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
            <Button
              size="sm"
              variant="outline"
              className="text-xs h-7"
              onClick={onMerge}
              disabled={merging}
            >
              {merging ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Merge className="mr-1 h-3 w-3" />
              )}
              合并
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs h-7 text-muted-foreground"
              onClick={onSkip}
              disabled={merging}
            >
              <SkipForward className="mr-1 h-3 w-3" />
              跳过
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ReviewView() {
  const items = useReviewStore((s) => s.items)
  const resolveItem = useReviewStore((s) => s.resolveItem)
  const dismissItem = useReviewStore((s) => s.dismissItem)
  const clearResolved = useReviewStore((s) => s.clearResolved)
  const dedupGroups = useKbStore((s) => s.dedupGroups)
  const mergeGroup = useKbStore((s) => s.mergeGroup)
  const dismissGroup = useKbStore((s) => s.dismissGroup)
  const runDedup = useKbStore((s) => s.runDedup)
  const persistReviews = useKbStore((s) => s.persistReviews)

  const [dedupRunning, setDedupRunning] = useState(false)
  const [mergingSlugs, setMergingSlugs] = useState<string | null>(null)

  const pending = items.filter((i) => !i.resolved)
  const resolved = items.filter((i) => i.resolved)

  const handleRunDedup = async () => {
    setDedupRunning(true)
    try {
      await runDedup()
    } finally {
      setDedupRunning(false)
    }
  }

  const handleMerge = async (group: DuplicateGroup) => {
    setMergingSlugs(group.slugs.join(","))
    try {
      await mergeGroup(group)
    } finally {
      setMergingSlugs(null)
    }
  }

  const hasContent = items.length > 0 || dedupGroups.length > 0

  if (!hasContent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <CheckCircle2 className="h-10 w-10 opacity-30" />
        <p className="text-sm">暂无审查项</p>
        <p className="text-xs">编译源文件后自动生成</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2 text-xs"
          onClick={handleRunDedup}
          disabled={dedupRunning}
        >
          {dedupRunning ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Copy className="mr-1 h-3 w-3" />
          )}
          检测重复实体
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-sm font-medium">
          审查项 ({pending.length} 待处理
          {dedupGroups.length > 0 && `, ${dedupGroups.length} 重复组`})
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-7"
            onClick={handleRunDedup}
            disabled={dedupRunning}
          >
            {dedupRunning ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Copy className="mr-1 h-3 w-3" />
            )}
            检测重复
          </Button>
          {resolved.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => { clearResolved(); persistReviews() }} className="text-xs">
              清除已处理
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="flex flex-col gap-3">
          {/* Dedup groups section */}
          {dedupGroups.length > 0 && (
            <div className="mb-2">
              <h3 className="mb-2 text-sm font-medium text-blue-500">
                重复实体检测
              </h3>
              <div className="flex flex-col gap-3">
                {dedupGroups.map((group) => (
                  <DedupGroupCard
                    key={group.slugs.join(",")}
                    group={group}
                    onMerge={() => handleMerge(group)}
                    onSkip={() => dismissGroup(group)}
                    merging={mergingSlugs === group.slugs.join(",")}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Regular review items */}
          {items.map((item) => {
            const config = TYPE_CONFIG[item.type] ?? TYPE_CONFIG.confirm
            const Icon = config.icon
            return (
              <div
                key={item.id}
                className={`rounded-lg border p-4 transition-opacity ${
                  item.resolved ? "opacity-50" : ""
                }`}
              >
                <div className="flex items-start gap-3">
                  <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${config.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                        {config.label}
                      </span>
                      <span className="text-sm font-medium">{item.title}</span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                    {item.sourcePath && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        来源: {item.sourcePath}
                      </p>
                    )}
                    {item.affectedPages && item.affectedPages.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        关联: {item.affectedPages.join(", ")}
                      </p>
                    )}
                    {!item.resolved && (
                      <div className="mt-3 flex items-center gap-2">
                        {item.options.map((opt) => (
                          <Button
                            key={opt.action}
                            size="sm"
                            variant={opt.action === "skip" ? "ghost" : "outline"}
                            className="text-xs h-7"
                            onClick={() => { resolveItem(item.id, opt.action); persistReviews() }}
                          >
                            {opt.label}
                          </Button>
                        ))}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs h-7 text-muted-foreground"
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
      </div>
    </div>
  )
}
