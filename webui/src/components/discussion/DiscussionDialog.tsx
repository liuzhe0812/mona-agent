import { useEffect, useMemo, useState } from "react";
import { MessagesSquare } from "lucide-react";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { DebateStyle, DiscussionLaunchOptions, DiscussionMode, RoomAgentInfo } from "@/lib/types";

const FREE_STYLE = "__free__";
const NO_JUDGE = "__none__";
const DEBATE_STYLES: DebateStyle[] = [
  "sharp_punchline",
  "value_reframe",
  "rational_empathy",
  "everyday_spicy",
  "concept_deconstruction",
  "simple_analogy",
];

interface DiscussionDialogProps {
  members: RoomAgentInfo[];
  disabled?: boolean;
  onStart: (topic: string, options: DiscussionLaunchOptions) => void;
}

export function DiscussionDialog({ members, disabled, onStart }: DiscussionDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<DiscussionMode>("debate");
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, string>>({});
  const [styles, setStyles] = useState<Partial<Record<string, DebateStyle>>>({});
  const [maxRounds, setMaxRounds] = useState(3);
  const [summaryAgentId, setSummaryAgentId] = useState(NO_JUDGE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const initialParticipants = members.slice(0, 2).map((member) => member.id);
    setTopic("");
    setMode("debate");
    setParticipantIds(initialParticipants);
    setPositions({});
    setStyles({});
    setMaxRounds(3);
    setSummaryAgentId(NO_JUDGE);
    setError(null);
  }, [members, open]);

  const summaryOptions = useMemo(
    () => [
      ...(mode === "debate"
        ? [{ value: NO_JUDGE, label: t("room.discussion.noJudge") }]
        : []),
      ...members.map((member) => ({ value: member.id, label: member.displayName })),
    ],
    [members, mode, t],
  );
  const styleOptions = useMemo(
    () => [
      { value: FREE_STYLE, label: t("room.discussion.styles.free") },
      ...DEBATE_STYLES.map((style) => ({
        value: style,
        label: t(`room.discussion.styles.${style}`),
      })),
    ],
    [t],
  );

  const toggleParticipant = (agentId: string, checked: boolean) => {
    setParticipantIds((current) => checked
      ? [...current, agentId]
      : current.filter((id) => id !== agentId));
    setError(null);
  };

  const start = () => {
    const trimmedTopic = topic.trim();
    if (!trimmedTopic) {
      setError(t("room.discussion.validation.topic"));
      return;
    }
    if (participantIds.length < 2) {
      setError(t("room.discussion.validation.participants"));
      return;
    }
    if (mode === "debate") {
      const missing = participantIds.find((id) => !positions[id]?.trim());
      if (missing) {
        setError(t("room.discussion.validation.positions"));
        return;
      }
    }
    if (mode === "discussion" && summaryAgentId === NO_JUDGE) {
      setError(t("room.discussion.validation.summary"));
      return;
    }
    onStart(trimmedTopic, {
      mode,
      maxRounds,
      participantIds,
      positions: Object.fromEntries(participantIds.map((id) => [id, positions[id]?.trim() ?? ""])),
      styles: Object.fromEntries(
        participantIds.flatMap((id) => styles[id] ? [[id, styles[id]]] : []),
      ),
      summaryAgentId: summaryAgentId === NO_JUDGE ? null : summaryAgentId,
    });
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || members.length < 2}
          className="h-7 gap-1.5 rounded-full px-2.5 text-caption text-muted-foreground"
        >
          <MessagesSquare className="h-3.5 w-3.5" />
          {t("room.discussion.launch")}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[84vh] max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/55 px-6 py-5">
          <DialogTitle>{t("room.discussion.title")}</DialogTitle>
          <DialogDescription>{t("room.discussion.description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5 scrollbar-hover">
          <label className="grid gap-1.5 text-ui">
            <span className="text-caption font-medium text-muted-foreground">{t("room.discussion.topic")}</span>
            <Textarea
              value={topic}
              onChange={(event) => { setTopic(event.target.value); setError(null); }}
              maxLength={2000}
              placeholder={t("room.discussion.topicPlaceholder")}
              className="min-h-24 resize-none"
            />
          </label>

          <div className="grid gap-2">
            <span className="text-caption font-medium text-muted-foreground">{t("room.discussion.mode")}</span>
            <div className="grid grid-cols-2 gap-2">
              {(["debate", "discussion"] as DiscussionMode[]).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setMode(value);
                    if (value === "debate") setSummaryAgentId(NO_JUDGE);
                    else if (summaryAgentId === NO_JUDGE) {
                      setSummaryAgentId(
                        members.find((member) => member.id === "mona")?.id
                          ?? members[0]?.id
                          ?? NO_JUDGE,
                      );
                    }
                    setError(null);
                  }}
                  className={`h-auto justify-start rounded-lg px-3 py-2.5 text-left font-normal ${mode === value ? "border-theme/55 bg-theme/5 hover:bg-theme/5" : "border-border/65 hover:bg-muted/45"}`}
                >
                  <span>
                    <span className="block text-ui font-medium">{t(`room.discussion.${value}`)}</span>
                    <span className="mt-0.5 block whitespace-normal text-caption text-muted-foreground">{t(`room.discussion.${value}Hint`)}</span>
                  </span>
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <span className="text-caption font-medium text-muted-foreground">{t("room.discussion.participants")}</span>
            <div className="grid gap-2">
              {members.map((member) => {
                const checked = participantIds.includes(member.id);
                return (
                  <div key={member.id} className="rounded-lg border border-border/60 px-3 py-2.5">
                    <label className="flex cursor-pointer items-center gap-2.5 text-ui">
                      <Checkbox checked={checked} onCheckedChange={(value) => toggleParticipant(member.id, value === true)} />
                      <AgentAvatar agentId={member.id} displayName={member.displayName} className="h-6 w-6" />
                      <span className="font-medium">{member.displayName}</span>
                    </label>
                    {checked && mode === "debate" ? (
                      <div className="mt-2 grid gap-2">
                        <Input
                          value={positions[member.id] ?? ""}
                          onChange={(event) => {
                            setPositions((current) => ({ ...current, [member.id]: event.target.value }));
                            setError(null);
                          }}
                          maxLength={240}
                          placeholder={t("room.discussion.positionPlaceholder", { agent: member.displayName })}
                          className="h-8 text-caption"
                        />
                        <div className="grid gap-1">
                          <Select
                            aria-label={t("room.discussion.styleAria", { agent: member.displayName })}
                            value={styles[member.id] ?? FREE_STYLE}
                            onValueChange={(value) => setStyles((current) => {
                              const next = { ...current };
                              if (value === FREE_STYLE) delete next[member.id];
                              else next[member.id] = value as DebateStyle;
                              return next;
                            })}
                            options={styleOptions}
                            className="h-8 text-caption"
                          />
                          {styles[member.id] ? (
                            <span className="text-micro leading-4 text-muted-foreground">
                              {t(`room.discussion.styles.${styles[member.id]}Hint`)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-ui">
              <span className="text-caption font-medium text-muted-foreground">{t("room.discussion.rounds")}</span>
              <Input type="number" min={1} max={99} value={maxRounds} onChange={(event) => setMaxRounds(Math.max(1, Math.min(99, Number(event.target.value) || 1)))} />
              <span className="text-micro text-muted-foreground">{t("room.discussion.roundsHint")}</span>
            </label>
            <label className="grid gap-1.5 text-ui">
              <span className="text-caption font-medium text-muted-foreground">
                {t(mode === "debate" ? "room.discussion.judgeAgent" : "room.discussion.summaryAgent")}
              </span>
              <Select
                aria-label={t(mode === "debate" ? "room.discussion.judgeAgent" : "room.discussion.summaryAgent")}
                value={summaryAgentId}
                onValueChange={setSummaryAgentId}
                options={summaryOptions}
              />
              <span className="text-micro text-muted-foreground">{t("room.discussion.modelHint")}</span>
            </label>
          </div>
          {error ? <p className="rounded-md border border-destructive/35 bg-destructive/5 px-3 py-2 text-caption text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="shrink-0 border-t border-border/55 px-6 py-4">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("room.discussion.cancel")}</Button>
          <Button type="button" onClick={start}>{t("room.discussion.start")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
