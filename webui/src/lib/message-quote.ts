import type { SendImage } from "@/hooks/useMonaStream";
import i18n from "@/i18n";
import { encodeImage } from "@/lib/imageEncode";
import type { MessageQuoteDraft, UIMessage } from "@/lib/types";

type QuotedImage = NonNullable<MessageQuoteDraft["image"]>;
const MAX_QUOTED_IMAGE_BYTES = 32 * 1024 * 1024;

export function draftMessageQuote(message: UIMessage, author: string, image?: QuotedImage): MessageQuoteDraft | null {
  const content = (message.role === "user" ? message.displayContent ?? message.content : message.content).trim();
  if (content) return { author, content };
  if (!image) return null;
  const name = image.name?.split(/[\\/]/).pop()?.trim();
  const label = i18n.t("message.imageAttachment");
  return { author, content: name ? `${label} · ${name}` : label, image: { url: image.url, name } };
}

export async function loadQuotedImage(image: QuotedImage, signal: AbortSignal): Promise<SendImage> {
  const response = await fetch(image.url, { signal });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_QUOTED_IMAGE_BYTES) {
    throw new Error("Could not load quoted image");
  }
  const blob = await response.blob();
  if (!blob.size || blob.size > MAX_QUOTED_IMAGE_BYTES) throw new Error("Invalid quoted image size");
  signal.throwIfAborted();
  const file = new File([blob], image.name || "image", { type: blob.type });
  const encoded = await encodeImage(file);
  if (!encoded.ok) throw new Error("Could not prepare quoted image");
  return {
    media: { data_url: encoded.dataUrl, name: file.name },
    preview: { url: encoded.dataUrl, name: file.name },
  };
}
