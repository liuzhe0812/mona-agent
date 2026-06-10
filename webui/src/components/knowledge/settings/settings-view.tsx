import { Cpu } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useKbStore, type EmbedDraft } from "@/stores/kb-store"

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

/** Embedding settings panel for the right-side Sheet. */
export function EmbedSettingsCard() {
  const draft = useKbStore((s) => s.embedDraft)
  const setEmbedDraft = useKbStore((s) => s.setEmbedDraft)

  const updateDraft = <K extends keyof EmbedDraft>(key: K, value: EmbedDraft[K]) => {
    setEmbedDraft({ ...draft, [key]: value })
  }

  const applyPreset = (key: string) => {
    const preset = PRESETS[key]
    if (!preset) return
    setEmbedDraft({ ...draft, ...preset, enabled: true })
  }

  return (
    <div className="space-y-5">
      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">启用语义搜索</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            所有知识库共用此配置
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

      {/* Quick presets */}
      <div>
        <p className="text-xs font-medium text-muted-foreground">快捷配置</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {[
            { key: "openai", label: "OpenAI", desc: "text-embedding-3-small" },
            { key: "ollama", label: "Ollama 本地", desc: "nomic-embed-text" },
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

      {/* Config fields */}
      <div className="space-y-3">
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
    </div>
  )
}
