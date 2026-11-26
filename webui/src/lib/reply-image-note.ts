import { deriveNoteTitle } from "@/lib/note-title";
import { createNoteFromChat } from "@/lib/tauri";

const MAX_NOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

export async function saveReplyImageAsNote(
  url: string,
  name: string | undefined,
  fallbackTitle: string,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("图片读取失败");

  const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const extension = Object.hasOwn(IMAGE_EXTENSIONS, mime) ? IMAGE_EXTENSIONS[mime] : undefined;
  const contentLength = response.headers.get("content-length");
  if (!extension) throw new Error("图片格式不受支持");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_NOTE_IMAGE_BYTES)) {
    throw new Error("图片大小超过 10 MiB");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片内容为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_NOTE_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("图片大小超过 10 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error("图片内容为空");

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const data = await new Promise<string>((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = () => resolve(String(fileReader.result));
    fileReader.onerror = () => reject(fileReader.error ?? new Error("图片读取失败"));
    fileReader.readAsDataURL(new Blob([bytes.buffer], { type: mime }));
  });
  const baseName = name?.split(/[\\/]/).pop()?.replace(/\.[a-z0-9]{2,6}$/i, "") ?? "";
  return createNoteFromChat(deriveNoteTitle(baseName, fallbackTitle), "", undefined, { data, extension });
}
