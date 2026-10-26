import { ExternalLink } from "lucide-react";

import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import { SectionHeader } from "@/components/ui/page-header";
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
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:grid-rows-2">
      <article className="profile-panel overflow-hidden md:row-span-2">
        <p className="shrink-0 text-caption text-muted-foreground">AI 给你的一个建议</p>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2 scrollbar-hover" tabIndex={0} role="region" aria-label="知识建议">
          <h2 className="text-title font-semibold tracking-tight text-foreground lg:text-display-sm">{knowledgeTitle}</h2>
          {knowledgeContent ? (
            <div className="mt-4">
              <MarkdownTextRenderer className="text-body-lg text-[hsl(var(--text-700))] prose-a:text-info">{knowledgeContent}</MarkdownTextRenderer>
            </div>
          ) : null}
        </div>
      </article>

      <section className="profile-panel overflow-hidden">
        <SectionHeader title="怎么提升" className="mb-3 shrink-0 font-semibold" />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2 scrollbar-hover" tabIndex={0} role="region" aria-label="提升建议">
          {learningAdvice ? (
            <MarkdownTextRenderer className="text-body-lg text-[hsl(var(--text-700))] prose-a:text-info">{learningAdvice}</MarkdownTextRenderer>
          ) : <p className="text-caption text-muted-foreground">暂无提升建议</p>}
        </div>
      </section>

      <section className="profile-panel overflow-hidden">
        <SectionHeader title="参考资源" className="mb-3 shrink-0 font-semibold" />
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-2 scrollbar-hover" tabIndex={0} role="region" aria-label="参考资源">
          {resources.length ? resources.map((resource) => (
            <a
              key={`${resource.url}-${resource.title}`}
              href={resource.url}
              target="_blank"
              rel="noreferrer noopener"
              className="group block w-fit max-w-full break-words rounded-xs text-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.preventDefault();
                void openExternalUrl(resource.url);
              }}
            >
              <span className="flex items-center gap-1 text-info underline decoration-border underline-offset-4 group-hover:decoration-current">
                {resource.title}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="mt-1 block text-ui text-muted-foreground">{resourceDomain(resource.url)}</span>
            </a>
          )) : <p className="text-caption text-muted-foreground">暂无参考资源</p>}
        </div>
      </section>
    </div>
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
