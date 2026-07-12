import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import TiptapImage from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextStyleKit } from "@tiptap/extension-text-style";
import {
  Bold,
  Italic,
  Strikethrough,
  List,
  ListOrdered,
  Link as LinkIcon,
  Image as ImageIcon,
  Undo2,
  Redo2,
  Type,
  Palette,
  Highlighter,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// 邮件正文图片最大显示宽度（px），避免大图撑爆编辑区
const MAX_DISPLAY_WIDTH = 600;

// 字体选项
const FONT_FAMILIES = [
  { label: "默认", value: "" },
  { label: "宋体", value: "'SimSun', '宋体', serif" },
  { label: "黑体", value: "'SimHei', '黑体', sans-serif" },
  { label: "微软雅黑", value: "'Microsoft YaHei', '微软雅黑', sans-serif" },
  { label: "楷体", value: "'KaiTi', '楷体', serif" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', serif" },
  { label: "Courier New", value: "'Courier New', monospace" },
];

// 字号选项（px）
const FONT_SIZES = [
  { label: "默认", value: "0" },
  { label: "12", value: "12" },
  { label: "14", value: "14" },
  { label: "16", value: "16" },
  { label: "18", value: "18" },
  { label: "20", value: "20" },
  { label: "24", value: "24" },
  { label: "28", value: "28" },
  { label: "32", value: "32" },
];

// 文字颜色选项
const TEXT_COLORS = [
  "#000000", "#434343", "#666666", "#999999",
  "#dc2626", "#ea580c", "#d97706", "#65a30d",
  "#16a34a", "#0891b2", "#2563eb", "#7c3aed",
  "#c026d3", "#db2777", "#ffffff",
];

// 背景色选项
const HIGHLIGHT_COLORS = [
  "#fef08a", "#fde047", "#fca5a5", "#fdba74",
  "#86efac", "#67e8f9", "#93c5fd", "#c4b5fd",
  "#f9a8d4", "#e5e7eb", "#ffffff", "transparent",
];

// Image 扩展：Tiptap 3 内置 width/height 属性，无需自定义
const EmailImage = TiptapImage.configure({
  inline: false,
  allowBase64: true,
  HTMLAttributes: { class: "max-w-full h-auto rounded my-2" },
});

export interface EmailRichEditorHandle {
  /** 打开文件对话框选择图片并插入 */
  insertImage: () => void;
  /** 直接从 data URL 插入图片（用于截屏/粘贴） */
  insertImageFromDataUrl: (dataUrl: string) => void;
  /** 动态设置编辑器 HTML 内容（用于异步加载后替换内容） */
  setHtml: (html: string) => void;
}

export interface EmailRichEditorProps {
  initialValue?: string;
  /** 直接用 HTML 初始化内容，优先于 initialValue */
  initialHtml?: string;
  onChange: (value: { html: string; text: string }) => void;
  placeholder?: string;
  className?: string;
  /** 签名 HTML（在编辑器底部预览，发送时由调用方拼接到正文末尾） */
  signatureHtml?: string | null;
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${escaped}</div>`;
}

/**
 * 将编辑器输出的 HTML 转换为邮件客户端兼容的 HTML。
 *
 * 主要解决两个问题：
 * 1. Tiptap 的 ListItem content 为 "paragraph block*"，会在 <li> 内生成 <p> 包裹。
 *    邮件客户端（Gmail/Outlook）中 <p> 的块级 + margin 会导致序号与内容分两行。
 *    → 去掉 <li> 内的 <p> 标签，只保留内容。
 * 2. 邮件客户端常剥离外部 CSS，<ol>/<ul> 需要内联 list-style-type 才能显示序号/圆点。
 *    → 给 <ol>/<ul>/<li> 添加内联样式。
 */
function sanitizeHtmlForEmail(html: string): string {
  // 去掉 <li> 内的 <p>...</p> 包裹，保留内部内容（含内联样式）
  // 匹配 <li ...><p ...>内容</p></li>，处理多行内容
  let result = html.replace(
    /<li([^>]*)>\s*<p([^>]*)>([\s\S]*?)<\/p>\s*<\/li>/gi,
    (_m, liAttrs: string, _pAttrs: string, content: string) => {
      return `<li${liAttrs}>${content}</li>`;
    },
  );
  // 给 <ol> 加内联样式确保显示序号
  result = result.replace(
    /<ol([^>]*)>/gi,
    (_m, attrs: string) => {
      // 若已有 style 则合并，否则添加
      if (/style\s*=/i.test(attrs)) {
        return `<ol${attrs.replace(/style\s*=\s*"([^"]*)"/i, 'style="$1; list-style-type: decimal; margin-left: 24px; padding-left: 6px;"')}>`;
      }
      return `<ol${attrs} style="list-style-type: decimal; margin-left: 24px; padding-left: 6px;">`;
    },
  );
  // 给 <ul> 加内联样式确保显示圆点
  result = result.replace(
    /<ul([^>]*)>/gi,
    (_m, attrs: string) => {
      if (/style\s*=/i.test(attrs)) {
        return `<ul${attrs.replace(/style\s*=\s*"([^"]*)"/i, 'style="$1; list-style-type: disc; margin-left: 24px; padding-left: 6px;"')}>`;
      }
      return `<ul${attrs} style="list-style-type: disc; margin-left: 24px; padding-left: 6px;">`;
    },
  );
  return result;
}

