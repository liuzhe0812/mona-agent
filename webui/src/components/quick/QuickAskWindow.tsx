import { useCallback, useEffect, useState } from "react";

import { ThreadComposer } from "@/components/thread/ThreadComposer";
import type { SendImage } from "@/hooks/useMonaStream";
import { useTheme } from "@/hooks/useTheme";
import { listSlashCommands } from "@/lib/api";
import {
  quickAskFocusChat,
  quickAskHide,
} from "@/lib/tauri";
import type { SlashCommand } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";

function toModelBadgeLabel(modelName: string | null): string | null {
  if (!modelName) return null;
  const trimmed = modelName.trim();
  if (!trimmed) return null;
  return trimmed.split("/").pop() ?? trimmed;
}

export function QuickAskWindow() {
  const { client, modelName, token } = useClient();
  useTheme();
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.body.classList.add("quick-ask-body");
    return () => document.body.classList.remove("quick-ask-body");
  }, []);

  useEffect(() => {
    let cancelled = false;
    listSlashCommands(token)
      .then((commands) => {
        if (!cancelled) setSlashCommands(commands);
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void quickAskHide();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSend = useCallback(
    async (content: string, images?: SendImage[]) => {
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const chatId = await client.newChat();
        client.sendMessage(chatId, content, images?.map((image) => image.media));
        await quickAskFocusChat(chatId);
        await quickAskHide();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setSubmitting(false);
      }
    },
    [client, submitting],
  );

  return (
    <div
      data-tauri-drag-region
      className="flex h-full w-full items-center justify-center bg-transparent px-2 py-1.5"
    >
      <div className="w-full max-w-[56rem]">
        <div
          data-tauri-drag-region
          className="flex h-6 items-center justify-between gap-3 px-3 text-[11px] font-medium text-muted-foreground"
        >
          <span className="flex items-center gap-2 text-foreground/80">
            <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--brand-red))]" aria-hidden />
            Mona 快捷提问
          </span>
          {error ? (
            <span role="alert" className="min-w-0 truncate text-destructive">{error}</span>
          ) : (
            <span className="select-none text-muted-foreground/65">Esc 关闭</span>
          )}
        </div>
        <div className="[&_textarea]:!min-h-[42px] [&_textarea]:!px-4 [&_textarea]:!pb-1 [&_textarea]:!pt-1 [&_textarea]:!text-[14px]">
          <ThreadComposer
            onSend={handleSend}
            disabled={submitting}
            isStreaming={submitting}
            placeholder="向 Mona 提问…"
            modelLabel={toModelBadgeLabel(modelName)}
            variant="hero"
            slashCommands={slashCommands}
            showHeroPromptChips={false}
          />
        </div>
      </div>
    </div>
  );
}
