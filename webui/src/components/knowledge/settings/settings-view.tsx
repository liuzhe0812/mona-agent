import { useEffect, useState } from "react"
import { Loader2, Cpu } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useKbStore, type EmbedDraft } from "@/stores/kb-store"
import type { EmbedStatus } from "@/lib/kb-api"

const PRESETS: Record<string, Partial<EmbedDraft>> = {
  openai: {
    endpoint: "https://api.openai.com/v1/embeddings",
    model: "text-embedding-3-small",
  },
  ollama: {
    endpoint: "http://localhost:11434/api/embeddings",
    model: "nomic-embed-text",
  },
  siliconflow: {
    endpoint: "https://api.siliconflow.cn/v1/embeddings",
    model: "BAAI/bge-m3",
  },
  google: {
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent",
    model: "gemini-embedding-001",
  },
}

export function SettingsView() {
  const currentProject = useKbStore((s) => s.currentProject)
  const embedStatus = useKbStore((s) => s.embedStatus)
  const embedding = useKbStore((s) => s.embedding)
  const loadEmbedStatus = useKbStore((s) => s.loadEmbedStatus)
  const triggerEmbedAction = useKbStore((s) => s.triggerEmbed)
  const draft = useKbStore((s) => s.embedDraft)
  const setEmbedDraft = useKbStore((s) => s.setEmbedDraft)
  const [embedResult, setEmbedResult] = useState<{
    indexed: number
    failed: number
  } | null>(null)
  const [embedError, setEmbedError] = useState<string | null>(null)

  useEffect(() => {
    if (currentProject) {
      loadEmbedStatus()
    }
  }, [currentProject, loadEmbedStatus])

  const updateDraft = <K extends keyof EmbedDraft>(key: K, value: EmbedDraft[K]) => {
    setEmbedDraft({ ...draft, [key]: value })
  }

  const applyPreset = (key: string) => {
    const preset = PRESETS[key]
    if (!preset) return
    setEmbedDraft({ ...draft, ...preset, enabled: true })
  }

  const handleTriggerEmbed = async () => {
    setEmbedError(null)
    setEmbedResult(null)
    try {
      const result = await triggerEmbedAction({
        enabled: draft.enabled,
        endpoint: draft.endpoint,
        apiKey: draft.apiKey,
        model: draft.model,
        outputDimensionality: draft.outputDimensionality
          ? Number(draft.outputDimensionality)
          : undefined,
        maxChunkChars: draft.maxChunkChars ? Number(draft.maxChunkChars) : undefined,
        overlapChunkChars: draft.overlapChunkChars
          ? Number(draft.overlapChunkChars)
          : undefined,
      })
      setEmbedResult(result ?? null)
    } catch (err) {
      setEmbedError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
        <h2 className="text-lg font-semibold">Embedding 设置</h2>

        {/* Enable toggle */}
        <div className="rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">启用语义搜索</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                开启后将使用向量嵌入进行语义搜索，支持混合检索模式
              </p>
            </div>
            <button
              type="button"
              onClick={() => updateDraft("enabled", !draft.enabled)}
              className={`inline-flex h-8 min-w-[64px] items-center justify-center rounded-full px-3 text-xs font-medium transition-colors ${
                draft.enabled
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {draft.enabled ? "开" : "关"}
            </button>
          </div>
        </div>

        {/* Quick presets */}
        <div className="rounded-xl border bg-card p-4">
          <p className="text-sm font-medium">快捷配置</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            选择预设方案，自动填充 Endpoint 和 Model
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              { key: "openai", label: "OpenAI", desc: "text-embedding-3-small" },
              { key: "ollama", label: "Ollama 本地", desc: "nomic-embed-text，零成本" },
              { key: "siliconflow", label: "SiliconFlow", desc: "BAAI/bge-m3" },
              { key: "google", label: "Google", desc: "gemini-embedding-001" },
            ].map(({ key, label, desc }) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key)}
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
              >
                {key === "ollama" && <Cpu className="h-3.5 w-3.5" />}
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground">{desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Embedding config fields */}
        <div className="space-y-4 rounded-xl border bg-card p-4">
          <p className="text-sm font-medium">Embedding 模型配置</p>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Endpoint</span>
            <Input
              value={draft.endpoint}
              onChange={(e) => updateDraft("endpoint", e.target.value)}
              placeholder="https://api.openai.com/v1/embeddings"
              className="h-8 text-[13px]"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">API Key</span>
            <Input
              type="password"
              value={draft.apiKey}
              onChange={(e) => updateDraft("apiKey", e.target.value)}
              placeholder={draft.endpoint.includes("ollama") ? "本地模型无需 API Key" : "sk-..."}
              className="h-8 text-[13px]"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Model</span>
            <Input
              value={draft.model}
              onChange={(e) => updateDraft("model", e.target.value)}
              placeholder="text-embedding-3-small"
              className="h-8 text-[13px]"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Output Dimensionality（可选）
            </span>
            <Input
              type="number"
              value={draft.outputDimensionality}
              onChange={(e) => updateDraft("outputDimensionality", e.target.value)}
              placeholder="留空使用模型默认值"
              className="h-8 w-40 text-[13px]"
            />
          </label>
        </div>

        {/* Chunking config */}
        <div className="space-y-4 rounded-xl border bg-card p-4">
          <p className="text-sm font-medium">分块配置</p>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Max Chunk Chars（每块最大字符数）
            </span>
            <Input
              type="number"
              value={draft.maxChunkChars}
              onChange={(e) => updateDraft("maxChunkChars", e.target.value)}
              placeholder="1000"
              className="h-8 w-40 text-[13px]"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Overlap Chars（重叠字符数）
            </span>
            <Input
              type="number"
              value={draft.overlapChunkChars}
              onChange={(e) => updateDraft("overlapChunkChars", e.target.value)}
              placeholder="200"
              className="h-8 w-40 text-[13px]"
            />
          </label>
        </div>

        {/* Index button */}
        <div className="rounded-xl border bg-card p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">索引全部页面</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                对知识库中所有 Wiki 页面执行 embedding 索引
              </p>
            </div>
            <Button
              size="sm"
              onClick={handleTriggerEmbed}
              disabled={embedding || !draft.enabled}
              className="h-8 gap-1 px-3 text-xs"
            >
              {embedding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {embedding ? "索引中..." : "开始索引"}
            </Button>
          </div>
        </div>

        {/* Status */}
        {embedStatus && <EmbedStatusCard status={embedStatus} />}

        {/* Result */}
        {embedResult && (
          <div className="rounded-xl border bg-emerald-500/10 p-4">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
              索引完成：{embedResult.indexed} 个成功，{embedResult.failed} 个失败
            </p>
          </div>
        )}

        {/* Error */}
        {embedError && (
          <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-4">
            <p className="text-sm font-medium text-destructive">{embedError}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function EmbedStatusCard({ status }: { status: EmbedStatus }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm font-medium">Embedding 状态</p>
      <div className="mt-2 space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">已索引块数</span>
          <span className="font-medium">{status.chunkCount}</span>
        </div>
        {status.lastError && (
          <div className="flex items-start justify-between gap-4 text-xs">
            <span className="text-muted-foreground">最近错误</span>
            <span className="max-w-[60%] text-right text-destructive">{status.lastError}</span>
          </div>
        )}
      </div>
    </div>
  )
}
