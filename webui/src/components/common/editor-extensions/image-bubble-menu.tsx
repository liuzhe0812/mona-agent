import type { Editor } from "@tiptap/react";
import { RotateCcw, Trash2, Link, Type } from "lucide-react";
import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ImageBubbleMenuProps {
  editor: Editor;
}

interface ImageInfo {
  src: string;
  alt: string;
  pos: number;
  rect: DOMRect;
  width: number | null;
  height: number | null;
}

type EditMode = "none" | "alt" | "src";

function parseImageDimension(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?(?:px)?$/i.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed.replace(/px$/i, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function ImageBubbleMenu({ editor }: ImageBubbleMenuProps) {
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [editMode, setEditMode] = useState<EditMode>("none");
  const [altText, setAltText] = useState("");
  const [srcText, setSrcText] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const isClickingMenu = useRef(false);

  const handleImageClick = useCallback((event: MouseEvent) => {
    if (isClickingMenu.current) return;
    const target = event.target as HTMLElement;
    const dom = target.closest("img");
    if (!dom) return;

    // 通过 data-resize-container 找到外层容器，避免拖动 handle 时触发图片点击
    const resizeContainer = target.closest("[data-resize-container]");
    if (resizeContainer && target !== dom && !resizeContainer.contains(dom)) return;

    const rect = dom.getBoundingClientRect();
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") {
        const nodeSrc = node.attrs.src || "";
        const domSrc = dom.src;
        const matches = nodeSrc === domSrc || (nodeSrc && domSrc.includes(nodeSrc));
        if (matches) {
          editor.chain().setNodeSelection(pos).run();
          setImageInfo({
            src: node.attrs.src,
            alt: node.attrs.alt || "",
            pos,
            rect,
            width: parseImageDimension(node.attrs.width),
            height: parseImageDimension(node.attrs.height),
          });
          setAltText(node.attrs.alt || "");
          setSrcText(node.attrs.src || "");
          setEditMode("none");
          return false;
        }
      }
    });
  }, [editor]);

  const saveAltText = useCallback(() => {
    if (imageInfo) {
      editor.chain().setNodeSelection(imageInfo.pos).updateAttributes("image", { alt: altText }).run();
      setImageInfo((prev) => (prev ? { ...prev, alt: altText } : null));
    }
    setEditMode("none");
  }, [editor, imageInfo, altText]);

  const saveSrc = useCallback(() => {
    if (imageInfo && srcText.trim()) {
      editor.chain().setNodeSelection(imageInfo.pos).updateAttributes("image", { src: srcText.trim() }).run();
      setImageInfo((prev) => (prev ? { ...prev, src: srcText.trim() } : null));
    }
    setEditMode("none");
  }, [editor, imageInfo, srcText]);

  const resetSize = useCallback(() => {
    if (imageInfo) {
      editor.chain().setNodeSelection(imageInfo.pos).updateAttributes("image", { width: null, height: null }).run();
      setImageInfo((prev) => (prev ? { ...prev, width: null, height: null } : null));
    }
  }, [editor, imageInfo]);

  const deleteImage = useCallback(() => {
    if (imageInfo) {
      editor.chain().focus().deleteRange({ from: imageInfo.pos, to: imageInfo.pos + 1 }).run();
    }
    setImageInfo(null);
    setEditMode("none");
  }, [editor, imageInfo]);

  const handleMenuClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    isClickingMenu.current = true;
    setTimeout(() => {
      isClickingMenu.current = false;
    }, 100);
  }, []);

  const handleClickOutside = useCallback((event: MouseEvent) => {
    const target = event.target as HTMLElement;
    if (menuRef.current?.contains(target)) return;
    if (target.closest("img")) return;
    if (target.closest("[data-resize-container]")) return;
    setImageInfo(null);
    setEditMode("none");
  }, []);

  useEffect(() => {
    const editorElement = document.querySelector(".ProseMirror");
    if (editorElement) {
      editorElement.addEventListener("click", handleImageClick as EventListener);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      if (editorElement) {
        editorElement.removeEventListener("click", handleImageClick as EventListener);
      }
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [handleImageClick, handleClickOutside]);

  if (!imageInfo) return null;

  // 找到最近的 relative/absolute 定位祖先（ImageBubbleMenu 渲染在这里面）
  const editorWrapper = document.querySelector(".ProseMirror")?.closest(".relative, [style*='position: relative']");
  const wrapperBounds = editorWrapper?.getBoundingClientRect();

  // 菜单相对 editorWrapper 定位（editorWrapper 是 relative 定位父容器）
  const imageCenterX = wrapperBounds
    ? imageInfo.rect.left + imageInfo.rect.width / 2 - wrapperBounds.left
    : imageInfo.rect.left + imageInfo.rect.width / 2;

  // 菜单顶部在图片正上方 8px
  const relativeTop = wrapperBounds
    ? imageInfo.rect.top - wrapperBounds.top - 8
    : imageInfo.rect.top - 8;

  return (
    <div
      ref={menuRef}
      className="absolute z-50"
      style={{ top: relativeTop, left: imageCenterX, transform: "translate(-50%, -100%)" }}
    >
      <div
        className="flex items-center gap-1 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        onClick={handleMenuClick}
        onMouseDown={(e) => e.preventDefault()}
      >
        {editMode === "none" && (
          <>
            <Button type="button" variant="ghost" size="icon" onClick={() => { setEditMode("src"); }} title="编辑地址">
              <Link className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={() => { setEditMode("alt"); }} title="编辑替代文本">
              <Type className="h-4 w-4" />
            </Button>

            <div className="mx-0.5 h-5 w-px bg-border" />

            <Button type="button" variant="ghost" size="icon" onClick={resetSize} title="重置尺寸">
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button type="button" variant="destructive" size="icon" onClick={deleteImage} title="删除">
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}

        {editMode === "alt" && (
          <div className="flex items-center gap-1 px-1">
            <Type className="h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="替代文本"
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveAltText();
                else if (e.key === "Escape") setEditMode("none");
              }}
              onFocus={(e) => e.target.select()}
              className="w-40"
              autoFocus
            />
            <Button type="button" variant="ghost" size="sm" onClick={saveAltText}>确认</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditMode("none")}>取消</Button>
          </div>
        )}

        {editMode === "src" && (
          <div className="flex items-center gap-1 px-1">
            <Link className="h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="图片地址"
              value={srcText}
              onChange={(e) => setSrcText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveSrc();
                else if (e.key === "Escape") setEditMode("none");
              }}
              onFocus={(e) => e.target.select()}
              className="w-60"
              autoFocus
            />
            <Button type="button" variant="ghost" size="sm" onClick={saveSrc}>确认</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditMode("none")}>取消</Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ImageBubbleMenu;
