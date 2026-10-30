import { useState, useEffect, useRef } from "react";
import { Save, Loader2, AlertCircle } from "lucide-react";
import { desktopGetFileContent, desktopSaveFileContent } from "../../ipc";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface TextEditorAppProps {
  sessionId: string;
  filePath?: string;
}

export function TextEditorApp({ sessionId, filePath }: TextEditorAppProps) {
  const [content, setContent] = useState("");
  const contentRef = useRef(content);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (filePath) {
      loadContent();
    }
  }, [filePath, sessionId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveContent();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [content, filePath, sessionId, loading, loadError]);

  const loadContent = async () => {
    if (!filePath) return;
    setLoading(true);
    setLoadError(false);
    try {
      const data = await desktopGetFileContent(sessionId, filePath);
      contentRef.current = data;
      setContent(data);
      setIsDirty(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const saveContent = async () => {
    if (!filePath || loading || loadError) return;
    setSaving(true);
    try {
      await desktopSaveFileContent(sessionId, filePath, content);
      if (contentRef.current === content) setIsDirty(false);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center text-white/50">
        未选择文件
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-white/50">
        <Loader2 className="h-5 w-5 animate-spin" />
        加载中...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-red-400">
        <AlertCircle className="h-8 w-8" />
        <p>读取文件失败，请检查路径、访问权限和连接后重试。</p>
        <button
          onClick={loadContent}
          className="mt-4 rounded bg-white/10 px-4 py-2 text-sm text-white transition-colors hover:bg-white/20"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e] text-[#d4d4d4]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#333] bg-[#252526] px-3">
        <div className="flex items-center gap-2 text-sm text-[#cccccc]">
          <span className="opacity-50">{filePath}</span>
          {isDirty && <span className="h-2 w-2 rounded-full bg-blue-500" />}
        </div>
        <button
          onClick={saveContent}
          disabled={!isDirty || saving}
          className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors ${
            isDirty
              ? "bg-blue-600 text-white hover:bg-blue-500"
              : "cursor-not-allowed bg-white/5 text-white/40"
          }`}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          保存
        </button>
      </div>

      <div className="relative flex-1">
        <textarea
          value={content}
          onChange={(e) => {
            contentRef.current = e.target.value;
            setContent(e.target.value);
            setIsDirty(true);
          }}
          className="h-full w-full resize-none bg-[#1e1e1e] p-4 font-mono text-sm leading-relaxed text-[#d4d4d4] focus:outline-none"
          spellCheck={false}
          style={{ tabSize: 2 }}
        />
      </div>

      <div className="flex h-6 items-center gap-4 bg-[#007acc] px-3 text-xs text-white">
        <span>UTF-8</span>
        <span>{content.split("\n").length} 行</span>
      </div>

      <AlertDialog open={saveError} onOpenChange={setSaveError}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>保存失败</AlertDialogTitle>
            <AlertDialogDescription>
              无法确认文件的保存结果，草稿仍在编辑器中。请先检查远程文件、路径和访问权限后再重试。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction>知道了</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
