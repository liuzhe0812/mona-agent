import { FileText, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { PanelCard, secondaryButtonClass } from "../SystemUi";
import type { TopFileInfo } from "../useSystemData";
import { formatStorage } from "../useSystemData";

interface Props {
  files: TopFileInfo[];
  /** 点击"交给 Mona 评估"按钮触发 AI 分析 */
  onAnalyze?: (goal: string) => void;
}

const BUCKET_LABEL: Record<string, string> = {
  "30d": "近 30 天",
  "90d": "近 90 天",
  "180d": "近半年",
  "1y": "近一年",
  old: "一年以上",
  unknown: "未知",
};

const DISPLAY_LIMIT = 20;
const MENU_WIDTH = 200;
const MENU_ITEM_HEIGHT = 32;
const MENU_ITEMS = 2;

/** 在 Windows 资源管理器中打开并选中文件 */
async function revealInExplorer(path: string): Promise<void> {
  try {
    await invoke("system_reveal_in_explorer", { path });
  } catch (e) {
    console.error("[LargeFileTable] revealInExplorer failed:", e);
  }
}

/** 大文件列表：展示全局 Top 20 大文件（脱敏：仅扩展名 + 目录名 + 大小 + 修改时间桶） */
export function LargeFileTable({ files, onAnalyze }: Props) {
  const displayFiles = files.slice(0, DISPLAY_LIMIT);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleAnalyze = () => {
    if (!onAnalyze || displayFiles.length === 0) return;
    const summary = displayFiles
      .map((f, i) => `${i + 1}. ${f.parentDirName}/.${f.extension} ${formatStorage(f.sizeGb)} (${BUCKET_LABEL[f.modifiedBucket] ?? f.modifiedBucket})`)
      .join("\n");
    const goal = [
      `用户刚完成存储空间扫描，以下是占用最大的 ${displayFiles.length} 个文件（脱敏：仅目录名+扩展名+大小+修改时间桶）：`,
      summary,
      "",
      "请逐一评估这些大文件是否可以安全删除：",
      "1. 判断文件类型（如 .iso/.mp4/.bak/.log/.dmp/.cache 等）的清理价值",
      "2. 结合修改时间桶判断是否长期未使用",
      "3. 给出每项的处理建议：可安全删除 / 建议保留 / 需用户确认",
      "4. 汇总可释放的总空间估算",
      "注意：你只能提供建议，不要尝试执行任何删除操作。",
    ].join("\n");
    onAnalyze(goal);
  };

  const handleContextMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    const maxX = window.innerWidth - MENU_WIDTH - 8;
    const maxY = window.innerHeight - MENU_ITEM_HEIGHT * MENU_ITEMS - 8;
    setMenu({
      path,
      x: Math.min(e.clientX, maxX),
      y: Math.min(e.clientY, maxY),
    });
  };

  const closeMenu = () => setMenu(null);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menu]);

  return (
    <PanelCard
      title={`大文件 Top ${displayFiles.length}`}
      className="h-full"
      action={
        displayFiles.length > 0 && onAnalyze ? (
          <button type="button" className={secondaryButtonClass} onClick={handleAnalyze}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            交给 Mona 评估
          </button>
        ) : undefined
      }
    >
      {displayFiles.length === 0 ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          扫描后展示占用最大的文件
        </div>
      ) : (
        <div className="max-h-[280px] overflow-y-auto scrollbar-hover">
          <table className="w-full table-fixed text-left text-[11px]">
            <colgroup>
              <col className="w-8" />
              <col />
              <col className="w-20" />
              <col className="w-16" />
              <col className="w-16" />
            </colgroup>
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr>
                <th></th>
                <th className="pb-2 font-medium">所在目录</th>
                <th className="font-medium">类型</th>
                <th className="font-medium">修改时间</th>
                <th className="text-right font-medium">大小</th>
              </tr>
            </thead>
            <tbody>
              {displayFiles.map((file, index) => (
                <tr
                  key={`${file.parentDirName}-${file.extension}-${index}`}
                  className="border-t border-border/40 hover:bg-accent cursor-default"
                  onContextMenu={(e) => handleContextMenu(e, file.path)}
                  title={file.path}
                >
                  <td className="py-2 pr-1 text-muted-foreground">{index + 1}</td>
                  <td className="truncate py-2 pr-2 font-medium" title={file.parentDirName}>
                    <span className="flex items-center gap-1.5">
                      <FileText className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                      {file.parentDirName}
                    </span>
                  </td>
                  <td className="truncate py-2 pr-2 text-muted-foreground">
                    {file.extension === "(none)" ? "—" : `.${file.extension}`}
                  </td>
                  <td className="py-2 pr-2 text-muted-foreground">
                    {BUCKET_LABEL[file.modifiedBucket] ?? file.modifiedBucket}
                  </td>
                  <td className="py-2 text-right font-medium text-orange-600">
                    {formatStorage(file.sizeGb)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 自定义右键菜单 */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[200px] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            className="flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent hover:text-accent-foreground"
            onClick={() => { void revealInExplorer(menu.path); closeMenu(); }}
          >
            在资源管理器中显示
          </button>
          <button
            type="button"
            className="flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent hover:text-accent-foreground"
            onClick={() => { navigator.clipboard?.writeText(menu.path).catch(() => {}); closeMenu(); }}
          >
            复制路径
          </button>
        </div>
      )}
    </PanelCard>
  );
}
