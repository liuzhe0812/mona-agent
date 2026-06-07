import { useState, useCallback } from "react"
import { Save, X, Eye, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WikiReader } from "./wiki-reader"

interface WikiEditorProps {
  initialContent: string
  onSave: (content: string) => Promise<void>
  onCancel: () => void
}

export function WikiEditor({ initialContent, onSave, onCancel }: WikiEditorProps) {
  const [content, setContent] = useState(initialContent)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await onSave(content)
    } finally {
      setSaving(false)
    }
  }, [content, onSave])

  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "")

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <Button
            variant={preview ? "ghost" : "secondary"}
            size="sm"
            onClick={() => setPreview(false)}
            className="text-xs gap-1 h-7"
          >
            <Pencil className="h-3 w-3" /> 编辑
          </Button>
          <Button
            variant={preview ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setPreview(true)}
            className="text-xs gap-1 h-7"
          >
            <Eye className="h-3 w-3" /> 预览
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} className="text-xs h-7">
            <X className="mr-1 h-3 w-3" /> 取消
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving} className="text-xs h-7">
            <Save className="mr-1 h-3 w-3" /> {saving ? "保存中..." : "保存"}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {preview ? (
          <div className="max-w-3xl px-8 py-6">
            <WikiReader body={body} />
          </div>
        ) : (
          <textarea
            className="h-full w-full resize-none border-0 bg-transparent p-4 font-mono text-sm focus:outline-none"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        )}
      </div>
    </div>
  )
}
