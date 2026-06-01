import { useEffect, useState } from "react";
import { Download, Presentation } from "lucide-react";

import { fetchPptProjects } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { PptProject } from "@/lib/types";

interface PptHistoryProps {
  onSelect: (name: string) => void;
  onDownload: (name: string) => void;
}

function formatRelativeTime(epoch: number): string {
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 0) return "刚刚";
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

export function PptHistory({ onSelect, onDownload }: PptHistoryProps) {
  const { token } = useClient();
  const [projects, setProjects] = useState<PptProject[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchPptProjects(token).then((res) => {
      if (!cancelled) setProjects(res.projects);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (projects.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
        暂无历史项目
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
        历史项目
      </div>
      {projects.map((p) => (
        <button
          key={p.name}
          className={cn(
            "flex w-full items-center gap-2 px-2 py-1.5 text-left",
            "hover:bg-accent",
          )}
          onClick={() => onSelect(p.name)}
        >
          <Presentation className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px]">{p.name}</div>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span>{p.format}</span>
              <span>·</span>
              <span>{p.slideCount}页</span>
              <span>·</span>
              <span>{formatRelativeTime(p.createdAt)}</span>
            </div>
          </div>
          {p.hasExport && (
            <span
              role="button"
              tabIndex={0}
              className="shrink-0 rounded p-0.5 hover:bg-accent"
              onClick={(e) => {
                e.stopPropagation();
                onDownload(p.name);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  onDownload(p.name);
                }
              }}
            >
              <Download className="h-3 w-3 text-muted-foreground" />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
