import { useEffect, useState } from "react";
import { stat } from "@tauri-apps/plugin-fs";
import { sftpStatDetail, type FileStatDetail } from "../ipc";
import { type UnifiedFileItem } from "./FilePane";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: UnifiedFileItem | null;
  side: "local" | "remote";
  sessionId: string;
  onOpenPermissions: (file: UnifiedFileItem) => void;
}

function formatSize(size: number | null | undefined): string {
  if (size === null || size === undefined) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function modeToRwx(mode: number | null | undefined): string {
  if (mode === null || mode === undefined) return "-";
  const perms = mode & 0o777;
  const rwx = (n: number) => {
    const r = n & 4 ? "r" : "-";
    const w = n & 2 ? "w" : "-";
    const x = n & 1 ? "x" : "-";
    return r + w + x;
  };
  return rwx((perms >> 6) & 7) + rwx((perms >> 3) & 7) + rwx(perms & 7);
}

function modeToOctal(mode: number | null | undefined): string {
  if (mode === null || mode === undefined) return "-";
  const perms = mode & 0o777;
  return perms.toString(8).padStart(3, "0");
}

interface DetailState {
  type: string;
  path: string;
  size: number | null;
  permissions: string | null;
  octal: string | null;
  owner: string | null;
  group: string | null;
  modified: string | null;
}

export function PropertiesDialog({
  open,
  onOpenChange,
  file,
  side,
  sessionId,
  onOpenPermissions,
}: Props) {
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !file) {
      setDetail(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    if (side === "remote") {
      sftpStatDetail(sessionId, file.path)
        .then((info: FileStatDetail) => {
          if (cancelled) return;
          setDetail({
            type: info.isDir ? "目录" : "文件",
            path: info.path,
            size: info.isDir ? null : info.size,
            permissions: info.modeString || modeToRwx(info.permissions),
            octal: modeToOctal(info.permissions),
            owner: info.owner || null,
            group: info.group || null,
            modified: info.mtime ?? null,
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else {
      stat(file.path)
        .then((info) => {
          if (cancelled) return;
          setDetail({
            type: info.isDirectory ? "目录" : info.isSymlink ? "符号链接" : "文件",
            path: file.path,
            size: info.isDirectory ? null : info.size,
            permissions: modeToRwx(info.mode),
            octal: modeToOctal(info.mode),
            owner: info.uid !== null ? String(info.uid) : null,
            group: info.gid !== null ? String(info.gid) : null,
            modified: info.mtime
              ? info.mtime.toLocaleString()
              : null,
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [open, file, side, sessionId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{file?.name ?? "属性"}</DialogTitle>
          <DialogDescription>文件属性信息</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            加载中…
          </div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-destructive">{error}</div>
        ) : detail ? (
          <div className="space-y-2 text-sm">
            <Row label="类型" value={detail.type} />
            <Row label="路径" value={detail.path} />
            <Row label="大小" value={formatSize(detail.size)} />
            <Row label="权限" value={`${detail.permissions} (${detail.octal})`} />
            <Row label="所有者" value={detail.owner ?? "-"} />
            <Row label="组" value={detail.group ?? "-"} />
            <Row label="修改时间" value={detail.modified ?? "-"} />
          </div>
        ) : null}

        {side === "remote" && file && (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenPermissions(file)}
            >
              修改权限
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="break-all">{value}</span>
    </div>
  );
}
