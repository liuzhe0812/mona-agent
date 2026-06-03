/**
 * Stub for extract-source-images — image extraction is a Phase 2 feature.
 * These functions are no-ops that return empty results.
 */

export interface SavedImage {
  absPath: string
  relPath: string
  fileName: string
  page: number | null
  sha256?: string
}

export async function extractAndSaveSourceImages(
  _projectPath: string,
  _sourcePath: string,
  _sourceSummarySlug: string,
): Promise<SavedImage[]> {
  return []
}

export async function extractAndSaveMarkdownImages(
  _projectPath: string,
  _sourcePath: string,
  _content: string,
  _sourceSummarySlug: string,
): Promise<SavedImage[]> {
  return []
}

export function buildImageMarkdownSection(
  images: { relPath: string; page: number | null; sha256?: string }[],
  _captionsBySha?: Map<string, string>,
): string {
  if (images.length === 0) return ""
  const lines = images
    .filter((img) => img.relPath)
    .map((img) => `![](${img.relPath})`)
  return lines.length > 0 ? `\n\n## Embedded Images\n\n${lines.join("\n")}\n` : ""
}
