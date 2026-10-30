import { useCallback, useEffect, useRef, useState } from "react";

import { encodeImage, type EncodeFailure } from "@/lib/imageEncode";

/** Lifecycle stages of one attachment:
 *
 * - ``encoding``  — posted to the Worker; chip shows a spinner
 * - ``ready``     — ``dataUrl`` available; safe to submit
 * - ``error``     — validation / decode failure; chip shows inline error
 */
export type AttachmentStatus = "encoding" | "ready" | "error";

export interface AttachedImage {
  id: string;
  file: File;
  /** Optimistic ``blob:`` preview URL; revoked on ``remove`` / ``clear`` /
   * unmount. */
  previewUrl: string;
  status: AttachmentStatus;
  /** Populated when ``status === "ready"``. */
  dataUrl?: string;
  /** Size of the final encoded payload (base64 bytes decoded). */
  encodedBytes?: number;
  /** Whether the Worker re-encoded the image to hit the size budget. */
  normalized?: boolean;
  /** Human-readable validation / encoding error when ``status === "error"``. */
  error?: AttachmentError;
}

/** Machine-readable rejection reasons surfaced as inline chip errors.
 *
 * Callers localize these via the ``composer.imageRejected.*`` i18n table. */
export type AttachmentError =
  | "unsupported_type"   // server whitelist excludes this MIME
  | "too_many_images"    // per-message cap (4) reached before enqueue
  | "magic_mismatch"     // extension lies about the real content
  | "decode_failed"      // Worker couldn't decode / re-encode
  | "too_large"          // even after normalization we exceed the budget
  | "io";                // file read failed at the browser layer

export const MAX_IMAGES_PER_MESSAGE = 4;

