/**
 * Notes → Word (.docx) export.
 *
 * Flow:
 *   1. Rasterize every ```mermaid``` block in the markdown to a PNG data
 *      URL via the existing mermaid lib + a canvas. SVGs alone aren't
 *      enough — python-docx can't embed SVG without an external
 *      converter, and we explicitly avoid pulling one in.
 *   2. POST the markdown + mermaid PNGs + vault path to the services
 *      backend, which assembles the .docx via python-docx.
 *   3. Save the binary response via the Tauri save dialog (or a
 *      browser <a download> as fallback).
 */
import { getServicesHttpBase } from "./api";
import { getNotesVaultPath, httpFetch, isTauri } from "./tauri";

const MERMAID_BLOCK_RE = /(^|\n)```mermaid\n([\s\S]*?)\n```/g;

/**
 * Render every mermaid block in ``markdown`` to a PNG data URL.
 * Returns a map keyed by the (untrimmed) source code so the backend
 * can match each ```` ```mermaid ```` block to its image.
 */
async function rasterizeMermaidBlocks(
  markdown: string,
): Promise<Record<string, string>> {
  const blocks: string[] = [];
  for (const m of markdown.matchAll(MERMAID_BLOCK_RE)) {
    const code = m[2];
    if (code && !blocks.includes(code)) {
      blocks.push(code);
    }
  }
  if (blocks.length === 0) return {};

  // Lazy-load mermaid so this code path is free for notes without
  // diagrams. The editor already ships mermaid as a dependency.
  const mermaidMod = await import("mermaid");
  const mermaid = mermaidMod.default;
  mermaid.initialize({
    startOnLoad: false,
    theme: "default",
    securityLevel: "strict",
  });

  const result: Record<string, string> = {};
  for (const code of blocks) {
    try {
      const dataUrl = await renderMermaidToPng(mermaid, code);
      if (dataUrl) result[code] = dataUrl;
    } catch (err) {
      // Best-effort: if a block fails to render, the backend will
      // emit the source as a plain code block instead.
      console.warn("mermaid rasterize failed:", err);
    }
  }
  return result;
}

async function renderMermaidToPng(
  mermaid: typeof import("mermaid").default,
  code: string,
): Promise<string | null> {
  // Render to SVG, then draw onto a canvas to get a PNG.
  const id = `mona-export-${Math.random().toString(36).slice(2, 10)}`;
  const { svg } = await mermaid.render(id, code);

  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const img = await loadImage(svgUrl);
    const scale = 2; // 2x for crisp text in Word.
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.ceil(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

/**
 * Export ``markdown`` as a .docx file, prompting the user for a save
 * location in Tauri or triggering a browser download otherwise.
 *
 * Returns ``true`` if a file was saved, ``false`` if the user
 * cancelled the save dialog.
 */
export async function exportNoteToDocx(
  title: string,
  markdown: string,
): Promise<boolean> {
  // 1) Rasterize mermaid blocks (no-op if there are none).
  const mermaidImages = await rasterizeMermaidBlocks(markdown);

  // 2) Resolve vault path so the backend can find ``assets/...`` images.
  const vaultPath = isTauri() ? await getNotesVaultPath() : null;

  // 3) POST to backend, get .docx bytes back.
  const base = await getServicesHttpBase();
  const res = await httpFetch(`${base}/api/notes/export-docx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      markdown,
      vaultPath,
      mermaidImages,
    }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      // ignore — error body isn't JSON
    }
    throw new Error(msg);
  }
  const blob = await res.blob();

  // 4) Save via Tauri save dialog, or fall back to <a download>.
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const safeName =
      title.trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 64) || "未命名笔记";
    const filePath = await save({
      defaultPath: `${safeName}.docx`,
      filters: [{ name: "Word", extensions: ["docx"] }],
    });
    if (!filePath) return false;
    const buf = new Uint8Array(await blob.arrayBuffer());
    await writeFile(filePath, buf);
    return true;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const safeName =
    title.trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 64) || "未命名笔记";
  link.download = `${safeName}.docx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}
