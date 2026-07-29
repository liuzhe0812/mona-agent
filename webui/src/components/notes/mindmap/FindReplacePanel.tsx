/**
 * 思维导图查找与替换浮动面板。
 *
 * 功能：
 *   - 浮动在导图右上角，不遮挡节点编辑；
 *   - 支持上一个 / 下一个 / 匹配数量；
 *   - 支持替换单个 / 全部替换；
 *   - 大小写敏感切换；
 *   - 调用方负责实际的节点定位和滚动（通过 onNavigate 回调）。
 *
 * 见 docs/plans/mindmap-dev-plan.md §6.4。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronUp,
  ChevronDown,
  Replace,
  CaseSensitive,
  X,
  CheckCheck,
} from "lucide-react";

export interface FindReplacePanelProps {
  /** 当前匹配总数 */
  matchCount: number;
  /** 当前高亮的匹配索引（0-based），-1 表示无 */
  currentIndex: number;
  /** 查找文本变化时触发（重新搜索） */
  onSearch: (query: string, caseSensitive: boolean) => void;
  /** 点击上一个 / 下一个 */
  onNavigate: (direction: "prev" | "next") => void;
  /** 替换当前匹配 */
  onReplace: (replacement: string) => void;
  /** 全部替换 */
  onReplaceAll: (replacement: string) => void;
  /** 关闭面板 */
  onClose: () => void;
}

export function FindReplacePanel({
  matchCount,
  currentIndex,
  onSearch,
  onNavigate,
  onReplace,
  onReplaceAll,
  onClose,
}: FindReplacePanelProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const queryInputRef = useRef<HTMLInputElement>(null);

  // 自动聚焦
  useEffect(() => {
    queryInputRef.current?.focus();
  }, []);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    onSearch(value, caseSensitive);
  }, [caseSensitive, onSearch]);

  const handleCaseToggle = useCallback(() => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    onSearch(query, next);
  }, [caseSensitive, query, onSearch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        onNavigate("prev");
      } else {
        onNavigate("next");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }, [onNavigate, onClose]);

  const matchLabel = matchCount === 0
    ? "无匹配"
    : `${currentIndex + 1} / ${matchCount}`;

  return (
    <div
      className="absolute right-3 top-3 z-20 w-72 rounded-lg border border-border/60 bg-background shadow-lg"
      onKeyDown={handleKeyDown}
    >
      {/* 查找行 */}
      <div className="flex items-center gap-1 p-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setShowReplace(v => !v)}
          title={showReplace ? "隐藏替换" : "显示替换"}
          aria-label={showReplace ? "隐藏替换" : "显示替换"}
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${showReplace ? "rotate-180" : ""}`}
          />
        </Button>
        <Input
          ref={queryInputRef}
          className="h-7 flex-1 rounded-md text-xs"
          placeholder="查找..."
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          spellCheck={false}
        />
        <Button
          variant={caseSensitive ? "default" : "ghost"}
          size="icon"
          className="h-6 w-6"
          onClick={handleCaseToggle}
          title="区分大小写"
          aria-label="区分大小写"
          aria-pressed={caseSensitive}
        >
          <CaseSensitive className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[50px] text-center text-xs text-muted-foreground">
          {matchLabel}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onNavigate("prev")}
          disabled={matchCount === 0}
          title="上一个 (Shift+Enter)"
          aria-label="上一个匹配"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onNavigate("next")}
          disabled={matchCount === 0}
          title="下一个 (Enter)"
          aria-label="下一个匹配"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onClose}
          title="关闭 (Esc)"
          aria-label="关闭查找"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {/* 替换行 */}
      {showReplace ? (
        <div className="flex items-center gap-1 border-t border-border/60 p-2">
          <Input
            className="h-7 flex-1 rounded-md text-xs"
            placeholder="替换为..."
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            spellCheck={false}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onReplace(replacement)}
            disabled={matchCount === 0}
            title="替换当前"
          >
            <Replace className="mr-1 h-3 w-3" />
            替换
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onReplaceAll(replacement)}
            disabled={matchCount === 0}
            title="全部替换"
          >
            <CheckCheck className="mr-1 h-3 w-3" />
            全部
          </Button>
        </div>
      ) : null}
    </div>
  );
}
