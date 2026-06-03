/**
 * Stub for embedding — vector search is a Phase 2 feature.
 */

export async function embedAndIndexPages(
  _projectPath: string,
  _filePaths: string[],
  _config: { enabled: boolean; endpoint: string; apiKey: string; model: string },
): Promise<void> {
  // no-op
}

export async function embedPage(
  _projectPath: string,
  _pageId: string,
  _title: string,
  _content: string,
  _config: { enabled: boolean; endpoint: string; apiKey: string; model: string },
): Promise<void> {
  // no-op
}
