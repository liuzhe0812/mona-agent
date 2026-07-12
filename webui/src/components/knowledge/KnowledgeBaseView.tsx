import { useEffect, useRef, useState } from "react"
import { FolderPlus, FileText, Network, Database, Search, Play, Loader2, Upload, ArrowLeft, X, ClipboardCheck, ShieldCheck, Pencil, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useKbStore } from "@/stores/kb-store"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { FileManager } from "./file-manager"
import { WikiViewer } from "./wiki-viewer"
import { GraphView } from "./graph-view"
import { ReviewView } from "./review-view"
import { LintView } from "./lint-view"
import { searchKb, setKbToken, type SearchResult } from "@/lib/kb-api"
import { useClient } from "@/providers/ClientProvider"

type Tab = "files" | "wiki" | "graph" | "review" | "lint"

export function KnowledgeBaseView() {
  const { token } = useClient()
  const {
    projects, currentProject, ingesting, loading, ingestErrors, ingestProgress,
    loadProjects, selectProject, createProject, renameProject, triggerIngest, importFiles, cancelIngest,
    runLint,
  } = useKbStore()
  const reviewPendingCount = useReviewStore((s) => s.items.filter((i) => !i.resolved).length)
  const lintRunning = useLintStore((s) => s.running)
  const lintResultCount = useLintStore((s) => s.results.length)
  const [tab, setTab] = useState<Tab>("files")
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [newProjectName, setNewProjectName] = useState("")
  const [showNewProject, setShowNewProject] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setKbToken(token) }, [token])
  useEffect(() => { loadProjects() }, [loadProjects])

  const handleSearch = async () => {
    if (!currentProject || !searchQuery.trim()) return
    const { results } = await searchKb(currentProject.id, searchQuery, 10)
    setSearchResults(results)
  }

  const handleCreate = async () => {
    if (!newProjectName.trim()) return
    await createProject(newProjectName.trim())
    setNewProjectName("")
    setShowNewProject(false)
  }

  // Resolve a slug or partial path to a full wiki page path
  const resolveWikiPath = (slugOrPath: string): string => {
    const pages = useKbStore.getState().wikiPages
    // If it's already a full path that matches a page, use it directly
    if (pages.some((p) => p.path === slugOrPath)) return slugOrPath
    // Try to match by slug (filename without extension)
    const slug = slugOrPath.replace(/^wiki:\/\//, "")
    const match = pages.find((p) => {
      const stem = p.path.replace(/\.md$/, "").split("/").pop() ?? ""
      return stem === slug
    })
    return match?.path ?? slugOrPath
  }

  // Expose setTab for child components (GraphView, WikiReader)
  const switchToWikiTab = (path?: string) => {
    setTab("wiki")
    if (path) {
      useKbStore.getState().loadWikiPage(resolveWikiPath(path))
    }
  }
  // Store on window for cross-component access without prop drilling
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__kbSwitchToWiki = switchToWikiTab
    return () => { delete (window as unknown as Record<string, unknown>).__kbSwitchToWiki }
  }, [])

  if (!currentProject) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 bg-background p-8">
        <div className="text-center">
          <Database className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
          <h1 className="text-2xl font-bold">知识库</h1>
          <p className="mt-2 text-muted-foreground">将文档编译为可搜索的 Wiki 知识图谱</p>
        </div>

        {projects.length > 0 && (
          <div className="w-full max-w-md">
            <p className="mb-2 text-sm text-muted-foreground">已有知识库：</p>
            <div className="flex flex-col gap-2">
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectProject(p.id)}
                  className="rounded-lg border px-4 py-3 text-left transition-colors hover:bg-accent"
                >
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.path}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {showNewProject ? (
          <div className="flex items-center gap-2">
            <Input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="知识库名称"
              className="w-48"
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <Button onClick={handleCreate}>创建</Button>
            <Button variant="ghost" onClick={() => setShowNewProject(false)}>取消</Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Button onClick={() => setShowNewProject(true)}>
              <FolderPlus className="mr-2 h-4 w-4" />
              新建知识库
            </Button>
          </div>
        )}
      </div>
    )
  }

  // Ingest progress info
  const totalFiles = ingestProgress
    ? ingestProgress.completedFiles.length + (ingestProgress.status === "running" ? 1 : 0)
    : 0
  const completedCount = ingestProgress?.completedFiles.length ?? 0
  const progressPct = totalFiles > 0 ? Math.round((completedCount / totalFiles) * 100) : 0

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => useKbStore.setState({ currentProject: null })}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        {editingName ? (
          <div className="flex items-center gap-1">
            <Input
              value={editNameValue}
              onChange={(e) => setEditNameValue(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && editNameValue.trim()) {
                  await renameProject(editNameValue.trim())
                  setEditingName(false)
                }
                if (e.key === "Escape") setEditingName(false)
              }}
              className="h-7 w-40 text-sm"
              autoFocus
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={async () => {
                if (editNameValue.trim()) {
                  await renameProject(editNameValue.trim())
                  setEditingName(false)
                }
              }}
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <button
            className="flex items-center gap-1 text-sm font-medium hover:text-primary"
            onClick={() => { setEditNameValue(currentProject.name); setEditingName(true) }}
          >
            {currentProject.name}
            <Pencil className="h-3 w-3 text-muted-foreground" />
          </button>
        )}

        <div className="mx-2 flex flex-1 items-center gap-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="搜索知识库..."
            className="h-7 max-w-xs text-xs"
          />
        </div>

        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => fileInputRef.current?.click()}
          disabled={ingesting}
        >
          <Upload className="h-3.5 w-3.5" />
          导入
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={async (e) => {
            const fileList = e.target.files
            if (!fileList?.length) return
            await importFiles(Array.from(fileList))
            if (fileInputRef.current) fileInputRef.current.value = ""
          }}
        />
        {ingesting ? (
          <Button
            size="sm"
            variant="destructive"
            className="h-7 gap-1 px-2 text-xs"
            onClick={cancelIngest}
          >
            <X className="h-3.5 w-3.5" />
            取消
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => triggerIngest()}
          >
            <Play className="h-3.5 w-3.5" />
            编译全部
          </Button>
        )}
      </div>

      {/* Ingest progress bar */}
      {ingesting && ingestProgress && (
        <div className="border-b bg-muted/30 px-4 py-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {ingestProgress.currentFile
                ? `正在编译: ${ingestProgress.currentFile}`
                : "编译中..."}
            </span>
            <span>{completedCount}/{totalFiles} 文件 · {progressPct}%</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {ingestProgress.pagesWritten > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              已生成 {ingestProgress.pagesWritten} 个 Wiki 页面
            </p>
          )}
        </div>
      )}

      {/* Ingest errors */}
      {ingestErrors.length > 0 && (
        <div className="border-b bg-destructive/10 px-4 py-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-destructive">编译错误</span>
            <Button variant="ghost" size="sm" onClick={() => useKbStore.setState({ ingestErrors: [] })}>关闭</Button>
          </div>
          <div className="mt-1 flex flex-col gap-1">
            {ingestErrors.map((err, i) => (
              <p key={i} className="text-xs text-destructive">{err}</p>
            ))}
          </div>
        </div>
      )}

      {/* Search results overlay */}
      {searchResults !== null && (
        <div className="border-b bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">搜索结果 ({searchResults.length})</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { setSearchResults(null) }}>关闭</Button>
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {searchResults.map((r, i) => (
              <button
                key={i}
                onClick={() => {
                  useKbStore.getState().loadWikiPage(r.path)
                  setTab("wiki")
                  setSearchResults(null)
                }}
                className="rounded border px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
              >
                <span className="font-medium">[{r.type}] {r.title}</span>
                <span className="ml-2 text-muted-foreground">{r.path}</span>
                {r.snippet && <p className="mt-1 text-xs text-muted-foreground">{r.snippet}</p>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b">
        {([
          ["files", "文件管理", FileText],
          ["wiki", "Wiki", FileText],
          ["graph", "知识图谱", Network],
          ["review", "审查", ClipboardCheck],
          ["lint", "检查", ShieldCheck],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id as Tab)}
            className={`flex items-center gap-2 px-4 py-2 text-sm transition-colors ${
              tab === id
                ? "border-b-2 border-primary font-medium text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
            {id === "review" && reviewPendingCount > 0 && (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                {reviewPendingCount}
              </span>
            )}
            {id === "lint" && lintResultCount > 0 && (
              <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium text-white">
                {lintResultCount}
              </span>
            )}
          </button>
        ))}
        {tab === "lint" && (
          <div className="ml-auto flex items-center pr-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => runLint()}
              disabled={lintRunning}
            >
              {lintRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              运行检查
            </Button>
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            加载中...
          </div>
        ) : tab === "files" ? (
          <FileManager />
        ) : tab === "wiki" ? (
          <WikiViewer />
        ) : tab === "review" ? (
          <ReviewView />
        ) : tab === "lint" ? (
          <LintView />
        ) : (
          <GraphView onNavigateToWiki={(path) => { setTab("wiki"); useKbStore.getState().loadWikiPage(path) }} />
        )}
      </div>
    </div>
  )
}
