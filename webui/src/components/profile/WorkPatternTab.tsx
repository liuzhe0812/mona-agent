import { ExternalLink } from "lucide-react";

import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import type { ProfileStartRequest, RichProfile } from "@/lib/profile-api";
import { openExternalUrl } from "@/lib/tauri";

interface WorkPatternTabProps {
  data?: RichProfile;
  loading: boolean;
  onAskMona?: (prompt: string) => void;
  onStartAdvice?: (request: ProfileStartRequest) => void;
  onOpenSession?: (key: string) => void;
}

export function WorkPatternTab({ data, loading }: WorkPatternTabProps) {
  const allAdvice = data?.advice?.items ?? [];
  const currentIds = data?.advice?.current_ids;
  const item = currentIds
    ? allAdvice.find((advice) => advice.id === currentIds[0])
    : allAdvice[0];

  if (loading) return <div className="flex h-full items-center justify-center text-body text-muted-foreground">加载中…</div>;

  if (!item) {
    return <div className="flex h-full items-center justify-center text-caption text-muted-foreground">{emptyAdviceText(data?.advice?.generation_status, data?.advice?.empty_reason)}</div>;
  }

  const knowledgeTitle = item.knowledge?.title?.trim() || item.title?.trim() || "值得系统了解的一项知识";
  const knowledgeContent = item.knowledge?.content?.trim() || item.why_now?.trim() || "";
  const learningAdvice = item.learning_advice?.trim() || item.starter_content?.trim() || "";
  const resources = (item.resources ?? []).filter((resource) => safeHttpUrl(resource.url));

  return (
    <article className="mx-auto w-full max-w-5xl px-8 py-8 lg:px-10 lg:py-10">
      <p className="text-caption text-muted-foreground">AI 给你的一个建议</p>
      <h2 className="mt-4 text-title font-semibold">{knowledgeTitle}</h2>
      {knowledgeContent ? (
        <div className="mt-5 text-body leading-7 text-foreground">
          <MarkdownTextRenderer>{knowledgeContent}</MarkdownTextRenderer>
        </div>
      ) : null}
      {learningAdvice ? (
        <section className="mt-8">
          <h3 className="text-title-sm font-semibold">怎么提升</h3>
          <div className="mt-4 text-body leading-7 text-foreground">
            <MarkdownTextRenderer>{learningAdvice}</MarkdownTextRenderer>
          </div>
        </section>
      ) : null}
      {resources.length ? (
        <section className="mt-8">
          <h3 className="text-title-sm font-semibold">参考资源</h3>
          <div className="mt-4 space-y-4">
            {resources.map((resource) => (
              <a
                key={`${resource.url}-${resource.title}`}
                href={resource.url}
                target="_blank"
                rel="noreferrer noopener"
                className="group block w-fit text-ui"
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalUrl(resource.url);
                }}
              >
                <span className="flex items-center gap-1 text-primary underline underline-offset-2 group-hover:opacity-80">
                  {resource.title}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="mt-1 block text-ui text-muted-foreground">{resourceDomain(resource.url)}</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}

function safeHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resourceDomain(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function emptyAdviceText(status?: string, reason?: string): string {
  if (status === "failed") return "建议生成失败，现有记录仍然保留；请更新画像后重试。";
  if (status === "unavailable") return "建议依赖暂时不可用。";
  if (status === "stale") return "建议依据已过期，请更新画像。";
  return reason || "当前记录还不足以给出具体建议。";
}
