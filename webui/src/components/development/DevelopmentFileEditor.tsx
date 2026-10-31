import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { codeToTokens, type ThemedToken } from "shiki";
import { Textarea } from "@/components/ui/textarea";
import { useThemeValue } from "@/hooks/useTheme";
import { inferCodeLanguage } from "./zcode/tools/codeViewer";

export function DevelopmentFileEditor({ path, value, onChange, onSave }: {
  path: string; value: string; onChange: (value: string) => void; onSave: () => void;
}) {
  const theme = useThemeValue() === "dark" ? "github-dark" : "github-light";
  const language = inferCodeLanguage(path, value);
  const [highlight, setHighlight] = useState<{
    value: string; language: string; theme: string; tokens: ThemedToken[][];
  } | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const preview = useRef<HTMLPreElement>(null);
  const tokens = highlight?.value === value && highlight.language === language && highlight.theme === theme
    ? highlight.tokens : null;
  useEffect(() => {
    if (language === "log") return;
    let cancelled = false;
    void codeToTokens(value, { lang: language, theme }).then((result) => {
      if (!cancelled) setHighlight({ value, language, theme, tokens: result.tokens });
    }).catch((error: unknown) => {
      if (!cancelled) console.warn("项目文件语法高亮失败", error);
    });
    return () => { cancelled = true; };
  }, [value, language, theme]);
  const syncScroll = () => {
    if (preview.current && editor.current) {
      // Match the text viewport, excluding the textarea's native scrollbars.
      preview.current.style.width = `${editor.current.clientWidth}px`;
      preview.current.style.height = `${editor.current.clientHeight}px`;
      preview.current.scrollTop = editor.current.scrollTop;
      preview.current.scrollLeft = editor.current.scrollLeft;
    }
  };
  useLayoutEffect(syncScroll, [value, tokens]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(syncScroll);
    if (editor.current) observer.observe(editor.current);
    return () => observer.disconnect();
  }, []);
  return <div className="relative min-h-0 flex-1 overflow-hidden bg-editor-surface">
    {/* Both layers share text metrics; the textarea keeps native editing, selection and IME. */}
    <pre ref={preview} aria-hidden="true"
      className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre px-3 py-2 font-mono text-ui leading-relaxed"
      style={{ tabSize: 2, visibility: tokens ? "visible" : "hidden" }}>
      <code style={{ fontFamily: "inherit" }}>{tokens ? tokens.map((line, index) => <Fragment key={index}>
        {index > 0 && "\n"}{line.map((token, part) => <span key={part} style={{ color: token.color }}>{token.content}</span>)}
      </Fragment>) : value}{"\n"}</code>
    </pre>
    <Textarea ref={editor} aria-label="项目文件编辑器" title="Ctrl/Cmd+S 保存" value={value}
      spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" onScroll={syncScroll}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault(); onSave();
        }
      }}
      className="absolute inset-0 h-full min-h-0 resize-none rounded-none border-0 bg-transparent px-3 py-2 font-mono text-ui leading-relaxed focus-visible:ring-inset"
      style={{ tabSize: 2, color: tokens ? "transparent" : undefined, caretColor: "hsl(var(--foreground))" }} />
  </div>;
}
