import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentAvatar, MONA_AGENT_ID } from "@/components/room/AgentAvatar";
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
 * 阶段 4.5 壳层对话框：新建私聊（单选 agent）与新建协作房间
 * （多选成员 + 标题 + 目标）。两个对话框共享伙伴列表渲染。
 */

interface AgentRowProps {
  agent: AgentSummary;
  selected: boolean;
  onToggle: () => void;
  mode: "radio" | "checkbox";
}

function AgentRow({ agent, selected, onToggle, mode }: AgentRowProps) {
  return (
    <button
      type="button"
      role={mode === "radio" ? "radio" : "checkbox"}
      aria-checked={selected}
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-transparent hover:bg-muted/60",
      )}
    >
      <AgentAvatar
        agentId={agent.id}
        displayName={agent.displayName}
        className="h-8 w-8"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">
          {agent.displayName}
        </span>
        {agent.description ? (
          <span className="block truncate text-xs text-muted-foreground">
            {agent.description}
          </span>
        ) : null}
      </span>
      {mode === "checkbox" ? (
        <Checkbox
          checked={selected}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none"
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-primary" : "border-muted-foreground/40",
          )}
        >
          {selected ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
        </span>
      )}
    </button>
  );
}

interface NewDirectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: AgentSummary[];
  submitting?: boolean;
  onSubmit: (agentId: string) => void;
}

/** 新建私聊：选择一个伙伴 agent。Mona 的私聊即普通新会话，不出现在列表。 */
export function NewDirectDialog({
  open,
  onOpenChange,
  agents,
  submitting,
  onSubmit,
}: NewDirectDialogProps) {
  const { t } = useTranslation();
  const partners = useMemo(
    () => agents.filter((a) => a.id !== MONA_AGENT_ID && a.enabled),
    [agents],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (open) setSelectedId(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("partners.newDirectTitle")}</DialogTitle>
          <DialogDescription>{t("partners.newDirectHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto py-1">
          {partners.length === 0 ? (
            <p className="px-1 py-6 text-center text-[13px] text-muted-foreground">
              {t("partners.empty")}
            </p>
          ) : (
            partners.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                mode="radio"
                selected={selectedId === agent.id}
                onToggle={() => setSelectedId(agent.id)}
              />
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!selectedId || submitting}
            onClick={() => selectedId && onSubmit(selectedId)}
          >
            {t("partners.startDirect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const candidates = useMemo(() => agents.filter((a) => a.enabled), [agents]);
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
        <div className="flex flex-col gap-3 py-1">
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border/60 p-1.5">
            {candidates.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                mode="checkbox"
                selected={selectedIds.includes(agent.id)}
                onToggle={() => toggle(agent.id)}
              />
            ))}
          </div>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("partners.roomTitlePlaceholder")}
            aria-label={t("partners.roomTitleLabel")}
          />
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t("partners.roomGoalPlaceholder")}
            aria-label={t("partners.roomGoalLabel")}
            rows={3}
            className="resize-none"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
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
