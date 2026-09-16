import type { ProfileArtifact } from "@/lib/profile-api";

export function isNamedCategory(label: string): boolean {
  return Boolean(label.trim()) && !["其他", "其它", "other", "others"].includes(label.trim().toLowerCase());
}

const EXTENSIONS: Record<string, string[]> = {
  文档: ["md", "txt", "csv", "tsv", "pdf", "rtf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "ods", "odp"],
  代码: ["py", "rs", "js", "jsx", "ts", "tsx", "json", "xml", "html", "htm", "css", "scss", "sql", "sh", "ps1", "bat", "c", "cpp", "h", "java", "go", "vue", "yaml", "yml", "toml"],
  图像: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tif", "tiff"],
  音频: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "mid", "midi"],
  视频: ["mp4", "webm", "mov", "avi", "mkv", "m4v"],
  压缩包: ["zip", "7z", "rar", "gz", "tar", "bz2", "xz"],
};

export function artifactCategory(artifact: ProfileArtifact): string | null {
  const mime = (artifact.mime ?? "").toLowerCase().split(";", 1)[0].trim();
  if (mime.startsWith("image/")) return "图像";
  if (["text/markdown", "text/plain", "text/csv", "application/pdf", "application/rtf", "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(mime)) return "文档";
  if (mime.startsWith("text/x-") || ["text/javascript", "application/javascript", "application/typescript", "application/json", "application/xml", "text/html", "text/css"].includes(mime)
    || ["python", "rust", "shell", "source-code"].some((token) => mime.includes(token))) return "代码";
  if (mime.startsWith("audio/")) return "音频";
  if (mime.startsWith("video/")) return "视频";
  if (["application/zip", "application/x-7z-compressed", "application/x-rar-compressed", "application/vnd.rar", "application/gzip", "application/x-tar"].includes(mime)) return "压缩包";
  const filename = String(artifact.artifact_ref?.relative_path || artifact.title).toLowerCase();
  const extension = filename.split(".").pop() ?? "";
  return Object.entries(EXTENSIONS).find(([, extensions]) => extensions.includes(extension))?.[0] ?? null;
}
