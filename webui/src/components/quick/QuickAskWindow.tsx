import { useCallback, useEffect, useState } from "react";
import { FileText, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import type { SendImage, SendOptions } from "@/hooks/useMonaStream";
import { useTheme } from "@/hooks/useTheme";
import { listSlashCommands } from "@/lib/api";
import {
  quickAskFocusChat,
  quickAskHide,
  quickAskOpenNote,
  quickAskOpenSsh,
} from "@/lib/tauri";
import type { SlashCommand } from "@/lib/types";
import { cn } from "@/lib/utils";
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
  const [imageMode, setImageMode] = useState(false);
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
    async (content: string, images?: SendImage[], options?: SendOptions) => {
      if (submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const chatId = await client.newChat();
        client.sendMessage(chatId, content, images?.map((image) => image.media), {
          imageGeneration: options?.imageGeneration,
        });
        await quickAskFocusChat(chatId);
        await quickAskHide();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setSubmitting(false);
      }
    },
    [client, submitting],
  );

  const actionClass = cn(
    "h-9 rounded-full border border-border/65 bg-card px-3 text-[12px] font-medium",
    "text-foreground/80 shadow-[0_2px_8px_rgba(15,23,42,0.05)] hover:bg-accent hover:text-foreground",
    "disabled:pointer-events-none disabled:opacity-55",
  );

  return (
    <div
      data-tauri-drag-region
      className="flex h-full w-full items-end justify-center bg-transparent pb-6"
    >
      <div className="w-full max-w-[58rem]">
        <ThreadComposer
          onSend={handleSend}
          disabled={submitting}
          isStreaming={submitting}
          placeholder="在 Mona 本地随时向 Codex 提问"
          modelLabel={toModelBadgeLabel(modelName)}
          variant="hero"
          slashCommands={slashCommands}
          imageMode={imageMode}
          onImageModeChange={setImageMode}
          leadingActions={
            <>
              <Button
                type="button"
                variant="ghost"
                className={actionClass}
                title="新建 SSH 会话"
                aria-label="新建 SSH 会话"
                disabled={submitting}
                onClick={() => void quickAskOpenSsh()}
              >
                <Terminal className="mr-1.5 h-4 w-4 text-[#4f9de8]" aria-hidden />
                SSH
              </Button>
              <Button
                type="button"
                variant="ghost"
                className={actionClass}
                title="新建笔记"
                aria-label="新建笔记"
                disabled={submitting}
                onClick={() => void quickAskOpenNote()}
              >
                <FileText className="mr-1.5 h-4 w-4 text-[#eba45d]" aria-hidden />
                笔记
              </Button>
            </>
          }
        />
        {error ? (
          <div
            role="alert"
            className="mx-auto mt-2 max-w-[58rem] rounded-full border border-destructive/30 bg-background/90 px-3 py-1.5 text-center text-[12px] font-medium text-destructive shadow-sm"
          >
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
