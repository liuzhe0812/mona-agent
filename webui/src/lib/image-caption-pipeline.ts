/**
 * Stub for image-caption-pipeline — image captioning is a Phase 2 feature.
 */

export interface CaptionResult {
  enrichedMarkdown: string
  freshCaptions: number
  cachedCaptions: number
  failed: number
}

export async function captionMarkdownImages(
  _projectPath: string,
  content: string,
  _llmConfig: unknown,
  _options?: {
    signal?: AbortSignal
    shouldCaption?: (url: string) => boolean
    urlToAbsPath?: (url: string) => string
    concurrency?: number
    onProgress?: (done: number, total: number) => void
  },
): Promise<CaptionResult> {
  return {
    enrichedMarkdown: content,
    freshCaptions: 0,
    cachedCaptions: 0,
    failed: 0,
  }
}

export async function loadCaptionCache(
  _projectPath: string,
): Promise<Map<string, string>> {
  return new Map()
}