/** Formats supported by the inline image encoder and server. */
const ACCEPTED_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function isInlineImage(file: File): boolean {
  return ACCEPTED_MIMES.has(file.type);
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as Crypto).randomUUID();
  }
  return `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mapEncodeFailure(reason: EncodeFailure["reason"]): AttachmentError {
  switch (reason) {
    case "invalid_mime":
    case "magic_mismatch":
      return "magic_mismatch";
    case "too_large_after_normalize":
      return "too_large";
    case "io":
      return "io";
    case "decode_failed":
    default:
      return "decode_failed";
  }
}

export interface UseAttachedImagesApi {
  images: AttachedImage[];
  /** Enqueue new files. Returns the list of rejected files so the caller can
   * surface inline errors. Files rejected client-side (wrong MIME, limit) are
   * *not* added to ``images`` — only recoverable encoding failures show up as
   * error chips. */
  enqueue: (files: Iterable<File>) => {
    rejected: Array<{ file: File; reason: AttachmentError }>;
  };
  remove: (id: string) => { nextFocusId: string | null };
  /** Revoke every staged blob URL and drop all attachments. Called after a
   * successful submit — the optimistic bubble holds onto an independent
   * ``data:`` URL so tearing down blob previews here is safe. */
  clear: () => void;
  clearScope: (scope: string) => void;
  /** ``true`` when at least one image is still encoding — Send should wait. */
  encoding: boolean;
  /** ``true`` when we've hit ``MAX_IMAGES_PER_MESSAGE``. */
  full: boolean;
}

/** Manage the lifecycle of images attached to the Composer.
 *
 * Responsibilities in one place:
 *   - validation (MIME whitelist, count cap)
 *   - blob URL creation + revocation
 *   - Worker orchestration
 *   - focus bookkeeping so keyboard delete doesn't strand the user
 */
export function useAttachedImages(scope?: string): UseAttachedImagesApi {
  const key = scope ?? "";
  const [drafts, setDrafts] = useState<Map<string, AttachedImage[]>>(new Map());
  const draftsRef = useRef(drafts);
  const images = drafts.get(key) ?? [];
  const setImages = useCallback((update: AttachedImage[] | ((previous: AttachedImage[]) => AttachedImage[])) => {
    const previous = draftsRef.current.get(key) ?? [];
    const next = typeof update === "function" ? update(previous) : update;
    if (next === previous) return;
    const all = new Map(draftsRef.current);
    if (next.length) all.set(key, next);
    else all.delete(key);
    draftsRef.current = all;
    setDrafts(all);
  }, [key]);

  const setEntry = useCallback((id: string, patch: Partial<AttachedImage>) => {
    setImages((prev) => {
      if (!prev.some((image) => image.id === id)) return prev;
      return prev.map((img) => (img.id === id ? { ...img, ...patch } : img));
    });
  }, [setImages]);

  const enqueue = useCallback(
    (files: Iterable<File>) => {
      const rejected: Array<{ file: File; reason: AttachmentError }> = [];
      const toAdd: AttachedImage[] = [];
      let slot = MAX_IMAGES_PER_MESSAGE - (draftsRef.current.get(key)?.length ?? 0);

      for (const file of files) {
        if (!isInlineImage(file)) {
          rejected.push({ file, reason: "unsupported_type" });
          continue;
        }
        if (slot <= 0) {
          rejected.push({ file, reason: "too_many_images" });
          continue;
        }
        slot -= 1;
        toAdd.push({
          id: uuid(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: "encoding",
        });
      }

      if (toAdd.length > 0) {
        setImages((previous) => [...previous, ...toAdd]);
        // Fire the Worker after the commit so chips render first (good INP).
        for (const entry of toAdd) {
          queueMicrotask(() => {
            encodeImage(entry.file).then(
              (result) => {
                if (result.ok) {
                  setEntry(entry.id, {
                    status: "ready",
                    dataUrl: result.dataUrl,
                    encodedBytes: result.bytes,
                    normalized: result.normalized,
                  });
                } else {
                  setEntry(entry.id, {
                    status: "error",
                    error: mapEncodeFailure(result.reason),
                  });
                }
              },
              () => {
                setEntry(entry.id, {
                  status: "error",
                  error: "decode_failed",
                });
              },
            );
          });
        }
      }
      return { rejected };
    },
    [key, setEntry, setImages],
  );

  const remove = useCallback((id: string) => {
    let nextFocusId: string | null = null;
    setImages((prev) => {
      const idx = prev.findIndex((img) => img.id === id);
      if (idx === -1) return prev;
      const target = prev[idx];
      try {
        URL.revokeObjectURL(target.previewUrl);
      } catch {
        // No-op: previewUrl revocation is best-effort.
      }
      const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      // Prefer moving focus to the chip at the same index, else previous.
      const candidate = next[idx] ?? next[idx - 1];
      nextFocusId = candidate?.id ?? null;
      return next;
    });
    return { nextFocusId };
  }, [setImages]);

  const clearScope = useCallback((draftScope: string) => {
    const previous = draftsRef.current.get(draftScope);
    if (!previous) return;
    for (const image of previous) {
      try { URL.revokeObjectURL(image.previewUrl); } catch { /* Preview cleanup is best-effort. */ }
    }
    const next = new Map(draftsRef.current);
    next.delete(draftScope);
    draftsRef.current = next;
    setDrafts(next);
  }, []);
  const clear = useCallback(() => clearScope(key), [clearScope, key]);

  // Final safety net: revoke any outstanding blob URLs on unmount. Safe
  // under StrictMode double-invoke because revoked blob URLs are only
  // referenced from in-hook chip state, which is rebuilt on remount.
  useEffect(() => {
    return () => {
      for (const img of [...draftsRef.current.values()].flat()) {
        try {
          URL.revokeObjectURL(img.previewUrl);
        } catch {
          // best-effort cleanup on unmount
        }
      }
      draftsRef.current = new Map();
    };
  }, []);

  const encoding = images.some((img) => img.status === "encoding");
  const full = images.length >= MAX_IMAGES_PER_MESSAGE;

  return { images, enqueue, remove, clear, clearScope, encoding, full };
}
