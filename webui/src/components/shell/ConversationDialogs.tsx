import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentAvatar } from "@/components/room/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AgentSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 阶段 4.5 壳层对话框：新建协作房间（多选成员 + 标题 + 目标）。
 */

interface AgentRowProps {
  agent: AgentSummary;
  selected: boolean;
  onToggle: () => void;
  /** 紧凑单行：只显示头像 + 名称，不显示描述，行高 36px。 */
  compact?: boolean;
}

function AgentRow({ agent, selected, onToggle, compact }: AgentRowProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      onClick={onToggle}
      className={cn(
        "flex w-full items-center rounded-lg border text-left transition-colors",
        compact ? "gap-2.5 px-2.5 py-1.5" : "gap-3 px-3 py-2",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-transparent hover:bg-muted/60",
      )}
    >
      <AgentAvatar
        agentId={agent.id}
        displayName={agent.displayName}
        className={compact ? "h-6 w-6" : "h-8 w-8"}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-foreground">
          {agent.displayName}
        </span>
        {!compact && agent.description ? (
          <span className="block truncate text-caption text-muted-foreground">
            {agent.description}
          </span>
        ) : null}
      </span>
      <Checkbox
        checked={selected}
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none"
      />
    </button>
  );
}

interface NewRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: AgentSummary[];
  /** 预勾选成员（从伙伴详情「创建房间」进入时传入该伙伴）。 */
  initialSelected?: string[];
  submitting?: boolean;
  onSubmit: (input: { agentIds: string[]; title: string; goal?: string }) => void;
}

/** 新建协作房间：多选成员 + 标题 + 目标。标题留空时按成员名自动生成。 */
export function NewRoomDialog({
  open,
  onOpenChange,
  agents,
  initialSelected,
  submitting,
  onSubmit,
}: NewRoomDialogProps) {
  const { t } = useTranslation();
  // internal 股票 Agent（visibility=internal）仅服务股票研究房间的工作流，
  // 不进入用户新建房间的成员候选。
  const candidates = useMemo(
    () => agents.filter((a) => a.enabled && a.visibility !== "internal"),
    [agents],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");

  useEffect(() => {
    if (open) {
      setSelectedIds(initialSelected ?? []);
      setTitle("");
      setGoal("");
    }
  }, [open, initialSelected]);

  const toggle = (id: string) =>
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const handleSubmit = () => {
    const resolvedTitle =
      title.trim() ||
      selectedIds
        .map((id) => candidates.find((a) => a.id === id)?.displayName ?? id)
        .join("、");
    if (!resolvedTitle || selectedIds.length === 0) return;
    onSubmit({
      agentIds: selectedIds,
      title: resolvedTitle,
      goal: goal.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("partners.newRoomTitle")}</DialogTitle>
          <DialogDescription>{t("partners.newRoomHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4 py-1">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border/60 p-1.5">
              {candidates.length === 0 ? (
                <p className="px-1 py-6 text-center text-ui text-muted-foreground">
                  {t("partners.empty")}
                </p>
              ) : (
                candidates.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    compact
                    selected={selectedIds.includes(agent.id)}
                    onToggle={() => toggle(agent.id)}
                  />
                ))
              )}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              htmlFor="new-room-title"
              className="text-caption font-medium text-foreground"
            >
              {t("partners.roomTitleLabel")}
            </label>
            <Input
              id="new-room-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("partners.roomTitlePlaceholder")}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              htmlFor="new-room-goal"
              className="text-caption font-medium text-foreground"
            >
              {t("partners.roomGoalLabel")}
            </label>
            <Textarea
              id="new-room-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t("partners.roomGoalPlaceholder")}
              rows={3}
              className="resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="w-20"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            className="w-20"
            disabled={selectedIds.length === 0 || submitting}
            onClick={handleSubmit}
          >
            {t("partners.createRoom")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
