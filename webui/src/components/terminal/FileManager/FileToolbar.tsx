import {
  ChevronRight,
  FolderPlus,
  RefreshCw,
  ArrowUp,
  Home,
  Upload,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState, useCallback } from "react";

interface Props {
  currentPath: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onCreateFolder: () => void;
  onUpload: () => void;
  uploading: boolean;
}

export function FileToolbar({
  currentPath,
  onNavigate,
  onRefresh,
  onCreateFolder,
  onUpload,
  uploading,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editPath, setEditPath] = useState(currentPath);

  const segments = currentPath.split("/").filter(Boolean);

  const handleBreadcrumbClick = (index: number) => {
    const path = "/" + segments.slice(0, index + 1).join("/");
    onNavigate(path);
  };

  const handlePathSubmit = () => {
    if (editPath.trim()) {
      onNavigate(editPath.trim());
    }
    setEditing(false);
  };

  const handleStartEdit = useCallback(() => {
    setEditPath(currentPath);
    setEditing(true);
  }, [currentPath]);

  const handleParentDir = () => {
    const parent = segments.slice(0, -1).join("/");
    onNavigate(parent ? "/" + parent : "/");
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={() => onNavigate("/")}
        title="根目录"
      >
        <Home className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={handleParentDir}
        disabled={currentPath === "/"}
        title="上级目录"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>

      <div className="min-w-0 flex-1 overflow-hidden">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handlePathSubmit();
            }}
            className="flex items-center"
          >
            <Input
              value={editPath}
              onChange={(e) => setEditPath(e.target.value)}
              onBlur={handlePathSubmit}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
              }}
              className="h-6 px-1.5 py-0 text-xs"
              autoFocus
            />
          </form>
        ) : (
          <div
            className="flex items-center gap-0.5 overflow-x-auto text-xs text-muted-foreground scrollbar-none"
            onDoubleClick={handleStartEdit}
          >
            <button
              onClick={() => onNavigate("/")}
              className="shrink-0 rounded px-1 hover:bg-accent hover:text-foreground"
            >
              /
            </button>
            {segments.map((seg, i) => (
              <span key={i} className="flex items-center gap-0.5">
                <ChevronRight className="h-3 w-3 shrink-0 opacity-40" />
                <button
                  onClick={() => handleBreadcrumbClick(i)}
                  className="shrink-0 rounded px-1 hover:bg-accent hover:text-foreground"
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1.5 text-xs"
        onClick={onUpload}
        disabled={uploading}
        title="上传文件"
      >
        {uploading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1.5 text-xs"
        onClick={onCreateFolder}
        title="新建文件夹"
      >
        <FolderPlus className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={onRefresh}
        title="刷新"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
