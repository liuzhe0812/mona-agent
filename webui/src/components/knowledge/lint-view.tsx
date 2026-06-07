import { AlertTriangle, Info, FileText } from "lucide-react"
import { useLintStore } from "@/stores/lint-store"
import type { LintResult } from "@/lib/kb-api"
import { useKbStore } from "@/stores/kb-store"

const TYPE_CONFIG: Record<
  LintResult["type"],
  { label: string; color: string }
> = {
  "broken-link": { label: "断链", color: "text-amber-500" },
  orphan: { label: "孤立页面", color: "text-blue-500" },
  "no-outlinks": { label: "无出链", color: "text-purple-500" },
}

function SeverityIcon({ severity }: { severity: LintResult["severity"] }) {
  if (severity === "warning") {
    return <AlertTriangle className="h-4 w-4 text-amber-500" />
  }
  return <Info className="h-4 w-4 text-blue-500" />
}

export function LintView() {
  const results = useLintStore((s) => s.results)
  const running = useLintStore((s) => s.running)
  const loadWikiPage = useKbStore((s) => s.loadWikiPage)

  // Group results by type
  const grouped = results.reduce(
    (acc, r) => {
      if (!acc[r.type]) acc[r.type] = []
      acc[r.type].push(r)
      return acc
    },
    {} as Record<string, LintResult[]>,
  )

  const warningCount = results.filter((r) => r.severity === "warning").length
  const infoCount = results.filter((r) => r.severity === "info").length

  if (results.length === 0 && !running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileText className="h-10 w-10 opacity-30" />
        <p className="text-sm">暂无检查结果</p>
        <p className="text-xs">点击"运行检查"按钮开始</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-sm font-medium">
          检查结果
          {results.length > 0 && (
            <span className="ml-2 text-xs text-muted-foreground">
              ({warningCount} 警告, {infoCount} 提示)
            </span>
          )}
        </span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {running ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <span className="text-sm">正在检查...</span>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {Object.entries(grouped).map(([type, items]) => {
              const config = TYPE_CONFIG[type as LintResult["type"]] ?? {
                label: type,
                color: "text-muted-foreground",
              }
              return (
                <div key={type}>
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className={`text-sm font-medium ${config.color}`}
                    >
                      {config.label}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {items.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {items.map((item, i) => (
                      <button
                        key={`${item.page}-${i}`}
                        className="flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent"
                        onClick={() => {
                          loadWikiPage(item.page)
                          const switchFn = (
                            window as unknown as Record<string, unknown>
                          ).__kbSwitchToWiki as
                            | ((path?: string) => void)
                            | undefined
                          switchFn?.(item.page)
                        }}
                      >
                        <SeverityIcon severity={item.severity} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {item.page}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.detail}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
