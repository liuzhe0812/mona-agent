import { useEffect, useState, useCallback } from "react"
import { FileText, Pencil } from "lucide-react"
import { useKbStore } from "@/stores/kb-store"
import * as api from "@/lib/kb-api"
import { WikiReader } from "./wiki-reader"
import { WikiEditor } from "./wiki-editor"

const TYPE_LABELS: Record<string, string> = {
  entity: "实体",
  concept: "概念",
  source: "来源",
  query: "查询",
  synthesis: "综合",
  overview: "概览",
  comparison: "对比",
  finding: "发现",
  thesis: "论点",
  methodology: "方法",
}

export function WikiViewer() {
  const { wikiPages, currentWikiPage, currentProject, loadWikiPage } = useKbStore()
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!currentWikiPage && wikiPages.length > 0) {
      loadWikiPage(wikiPages[0].path)
    }
  }, [currentWikiPage, wikiPages, loadWikiPage])

  // Exit edit mode when switching pages
  useEffect(() => {
    setEditing(false)
  }, [currentWikiPage?.path])

  const handleSave = useCallback(
    async (content: string) => {
      if (!currentProject || !currentWikiPage) return
      await api.updateWikiPage(currentProject.id, currentWikiPage.path, content)
      await loadWikiPage(currentWikiPage.path)
      setEditing(false)
    },
    [currentProject, currentWikiPage, loadWikiPage],
  )

  const handleCancel = useCallback(() => {
    setEditing(false)
  }, [])

  return (
    <div className="flex h-full">
      {/* Page tree */}
      <div className="w-56 shrink-0 overflow-auto border-r">
        {wikiPages.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">暂无 Wiki 页面</div>
        ) : (
          <div className="flex flex-col py-1">
            {wikiPages.map((page) => (
              <button
                key={page.path}
                onClick={() => loadWikiPage(page.path)}
                className={`flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
                  currentWikiPage?.path === page.path ? "bg-accent font-medium" : ""
                }`}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{page.title}</span>
                {page.type && (
                  <span className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                    {TYPE_LABELS[page.type] ?? page.type}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {editing && currentWikiPage ? (
          <WikiEditor
            initialContent={currentWikiPage.raw}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        ) : currentWikiPage ? (
          <div className="relative flex-1 overflow-auto h-full">
            <div className="absolute right-4 top-4 z-10">
              <button
                onClick={() => setEditing(true)}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="编辑页面"
              >
                <Pencil className="h-4 w-4" />
              </button>
            </div>
            <div className="max-w-3xl px-8 py-6">
              <WikiReader body={currentWikiPage.body} />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            选择页面查看内容
          </div>
        )}
      </div>
    </div>
  )
}
