import { Trash2, Play, File, AlertTriangle } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useKbStore } from "@/stores/kb-store"
import { cascadeDeleteSource } from "@/lib/kb-api"

export function FileManager() {
  const { files, deleteFile, triggerIngest, ingesting, currentProject } =
    useKbStore()
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [associatedPages, setAssociatedPages] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  const handleDelete = async (filePath: string) => {
    if (!currentProject) return

    // Find wiki pages that reference this source
    const wikiPages = useKbStore.getState().wikiPages
    const fileName = filePath.split("/").pop() ?? filePath
    const relatedPages = wikiPages.filter((p) => {
      // Check if the page path suggests it's a source summary or derived from this file
      const stem = p.path
        .replace(/\.md$/, "")
        .split("/")
        .pop()
      return (
        p.type === "source" &&
        (stem?.includes(fileName.replace(/\.[^.]+$/, "")) ?? false)
      )
    })

    if (relatedPages.length > 0) {
      setAssociatedPages(relatedPages.map((p) => p.path))
      setConfirmDelete(filePath)
      return
    }

    // No associated pages, do simple delete
    await deleteFile(filePath)
  }

  const handleCascadeDelete = async () => {
    if (!currentProject || !confirmDelete) return
    setLoading(true)
    try {
      await cascadeDeleteSource(currentProject.id, confirmDelete)
      // Refresh file list and wiki pages
      const { listFiles, listWikiPages, getGraph } = await import(
        "@/lib/kb-api"
      )
      const [updatedFiles, wikiPages, graphData] = await Promise.all([
        listFiles(currentProject.id).catch(() => []),
        listWikiPages(currentProject.id).catch(() => []),
        getGraph(currentProject.id).catch(() => null),
      ])
      useKbStore.setState({
        files: updatedFiles,
        wikiPages,
        graphData,
      })
    } catch (err) {
      console.error("[FileManager] cascade delete failed:", err)
    } finally {
      setLoading(false)
      setConfirmDelete(null)
      setAssociatedPages([])
    }
  }

  const handleSimpleDelete = async () => {
    if (!confirmDelete) return
    await deleteFile(confirmDelete)
    setConfirmDelete(null)
    setAssociatedPages([])
  }

  return (
    <div className="p-4">
      {/* Cascade delete confirmation dialog */}
      {confirmDelete && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-amber-500" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                确认删除源文件: {confirmDelete}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                以下 Wiki 页面由此源文件生成，删除后这些页面也将被移除:
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {associatedPages.map((p) => (
                  <span
                    key={p}
                    className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {p}
                  </span>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  className="text-xs h-7"
                  onClick={handleCascadeDelete}
                  disabled={loading}
                >
                  {loading ? "删除中..." : "级联删除"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7"
                  onClick={handleSimpleDelete}
                  disabled={loading}
                >
                  仅删除源文件
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-xs h-7"
                  onClick={() => {
                    setConfirmDelete(null)
                    setAssociatedPages([])
                  }}
                  disabled={loading}
                >
                  取消
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {files.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
          <File className="h-8 w-8" />
          <p>暂无源文件</p>
          <p className="text-xs">点击顶栏"导入"按钮添加文档，然后"编译全部"生成 Wiki 页面</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {files.map((f) => (
            <div
              key={f.path}
              className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-accent"
            >
              <div className="flex items-center gap-2">
                <File className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{f.path}</span>
                <span className="text-xs text-muted-foreground">
                  {(f.size / 1024).toFixed(1)} KB
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => triggerIngest(f.path)}
                  disabled={ingesting}
                  title="编译此文件"
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(f.path)}
                  title="删除"
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
