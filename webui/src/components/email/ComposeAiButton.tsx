import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useMonaStream, type SendOptions } from "@/hooks/useMonaStream";
import { useClientOptional } from "@/providers/ClientProvider";
import type { EmailMessage } from "./lib/types";

type ComposerMode = "compose" | "reply" | "replyAll" | "forward";

interface Props {
  mode: ComposerMode;
  baseMessage: EmailMessage | null;
  bodyText: string;
  onResult: (html: string) => void;
  disabled?: boolean;
}

function htmlToPlainText(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function buildDraftReplyPrompt(base: EmailMessage, currentBody: string): string {
  const originalBody = base.bodyText || htmlToPlainText(base.bodyHtml || "");
  const truncated = originalBody.slice(0, 4000);
  const truncatedNote =
    originalBody.length > 4000
      ? "\n…（原邮件正文已截断）"
      : "";
  return [
    "请根据以下原邮件，草拟一封回复邮件的正文。",
    "要求：",
    "- 语气专业、礼貌",
    "- 直接回复要点，不要寒暄过多",
    "- 只输出回复正文（纯文本），不要包含主题、收件人等头部信息",
    "- 不要解释你做了什么",
    "",
    `原邮件主题: ${base.subject}`,
    `原邮件发件人: ${base.fromName ?? ""} <${base.fromAddress}>`,
    "",
    "原邮件正文:",
    truncated + truncatedNote,
    "",
    currentBody.trim()
      ? `当前已有的草稿内容（请在此基础上完善）:\n${currentBody.slice(0, 2000)}`
      : "",
  ].filter(Boolean).join("\n");
}

function buildPolishPrompt(bodyText: string, tone: string): string {
  const toneInstruction =
    tone === "formal"
      ? "语气改为正式、专业"
      : tone === "casual"
        ? "语气改为轻松、随意"
        : "保持原语气";
  return [
    `请润色以下邮件正文。要求：`,
    `- ${toneInstruction}`,
    `- 保持原意不变`,
    `- 只输出润色后的正文（纯文本），不要解释`,
    "",
    "邮件正文:",
    bodyText.slice(0, 4000),
  ].join("\n");
}

export function ComposeAiButton({ mode, baseMessage, bodyText, onResult, disabled }: Props) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingDisplayRef = useRef<string | null>(null);
  const { client } = useClientOptional();
  const { messages, isStreaming, send } = useMonaStream(chatId);

  // Send pending prompt when chatId becomes available
  useEffect(() => {
    if (!chatId || isStreaming || creatingChat) return;
    const prompt = pendingPromptRef.current;
    if (!prompt) return;
    const display = pendingDisplayRef.current;
    pendingPromptRef.current = null;
    pendingDisplayRef.current = null;
    const opts: SendOptions | undefined = display ? { displayContent: display } : undefined;
    send(prompt, undefined, opts);
  }, [chatId, creatingChat, isStreaming, send]);

  // Extract result when streaming completes
  useEffect(() => {
    if (pendingLabel === null || isStreaming || creatingChat) return;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content.trim().length > 0);
    if (!lastAssistant) return;
    const text = lastAssistant.content.trim();
    // Convert plain text to simple HTML paragraphs
    const html = text
      .split(/\n\n+/)
      .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
      .join("");
    onResult(html);
    setPendingLabel(null);
  }, [messages, isStreaming, creatingChat, pendingLabel, onResult]);

  const runAction = useCallback(
    async (prompt: string, label: string) => {
      if (isStreaming || creatingChat) return;
      pendingPromptRef.current = prompt;
      pendingDisplayRef.current = label;
      setPendingLabel(label);

      if (chatId) {
        const opts: SendOptions = { displayContent: label };
        send(prompt, undefined, opts);
        return;
      }

      if (!client) return;
      setCreatingChat(true);
      try {
        const nextChatId = await client.newChat(5_000, true);
        setChatId(nextChatId);
      } catch {
        pendingPromptRef.current = null;
        pendingDisplayRef.current = null;
        setPendingLabel(null);
      } finally {
        setCreatingChat(false);
      }
    },
    [chatId, client, creatingChat, isStreaming, send],
  );

  const handleDraftReply = useCallback(() => {
    if (!baseMessage) return;
    const prompt = buildDraftReplyPrompt(baseMessage, bodyText);
    void runAction(prompt, "草拟回复");
  }, [baseMessage, bodyText, runAction]);

  const handlePolish = useCallback(
    (tone: string) => {
      if (!bodyText.trim()) return;
      const prompt = buildPolishPrompt(bodyText, tone);
      const label = tone === "formal" ? "润色（正式）" : tone === "casual" ? "润色（随意）" : "润色";
      void runAction(prompt, label);
    },
    [bodyText, runAction],
  );

  const canDraftReply = mode !== "compose" && !!baseMessage;
  const isLoading = pendingLabel !== null || creatingChat;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
          disabled={disabled || isLoading}
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          AI
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          disabled={!canDraftReply || isStreaming}
          onClick={handleDraftReply}
        >
          <Sparkles className="mr-2 h-3.5 w-3.5" />
          草拟回复
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!bodyText.trim() || isStreaming}>
            <Sparkles className="mr-2 h-3.5 w-3.5" />
            润色正文
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => handlePolish("default")}>
              润色（保持语气）
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handlePolish("formal")}>
              润色（正式语气）
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handlePolish("casual")}>
              润色（轻松语气）
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
