/**
 * 节点属性编辑对话框：标签 / 备注 / 超链接。
 *
 * 使用 Mind Elixir 的 reshapeNode API 更新节点属性。
 * 标签以逗号分隔输入，支持多标签。
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export interface NodePropertyData {
  /** 节点 ID */
  nodeId: string;
  /** 节点主题（只读展示） */
  topic: string;
  /** 标签列表 */
  tags: string[];
  /** 备注 */
  note: string;
  /** 超链接 */
  hyperLink: string;
}

export interface NodePropertyDialogProps {
  open: boolean;
  data: NodePropertyData | null;
  onApply: (nodeId: string, patch: Partial<NodePropertyData>) => void;
  onClose: () => void;
}

export function NodePropertyDialog({
  open,
  data,
  onApply,
  onClose,
}: NodePropertyDialogProps) {
  const [tagsText, setTagsText] = useState("");
  const [note, setNote] = useState("");
  const [hyperLink, setHyperLink] = useState("");

  // data 变化时同步表单
  useEffect(() => {
    if (data) {
      setTagsText(data.tags.join(", "));
      setNote(data.note ?? "");
      setHyperLink(data.hyperLink ?? "");
    }
  }, [data]);

  const handleApply = () => {
    if (!data) return;
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    onApply(data.nodeId, { tags, note, hyperLink });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">节点属性</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">节点</Label>
            <div className="rounded-md bg-muted/50 px-2 py-1.5 text-xs">
              {data?.topic ?? ""}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">标签（逗号分隔）</Label>
            <Input
              className="h-8 rounded-md text-xs"
              placeholder="如：重要, 待办"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">超链接</Label>
            <Input
              className="h-8 rounded-md text-xs"
              placeholder="https://..."
              value={hyperLink}
              onChange={(e) => setHyperLink(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">备注</Label>
            <Textarea
              className="min-h-[80px] rounded-md text-xs"
              placeholder="添加备注..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              spellCheck={false}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={handleApply}>
            应用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
