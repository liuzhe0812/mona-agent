/**
 * 本地流程检查面板（设计文档 §7.9）。
 *
 * 复用 collectFlowchartSemanticWarnings() 的结果，在画布右下角展示问题数量和列表：
 * - 点击问题项选中并定位关联节点；
 * - "让 AI 修复"按钮把问题代码和当前语义图交给 FlowchartAgentPanel 审查。
 *
 * 本组件不直接调用 AI，只通过 onFixWithAI 回调把 warnings 交给父组件。
 * 父组件（FlowchartDocumentEditor）再把 warnings 拼到 audit prompt 中。
 */

import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Wand2 } from "lucide-react";

import type { FlowchartSemanticWarning } from "./flowchart-document";

export interface FlowchartIssuesPanelProps {
  warnings: FlowchartSemanticWarning[];
  /** 点击问题项时触发，参数为关联节点 ID（可能为空，如全局问题） */
  onLocateNode?: (nodeId: string | null) => void;
  /** 点击"让 AI 修复"时触发，把当前 warnings 交给父组件 */
  onFixWithAI?: (warnings: FlowchartSemanticWarning[]) => void;
}

const CODE_LABELS: Record<string, string> = {
  "no-start": "缺少开始节点",
  "no-end": "缺少结束节点",
  "start-has-incoming": "开始节点有入边",
  "end-has-outgoing": "结束节点有出边",
  "decision-unlabeled-branch": "判断分支无标签",
  "isolated-node": "孤立节点",
  "unreachable-node": "不可达节点",
  "has-cycle": "存在循环",
};

export function FlowchartIssuesPanel({
  warnings,
  onLocateNode,
  onFixWithAI,
}: FlowchartIssuesPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const count = warnings.length;
  const sortedWarnings = useMemo(
    () => [...warnings].sort((a, b) => a.code.localeCompare(b.code)),
    [warnings],
  );

  if (count === 0) return null;

  return (
    <div className="flowchart-issues-panel absolute right-2 top-2 z-20 w-[240px] rounded-md border border-border/70 bg-background/95 shadow-md backdrop-blur-sm">
      {/* 头部：问题数 + 折叠 + AI 修复 */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
        <span className="text-[11.5px] font-medium text-foreground">
          流程问题 {count}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => onFixWithAI?.(sortedWarnings)}
            title="让 AI 给出修复方案"
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Wand2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "折叠问题列表" : "展开问题列表"}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* 问题列表 */}
      {expanded && (
        <div className="max-h-[280px] overflow-y-auto border-t border-border/60 py-1 scrollbar-thin">
          {sortedWarnings.map((w, i) => {
            const label = CODE_LABELS[w.code] ?? w.code;
            const clickable = !!w.nodeId;
            return (
              <button
                key={`${w.code}-${i}`}
                type="button"
                disabled={!clickable}
                onClick={() => onLocateNode?.(w.nodeId ?? null)}
                title={clickable ? "点击定位到画布" : "全局问题，无可定位节点"}
                className="flex w-full items-start gap-1.5 px-2.5 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-70"
              >
                <span className="mt-0.5 shrink-0 text-amber-500">•</span>
                <span className="flex-1 break-words">
                  <span className="font-medium text-foreground/80">{label}</span>
                  {w.message && (
                    <span className="ml-1 text-muted-foreground/80">— {w.message}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
