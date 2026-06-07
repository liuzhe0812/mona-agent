/**
 * File type classification for the preview panel.
 * Stub: minimal implementation to satisfy layout component imports.
 */

export type FileCategory =
  | "markdown"
  | "code"
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "binary"
  | "text"
  | "data"
  | "document"
  | "unknown"

const EXTENSION_MAP: Record<string, FileCategory> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".json": "code",
  ".js": "code",
  ".ts": "code",
  ".tsx": "code",
  ".jsx": "code",
  ".py": "code",
  ".rs": "code",
  ".go": "code",
  ".css": "code",
  ".html": "code",
  ".yaml": "code",
  ".yml": "code",
  ".toml": "code",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".svg": "image",
  ".webp": "image",
  ".mp3": "audio",
  ".wav": "audio",
  ".mp4": "video",
  ".webm": "video",
  ".pdf": "pdf",
}

export function getFileCategory(filePath: string): FileCategory {
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase()
  return EXTENSION_MAP[ext] ?? "unknown"
}

export function isBinary(category: FileCategory): boolean {
  return ["image", "audio", "video", "pdf", "binary"].includes(category)
}

export function isExtractedTextPreviewFile(filePath: string): boolean {
  return filePath.endsWith(".pdf.txt") || filePath.endsWith(".docx.txt")
}

export function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".")
  return lastDot >= 0 ? filePath.substring(lastDot).toLowerCase() : ""
}

const CODE_LANGUAGE_MAP: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".css": "css",
  ".html": "html",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "zsh",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".r": "r",
  ".lua": "lua",
  ".vim": "vim",
}

export function getCodeLanguage(filePath: string): string {
  const ext = getFileExtension(filePath)
  return CODE_LANGUAGE_MAP[ext] ?? ""
}
