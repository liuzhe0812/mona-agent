/**
 * 泳池/泳道安全删除确认对话框（FC-SWIM-04）。
 *
 * 删除非空 pool/lane 前让用户选择内容处理方式：
 * - pool：内容移到根画布（默认，保持绝对位置）/ 连同内容删除；
 * - lane：内容移到相邻泳道（默认）/ 移到根画布 / 连同内容删除。
 *
 * 底部实时预览策略影响（保留/删除的节点与连线数），取消时文档不变。
 */

import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";

export type PoolDeleteStrategy = "move-to-root" | "delete-content";
export type LaneDeleteStrategy = "move-to-lane" | "move-to-root" | "delete-content";

export interface SafeDeletePoolInfo {
  id: string;
  label: string;
  /** 池内泳道数 */
  laneCount: number;
  /** 泳道内的普通节点数（不含泳道本身） */
  contentCount: number;
  /** 子树节点关联的边数 */
  edgeCount: number;
}

export interface SafeDeleteLaneInfo {
  id: string;
  label: string;
  /** 所属泳池标题（用于区分多泳池场景） */
  poolLabel: string;
  /** 泳道内普通节点数 */
  contentCount: number;
  /** 内容节点关联的边数 */
  edgeCount: number;
  /** 同泳池是否还有其他泳道（决定"移到相邻泳道"是否可用） */
  hasAdjacentLane: boolean;
}

export interface SafeDeleteConfirmOptions {
  poolStrategy: PoolDeleteStrategy;
  laneStrategy: LaneDeleteStrategy;
}

export interface FlowchartSafeDeleteDialogProps {
  open: boolean;
  pools: SafeDeletePoolInfo[];
  lanes: SafeDeleteLaneInfo[];
  onConfirm: (options: SafeDeleteConfirmOptions) => void;
  onCancel: () => void;
}

const POOL_STRATEGY_OPTIONS = [
  { value: "move-to-root", label: "内容移到根画布" },
  { value: "delete-content", label: "连同内容一并删除" },
];

const LANE_STRATEGY_OPTIONS = [
  { value: "move-to-lane", label: "内容移到相邻泳道" },
  { value: "move-to-root", label: "内容移到根画布" },
  { value: "delete-content", label: "连同内容一并删除" },
];

export function FlowchartSafeDeleteDialog({
  open,
  pools,
  lanes,
  onConfirm,
  onCancel,
}: FlowchartSafeDeleteDialogProps) {
  const anyAdjacent = lanes.some((l) => l.hasAdjacentLane);
  const [poolStrategy, setPoolStrategy] = useState<PoolDeleteStrategy>("move-to-root");
  const [laneStrategy, setLaneStrategy] = useState<LaneDeleteStrategy>(
    anyAdjacent ? "move-to-lane" : "move-to-root",
  );
  // lane 无相邻泳道时"移到相邻泳道"不可用，回退到根画布
  const effectiveLaneStrategy: LaneDeleteStrategy =
    laneStrategy === "move-to-lane" && !anyAdjacent ? "move-to-root" : laneStrategy;

  // 策略预览：保留（移动）与删除的节点/连线统计
  const preview = useMemo(() => {
    let keepNodes = 0;
    let deleteNodes = 0;
    let deleteEdges = 0;
    for (const p of pools) {
      if (poolStrategy === "move-to-root") keepNodes += p.contentCount;
      else {
        deleteNodes += p.contentCount;
        deleteEdges += p.edgeCount;
      }
    }
    for (const l of lanes) {
      if (effectiveLaneStrategy === "delete-content") {
        deleteNodes += l.contentCount;
        deleteEdges += l.edgeCount;
      } else {
        keepNodes += l.contentCount;
      }
    }
    return { keepNodes, deleteNodes, deleteEdges };
  }, [pools, lanes, poolStrategy, effectiveLaneStrategy]);

  const laneOptions = LANE_STRATEGY_OPTIONS.filter(
    (o) => o.value !== "move-to-lane" || anyAdjacent,
  );

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-md" aria-label="删除确认">
        <DialogHeader>
          <DialogTitle>删除泳池 / 泳道</DialogTitle>
          <DialogDescription>
            {pools.length > 0 && lanes.length > 0
              ? `选中的 ${pools.length} 个泳池和 ${lanes.length} 条泳道内还有内容，请选择处理方式。`
              : pools.length > 0
                ? `选中的 ${pools.length} 个泳池内还有内容，请选择处理方式。`
                : `选中的 ${lanes.length} 条泳道内还有内容，请选择处理方式。`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          {pools.length > 0 && (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 text-[13px] text-foreground">
                <span className="font-medium">泳池内容</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {pools.reduce((s, p) => s + p.contentCount, 0)} 个节点
                </span>
              </div>
              <Select
                className="w-48 shrink-0"
                value={poolStrategy}
                onValueChange={(v) => setPoolStrategy(v as PoolDeleteStrategy)}
                options={POOL_STRATEGY_OPTIONS}
              />
            </div>
          )}
          {lanes.length > 0 && (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 text-[13px] text-foreground">
                <span className="font-medium">泳道内容</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {lanes.reduce((s, l) => s + l.contentCount, 0)} 个节点
                </span>
              </div>
              <Select
                className="w-48 shrink-0"
                value={effectiveLaneStrategy}
                onValueChange={(v) => setLaneStrategy(v as LaneDeleteStrategy)}
                options={laneOptions}
              />
            </div>
          )}

          {/* 策略影响预览 */}
          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {preview.keepNodes > 0 && <div>{preview.keepNodes} 个节点将被保留并移动位置。</div>}
            {preview.deleteNodes > 0 ? (
              <div className="text-destructive">
                {preview.deleteNodes} 个节点
                {preview.deleteEdges > 0 ? `、${preview.deleteEdges} 条连线` : ""}将被删除。
              </div>
            ) : (
              preview.keepNodes > 0 && <div>没有节点或连线会被删除。</div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onConfirm({ poolStrategy, laneStrategy: effectiveLaneStrategy })}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
