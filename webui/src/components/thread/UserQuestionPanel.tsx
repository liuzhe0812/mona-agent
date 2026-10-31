import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClientContextOrNull } from "@/providers/ClientProvider";
import type { UserQuestionAnswer, UserQuestionRequest } from "@/lib/user-questions";

interface UserQuestionPanelProps {
  chatId: string | null;
}

interface DraftAnswer {
  selected: string[];
  custom: string;
}

function emptyDrafts(request: UserQuestionRequest): Record<string, DraftAnswer> {
  return Object.fromEntries(request.questions.map(({ id }) => [id, { selected: [], custom: "" }]));
}

function QuestionForm({
  chatId,
  request,
  onRemove,
}: {
  chatId: string;
  request: UserQuestionRequest;
  onRemove: (requestId: string) => void;
}) {
  const client = useClientContextOrNull()?.client;
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState(() => emptyDrafts(request));
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const updateDraft = (id: string, update: (draft: DraftAnswer) => DraftAnswer) => {
    setDrafts((current) => ({ ...current, [id]: update(current[id] ?? { selected: [], custom: "" }) }));
    setMissing((current) => current.filter((questionId) => questionId !== id));
  };

  const submit = async () => {
    const unanswered = request.questions.filter((question) => {
      const draft = drafts[question.id] ?? { selected: [], custom: "" };
      return draft.selected.length === 0 && draft.custom.trim() === "";
    }).map(({ id }) => id);
    if (unanswered.length > 0) {
      setMissing(unanswered);
      return;
    }
    if (!client) return;
    const answers: UserQuestionAnswer[] = request.questions.map((question) => ({
      id: question.id,
      selected: [...(drafts[question.id]?.selected ?? [])],
      ...(drafts[question.id]?.custom.trim() ? { custom: drafts[question.id].custom.trim() } : {}),
    }));
    setBusy(true);
    try {
      await client.answerUserQuestion(chatId, request.request_id, answers);
      onRemove(request.request_id);
    } catch {
      window.alert(t("userQuestion.failed"));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!client) return;
    setBusy(true);
    try {
      await client.answerUserQuestion(chatId, request.request_id, null);
      onRemove(request.request_id);
    } catch {
      window.alert(t("userQuestion.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-label={t("userQuestion.pending")}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-ui font-medium">{t("userQuestion.title")}</h2>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
          {t("common.cancel")}
        </Button>
      </div>
      <div className="space-y-4">
        {request.questions.map((question) => {
          const draft = drafts[question.id] ?? { selected: [], custom: "" };
          const multi = question.multi_select === true;
          return (
            <fieldset key={question.id} className="min-w-0 space-y-2" aria-describedby={missing.includes(question.id) ? `${request.request_id}-${question.id}-error` : undefined}>
              <legend className="text-ui font-medium">
                {question.header && <span className="mr-2 text-muted-foreground">{question.header}</span>}
                {question.question}
              </legend>
              {question.options?.map((option) => {
                const checked = draft.selected.includes(option.label);
                return (
                  <label key={option.label} className="flex cursor-pointer items-start gap-2 text-ui">
                    <input
                      type={multi ? "checkbox" : "radio"}
                      name={`${request.request_id}-${question.id}`}
                      checked={checked}
                      disabled={busy}
                      onChange={() => updateDraft(question.id, (current) => ({
                        ...current,
                        selected: multi
                          ? checked ? current.selected.filter((item) => item !== option.label) : [...current.selected, option.label]
                          : [option.label],
                      }))}
                    />
                    <span className="min-w-0 break-words">
                      <span>{option.label}</span>
                      {option.description && <span className="ml-2 text-muted-foreground">{option.description}</span>}
                    </span>
                  </label>
                );
              })}
              {!multi && draft.selected.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => updateDraft(question.id, (current) => ({ ...current, selected: [] }))}
                >
                  {t("userQuestion.clearSelection")}
                </Button>
              )}
              <Textarea
                aria-label={`${question.header ? `${question.header}：` : ""}${question.question}：${t("userQuestion.customAnswer")}`}
                placeholder={t("userQuestion.placeholder")}
                value={draft.custom}
                disabled={busy}
                maxLength={8000}
                onChange={(event) => updateDraft(question.id, (current) => ({ ...current, custom: event.target.value }))}
                className="min-h-16"
              />
              {missing.includes(question.id) && (
                <p id={`${request.request_id}-${question.id}-error`} className="text-caption text-destructive" role="alert">
                  {t("userQuestion.missing")}
                </p>
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end">
        <Button type="button" disabled={busy || !client} onClick={() => void submit()}>
          {busy ? t("userQuestion.submitting") : t("userQuestion.submit")}
        </Button>
      </div>
    </section>
  );
}

export function UserQuestionPanel({ chatId }: UserQuestionPanelProps) {
  const client = useClientContextOrNull()?.client;
  const [snapshot, setSnapshot] = useState<{ chatId: string | null; requests: UserQuestionRequest[] }>({
    chatId: null,
    requests: [],
  });

  useEffect(() => {
    if (!chatId || !client) {
      setSnapshot({ chatId, requests: [] });
      return;
    }
    setSnapshot({ chatId, requests: client.getUserQuestions(chatId) });
    return client.onChat(chatId, (event) => {
      if (event.event === "user_questions" && event.chat_id === chatId) {
        setSnapshot({ chatId, requests: event.requests });
      }
    });
  }, [chatId, client]);

  const remove = (requestId: string) => {
    setSnapshot((current) => ({
      ...current,
      requests: current.requests.filter((request) => request.request_id !== requestId),
    }));
  };

  const requests = snapshot.chatId === chatId ? snapshot.requests : [];
  if (!chatId || requests.length === 0) return null;
  return (
    <div className="mb-3 max-h-[50vh] space-y-3 overflow-y-auto" aria-live="polite">
      {requests.map((request) => (
        <QuestionForm key={`${chatId}:${request.request_id}`} chatId={chatId} request={request} onRemove={remove} />
      ))}
    </div>
  );
}