/**
 * 根据设备 DPI 计算图片的显示宽度。
 * - HiDPI 屏幕上按 dpr 缩放，避免截图过大
 * - 始终限制在 MAX_DISPLAY_WIDTH 以内，保证邮件正文排版
 * - 返回 null 表示无法获取尺寸，由 CSS max-w-full 兜底
 */
function computeDisplayWidth(dataUrl: string): Promise<number | null> {
  const dpr = window.devicePixelRatio || 1;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth <= 0) {
        resolve(null);
        return;
      }
      const scaled = Math.round(img.naturalWidth / dpr);
      resolve(Math.min(scaled, MAX_DISPLAY_WIDTH));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export const EmailRichEditor = forwardRef<EmailRichEditorHandle, EmailRichEditorProps>(
  function EmailRichEditor(
    { initialValue = "", initialHtml, onChange, placeholder = "邮件正文...", className, signatureHtml },
    ref,
  ) {
    // 用 ref 保存最新的 onChange 和 editor，避免闭包陷阱和频繁 setOptions
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const editorRef = useRef<Editor | null>(null);

    // 稳定 extensions 数组，只在 placeholder 变化时重建
    // 注意：StarterKit 在 Tiptap 3 已内置 Link，需显式禁用以避免与下方自定义 Link 冲突
    const extensions = useMemo(
      () => [
        StarterKit.configure({
          heading: false,
          codeBlock: false,
          link: false,
          blockquote: {
            HTMLAttributes: {
              class: "border-l-2 border-border pl-3 italic text-muted-foreground",
            },
          },
        }),
        TextStyleKit,
        EmailImage,
        Link.configure({
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { class: "text-[#2f7fca] underline underline-offset-2" },
        }),
        Placeholder.configure({ placeholder }),
      ],
      [placeholder],
    );

    // 稳定 editorProps，避免每次渲染都触发 setOptions
    const editorProps = useMemo(
      () => ({
        attributes: {
          class: "email-prosemirror min-h-full outline-none",
        },
        handlePaste: (_view: unknown, event: ClipboardEvent) => {
          const clipboardData = event.clipboardData;
          if (!clipboardData) return false;
          for (let i = 0; i < clipboardData.items.length; i++) {
            const item = clipboardData.items[i];
            if (item.type.startsWith("image/")) {
              const file = item.getAsFile();
              if (file) {
                const reader = new FileReader();
                reader.onload = async () => {
                  const dataUrl = reader.result as string;
                  const displayWidth = await computeDisplayWidth(dataUrl);
                  editorRef.current
                    ?.chain()
                    .focus()
                    .setImage({
                      src: dataUrl,
                      ...(displayWidth != null ? { width: displayWidth } : {}),
                    })
                    .run();
                };
                reader.readAsDataURL(file);
                event.preventDefault();
                return true;
              }
            }
          }
          return false;
        },
      }),
      [],
    );

    // 稳定 onUpdate 回调
    const handleUpdate = useMemo(
      () => ({ editor: ed }: { editor: Editor }) => {
        // 对输出 HTML 做邮件兼容处理：去掉 li 内的 p 包裹、加列表内联样式
        onChangeRef.current({ html: sanitizeHtmlForEmail(ed.getHTML()), text: ed.getText() });
      },
      [],
    );

    const editor = useEditor({
      extensions,
      content: initialHtml ?? (initialValue ? textToHtml(initialValue) : ""),
      editorProps,
      onUpdate: handleUpdate,
    });

    useEffect(() => {
      editorRef.current = editor;
    }, [editor]);

    // 当 initialHtml 变化时（如回复邮件异步加载原邮件后），重新设置编辑器内容
    // 并把光标定位到文档开头（Foxmail 风格：顶部输入回复内容）
    useEffect(() => {
      if (editor && initialHtml !== undefined) {
        editor.commands.setContent(initialHtml);
        editor.chain().focus().setTextSelection(0).run();
      }
    }, [editor, initialHtml]);

    const insertImageFromDataUrl = async (dataUrl: string) => {
      if (!editor) return;
      const displayWidth = await computeDisplayWidth(dataUrl);
      editor
        .chain()
        .focus()
        .setImage({ src: dataUrl, ...(displayWidth != null ? { width: displayWidth } : {}) })
        .run();
    };

    const insertImage = async () => {
      if (!editor) return;
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [
            { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
          ],
        });
        if (!selected || Array.isArray(selected)) return;
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const data = await readFile(selected);
        const ext = selected.split(".").pop() || "png";
        const base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
        const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
        const dataUrl = `data:${mime};base64,${base64}`;
        await insertImageFromDataUrl(dataUrl);
      } catch (err) {
        console.warn("[EmailRichEditor] insert image failed:", err);
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        insertImage,
        insertImageFromDataUrl,
        setHtml: (html: string) => {
          editor?.chain().focus().setContent(html).setTextSelection(0).run();
        },
      }),
      [editor],
    );

    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <EditorToolbar editor={editor} onInsertImage={insertImage} />
        <div className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-3">
          <EditorContent
            editor={editor}
            className="h-full text-[14px] leading-[1.7] text-foreground [&_.ProseMirror]:h-full [&_.ProseMirror]:min-h-full [&_.ProseMirror_p]:my-1.5 [&_.ProseMirror_ul]:ml-5 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ol]:ml-5 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_li]:my-0.5 [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:h-auto [&_.ProseMirror_img]:rounded [&_.ProseMirror_a]:text-[#2f7fca] [&_.ProseMirror_a]:underline"
          />
          {signatureHtml && (
            <div
              className="mt-4 border-t border-gray-200 pt-3 text-[14px] leading-[1.7] text-gray-600 [&_a]:text-[#2f7fca] [&_a]:underline [&_img]:max-w-full"
              contentEditable={false}
              dangerouslySetInnerHTML={{ __html: `<br/>${signatureHtml}` }}
            />
          )}
        </div>
      </div>
    );
  },
);

