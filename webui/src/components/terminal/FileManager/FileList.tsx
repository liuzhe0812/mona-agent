import { Folder, File, Trash2, Pencil, Download, Loader2 } from "lucide-react";
import type { FileInfo } from "../types/terminal";

interface Props {
  files: FileInfo[];
  loading: boolean;
  onOpen: (file: FileInfo) => void;
  onDelete: (file: FileInfo) => void;
  onRename: (file: FileInfo) => void;
  onDownload: (file: FileInfo) => void;
  downloading: string | null;
}

function formatSize(size: number | null): string {
  if (size === null) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatTime(mtime: number | null): string {
  if (mtime === null) return "-";
  const d = new Date(mtime * 1000);
  return d.toLocaleString();
}

function formatPermissions(permissions: number | null): string {
  if (permissions === null) return "-";
  const p = permissions;
  const rwx = (n: number) => {
    const r = n & 4 ? "r" : "-";
    const w = n & 2 ? "w" : "-";
    const x = n & 1 ? "x" : "-";
    return r + w + x;
  };
  return rwx((p >> 6) & 7) + rwx((p >> 3) & 7) + rwx(p & 7);
}

export function FileList({ files, loading, onOpen, onDelete, onRename, onDownload, downloading }: Props) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        空目录
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b text-left text-muted-foreground">
            <th className="w-8 px-2 py-1.5" />
            <th className="px-2 py-1.5 font-medium">名称</th>
            <th className="w-24 px-2 py-1.5 font-medium">大小</th>
            <th className="w-28 px-2 py-1.5 font-medium">权限</th>
            <th className="w-40 px-2 py-1.5 font-medium">修改时间</th>
            <th className="w-20 px-2 py-1.5 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              onOpen={onOpen}
              onDelete={onDelete}
              onRename={onRename}
              onDownload={onDownload}
              downloading={downloading}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FileRow({
  file,
  onOpen,
  onDelete,
  onRename,
  onDownload,
  downloading,
}: {
  file: FileInfo;
  onOpen: (file: FileInfo) => void;
  onDelete: (file: FileInfo) => void;
  onRename: (file: FileInfo) => void;
  onDownload: (file: FileInfo) => void;
  downloading: string | null;
}) {
  const handleClick = () => {
    onOpen(file);
  };

  const isDownloading = downloading === file.name;

  return (
    <tr
      className="group cursor-pointer border-b border-transparent transition-colors hover:bg-accent/50"
      onDoubleClick={handleClick}
    >
      <td className="px-2 py-1.5">
        {file.isDir ? (
          <Folder className="h-4 w-4 text-blue-400" />
        ) : (
          <File className="h-4 w-4 text-muted-foreground" />
        )}
      </td>
      <td className="max-w-[300px] truncate px-2 py-1.5 font-medium">
        {file.name}
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">
        {file.isDir ? "-" : formatSize(file.size)}
      </td>
      <td className="px-2 py-1.5 font-mono text-muted-foreground">
        {formatPermissions(file.permissions)}
      </td>
      <td className="px-2 py-1.5 text-muted-foreground">
        {formatTime(file.mtime)}
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
          {!file.isDir && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDownload(file);
              }}
              className="rounded p-0.5 hover:bg-accent"
              title="下载"
              disabled={isDownloading}
            >
              {isDownloading ? (
                <Loader2 className="h-3 w-3 text-muted-foreground animate-spin" />
              ) : (
                <Download className="h-3 w-3 text-muted-foreground" />
              )}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRename(file);
            }}
            className="rounded p-0.5 hover:bg-accent"
            title="重命名"
          >
            <Pencil className="h-3 w-3 text-muted-foreground" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(file);
            }}
            className="rounded p-0.5 hover:bg-accent"
            title="删除"
          >
            <Trash2 className="h-3 w-3 text-destructive" />
          </button>
        </div>
      </td>
    </tr>
  );
}
