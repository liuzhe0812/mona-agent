import { useEffect, useId, useRef, useState } from "react";
import { ImageLightbox } from "@/components/ImageLightbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { isProjectReference, projectRelativePath, useMarkdownContext } from "./MarkdownContext";
import { useMarkdownGallery } from "./MarkdownGallery";

export type MarkdownMediaKind = "image" | "audio" | "video" | "file";

function mediaKind(path: string): MarkdownMediaKind | undefined {
  const extension = path.split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  return extension && /^(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(extension) ? "image"
    : extension && /^(mp4|webm|mov|mpeg|mpg|ogv)$/.test(extension) ? "video"
    : extension && /^(mp3|wav|ogg|oga|opus|flac|aac|m4a|weba)$/.test(extension) ? "audio"
    : extension === "pdf" ? "file" : undefined;
}

export function MarkdownMedia({ src, alt = "图片", kind: requestedKind }: {
  src: string; alt?: string; kind?: MarkdownMediaKind;
}) {
  const context = useMarkdownContext();
  const gallery = useMarkdownGallery();
  const imageId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const kind = requestedKind ?? mediaKind(src) ?? "image";
  const [resource, setResource] = useState({ key: "", url: "", error: "" });
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState("");
  const key = `${context?.projectId ?? ""}:${src}`;
  const local = isProjectReference(src);
  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    setFailed(""); setOpen(false);
    if (!local) return;
    const read = async () => {
      try {
        if (!context?.readMedia) throw new Error("无法读取此图片，请打开对应项目。");
        const blob = await context.readMedia(projectRelativePath(src, context.rootPath));
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResource({ key, url: objectUrl, error: "" });
      } catch (error) {
        if (!cancelled) setResource({ key, url: "", error: error instanceof Error ? error.message : "媒体读取失败。" });
      }
    };
    void read();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [key, src, local, context?.readMedia, context?.rootPath]);
  const safeRemote = /^(?:https?:\/\/|data:(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf);base64,)/i.test(src);
  const url = local ? resource.key === key ? resource.url : "" : safeRemote ? src : "";
  const error = failed || (local ? resource.key === key ? resource.error : "" : !safeRemote ? "不支持此媒体地址。" : "");
  useEffect(() => {
    if (gallery && kind === "image" && url && !error && buttonRef.current) {
      return gallery.register(imageId, { image: { url, name: alt }, element: buttonRef.current });
    }
  }, [gallery, kind, url, error, imageId, alt]);
  if (error) return <span role="status" className="not-prose my-3 block rounded-md bg-muted/40 p-3 text-caption text-muted-foreground">{alt} · {error}</span>;
  if (!url) return <span role="status" className="not-prose my-3 block rounded-md bg-muted/40 p-3 text-caption text-muted-foreground">正在加载{alt}…</span>;
  if (kind === "audio") return <audio controls preload="metadata" src={url} aria-label={alt} className="my-3 max-w-full" onError={() => setFailed("音频加载失败。")} />;
  if (kind === "video") return <video controls preload="metadata" src={url} aria-label={alt} className="my-3 max-h-[70vh] max-w-full rounded-lg" onError={() => setFailed("视频加载失败。")} />;
  if (kind === "file") return <a className="my-3 inline-flex text-primary underline" href={url} download={alt} target="_blank" rel="noopener noreferrer">下载 {alt}</a>;
  return <span className="not-prose my-3 block max-w-full">
    <button ref={buttonRef} type="button" className="block max-w-full cursor-zoom-in overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`查看图片：${alt}`} onClick={() => gallery ? gallery.open(imageId) : setOpen(true)}>
      <img src={url} alt={alt} loading="lazy" decoding="async" className="m-0 max-h-[60vh] max-w-full object-contain" onError={() => setFailed("图片加载失败。")} />
    </button>
    {!gallery && <ImageLightbox images={[{ url, name: alt }]} index={open ? 0 : null} onIndexChange={() => {}} onOpenChange={setOpen} />}
  </span>;
}

export function ProjectFileLink({ path, children }: { path: string; children: React.ReactNode }) {
  const context = useMarkdownContext();
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const kind = mediaKind(path);
  const open = async () => {
    setError("");
    try {
      if (kind) { projectRelativePath(path, context?.rootPath); setPreview(true); return; }
      if (!context?.openFile) throw new Error("无法打开文件，请先选择项目。");
      await context.openFile(projectRelativePath(path, context.rootPath));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "文件打开失败。"); }
  };
  return <span>
    <Button variant="link" className="inline h-auto whitespace-normal p-0 font-[inherit] text-[inherit]" title={path} onClick={() => void open()}>{children}</Button>
    {error && <span role="alert" className="ml-2 text-caption text-destructive">{error}</span>}
    {kind && <Dialog open={preview} onOpenChange={setPreview}><DialogContent className="max-h-[90vh] max-w-4xl overflow-auto">
      <DialogHeader><DialogTitle>文件预览</DialogTitle><DialogDescription className="break-all">{path}</DialogDescription></DialogHeader>
      {preview && <MarkdownMedia src={path} kind={kind} alt={path.split(/[\\/]/).pop() ?? "附件"} />}
    </DialogContent></Dialog>}
  </span>;
}