function EditorToolbar({
  editor,
  onInsertImage,
}: {
  editor: Editor | null;
  onInsertImage: () => void;
}) {
  const [active, setActive] = useState({
    bold: false,
    italic: false,
    strike: false,
    bulletList: false,
    orderedList: false,
    link: false,
  });
  const [currentFont, setCurrentFont] = useState("");
  const [currentFontSize, setCurrentFontSize] = useState("0");

  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      setActive({
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        strike: editor.isActive("strike"),
        bulletList: editor.isActive("bulletList"),
        orderedList: editor.isActive("orderedList"),
        link: editor.isActive("link"),
      });
      const attrs = editor.getAttributes("textStyle");
      setCurrentFont(attrs.fontFamily || "");
      const fs = attrs.fontSize || "";
      setCurrentFontSize(fs ? String(fs).replace(/px$/, "") : "0");
    };
    editor.on("selectionUpdate", handler);
    editor.on("update", handler);
    handler();
    return () => {
      editor.off("selectionUpdate", handler);
      editor.off("update", handler);
    };
  }, [editor]);

  const toggleLink = () => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt("输入链接地址");
    if (url) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
  };

  const setFontFamily = (value: string) => {
    if (!editor) return;
    if (value) {
      editor.chain().focus().setFontFamily(value).run();
    } else {
      editor.chain().focus().unsetFontFamily().run();
    }
  };

  const setFontSize = (value: string) => {
    if (!editor) return;
    if (value === "0") {
      editor.chain().focus().unsetFontSize().run();
    } else {
      editor.chain().focus().setFontSize(`${value}px`).run();
    }
  };

  const setTextColor = (color: string) => {
    if (!editor) return;
    editor.chain().focus().setColor(color).run();
  };

  const setHighlight = (color: string) => {
    if (!editor) return;
    if (color === "transparent") {
      editor.chain().focus().unsetBackgroundColor().run();
    } else {
      editor.chain().focus().setBackgroundColor(color).run();
    }
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/60 bg-muted/25 px-2">
      {/* 字体选择 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
            disabled={!editor}
          >
            <Type className="h-3.5 w-3.5" />
            <span className="max-w-[60px] truncate">
              {FONT_FAMILIES.find((f) => f.value === currentFont)?.label || "字体"}
            </span>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[140px]">
          {FONT_FAMILIES.map((font) => (
            <DropdownMenuItem
              key={font.label}
              onClick={() => setFontFamily(font.value)}
              className="text-[12px]"
              style={font.value ? { fontFamily: font.value } : undefined}
            >
              {font.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 字号选择 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
            disabled={!editor}
          >
            <span className="max-w-[30px] truncate">
              {currentFontSize === "0" ? "字号" : currentFontSize}
            </span>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[80px]">
          {FONT_SIZES.map((size) => (
            <DropdownMenuItem
              key={size.value}
              onClick={() => setFontSize(size.value)}
              className="text-[12px]"
            >
              {size.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="mx-1 h-4 w-px bg-border/70" />

      <ToolbarButton
        label="加粗"
        active={active.bold}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="斜体"
        active={active.italic}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="删除线"
        active={active.strike}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolbarButton>

      <span className="mx-1 h-4 w-px bg-border/70" />

      {/* 文字颜色 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="文字颜色"
            aria-label="文字颜色"
            disabled={!editor}
            className="h-7 w-7 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Palette className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[160px]">
          <div className="grid grid-cols-5 gap-1 p-1">
            {TEXT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setTextColor(color)}
                className="h-6 w-6 rounded border border-border/40 hover:scale-110 hover:border-border"
                style={{ backgroundColor: color }}
                title={color}
              />
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 背景色 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="背景颜色"
            aria-label="背景颜色"
            disabled={!editor}
            className="h-7 w-7 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Highlighter className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[160px]">
          <div className="grid grid-cols-4 gap-1 p-1">
            {HIGHLIGHT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setHighlight(color)}
                className={cn(
                  "h-6 w-6 rounded border border-border/40 hover:scale-110 hover:border-border",
                  color === "transparent" && "bg-[linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%),linear-gradient(45deg,#ccc_25%,transparent_25%,transparent_75%,#ccc_75%)] bg-[length:8px_8px] bg-[position:0_0,4px_4px]",
                )}
                style={color !== "transparent" ? { backgroundColor: color } : undefined}
                title={color === "transparent" ? "清除背景" : color}
              />
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="mx-1 h-4 w-px bg-border/70" />

      <ToolbarButton
        label="无序列表"
        active={active.bulletList}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <List className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="有序列表"
        active={active.orderedList}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarButton>

      <span className="mx-1 h-4 w-px bg-border/70" />

      <ToolbarButton label="链接" active={active.link} disabled={!editor} onClick={toggleLink}>
        <LinkIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton label="图片" disabled={!editor} onClick={onInsertImage}>
        <ImageIcon className="h-3.5 w-3.5" />
      </ToolbarButton>

      <span className="mx-1 h-4 w-px bg-border/70" />

      <ToolbarButton
        label="撤销"
        disabled={!editor || !editor.can().undo()}
        onClick={() => editor?.chain().focus().undo().run()}
      >
        <Undo2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="重做"
        disabled={!editor || !editor.can().redo()}
        onClick={() => editor?.chain().focus().redo().run()}
      >
        <Redo2 className="h-3.5 w-3.5" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-7 w-7 rounded text-muted-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </Button>
  );
}
