import { Suspense, lazy, useCallback, useState } from "react";
import { Check, Copy, WrapText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { useThemeValue } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  language?: string;
  code: string;
  className?: string;
  highlight?: boolean;
  showHeader?: boolean;
  constrainHeight?: boolean;
  conversation?: boolean;
}

interface HighlightedCodeProps {
  language: string;
  code: string;
  isDark: boolean;
  conversation: boolean;
  wrapLongLines: boolean;
}

const LazyHighlightedCode = lazy(async () => {
  const [
    { default: SyntaxHighlighter },
    { default: oneDark },
    { default: oneLight },
  ] = await Promise.all([
    import("react-syntax-highlighter/dist/esm/prism-async-light"),
    import("react-syntax-highlighter/dist/esm/styles/prism/one-dark"),
    import("react-syntax-highlighter/dist/esm/styles/prism/one-light"),
  ]);

  return {
    default({ language, code, isDark, conversation, wrapLongLines }: HighlightedCodeProps) {
      return (
        <SyntaxHighlighter
          language={language}
          style={isDark ? oneDark : oneLight}
          customStyle={{
            margin: 0,
            padding: conversation ? "0.75rem" : "1rem",
            ...(conversation
              ? {
                  background: "transparent",
                  color: "inherit",
                  fontSize: "inherit",
                  lineHeight: "inherit",
                }
              : { fontSize: "0.875rem", lineHeight: 1.6 }),
          }}
          PreTag="pre"
          wrapLongLines={wrapLongLines}
          codeTagProps={
            conversation
              ? {
                  style: {
                    whiteSpace: wrapLongLines ? "pre-wrap" : "pre",
                    overflowWrap: wrapLongLines ? "anywhere" : "normal",
                  },
                }
              : undefined
          }
        >
          {code}
        </SyntaxHighlighter>
      );
    },
  };
});

function PlainCodeFallback({
  code,
  conversation,
  wrapLongLines,
}: {
  code: string;
  conversation: boolean;
  wrapLongLines: boolean;
}) {
  return (
    <pre
      className={cn(
        "m-0 overflow-x-auto font-mono",
        conversation
          ? "p-3 text-caption leading-relaxed text-foreground"
          : "p-4 text-sm leading-[1.6]",
        wrapLongLines ? "whitespace-pre-wrap break-words" : "whitespace-pre",
      )}
    >
      <code>{code}</code>
    </pre>
  );
}

export function CodeBlock({
  language,
  code,
  className,
  highlight = true,
  showHeader = true,
  constrainHeight = true,
  conversation = false,
}: CodeBlockProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [wrapLongLines, setWrapLongLines] = useState(false);
  const isDark = useThemeValue() === "dark";
  const shouldWrapLongLines = conversation ? wrapLongLines : true;

  const onCopy = useCallback(async () => {
    setCopyError(false);
    if (!navigator.clipboard?.writeText) {
      if (conversation) setCopyError(true);
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
      if (conversation) setCopyError(true);
    }
  }, [code, conversation]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg",
        conversation && "border border-border/70 bg-card text-foreground",
        className,
      )}
    >
      {showHeader ? (
        <div
          className={cn(
            "flex items-center justify-between gap-3 px-4 py-1.5 font-medium",
            conversation
              ? "border-b border-border/60 bg-muted/35 text-caption text-muted-foreground"
              : cn(
                  "text-xs",
                  isDark ? "bg-zinc-800 text-zinc-300" : "bg-zinc-100 text-zinc-600",
                ),
          )}
        >
          <span className="lowercase font-mono">
            {language || t("code.fallbackLanguage")}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {conversation ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setWrapLongLines((current) => !current)}
                aria-label="自动换行"
                aria-pressed={wrapLongLines}
                className="gap-1 px-2 text-muted-foreground hover:text-foreground"
              >
                <WrapText aria-hidden="true" className="h-3.5 w-3.5" />
                <span>自动换行</span>
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void onCopy()}
              className={cn(
                "gap-1 rounded px-1.5 py-0.5 font-mono",
                conversation
                  ? "text-muted-foreground hover:text-foreground"
                  : isDark
                    ? "text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                    : "text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700",
              )}
              aria-label={
                conversation ? (copied ? "代码已复制" : "复制代码") : t("code.copyAria")
              }
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span>
                {conversation
                  ? copied
                    ? "已复制"
                    : "复制"
                  : copied
                    ? t("code.copied")
                    : t("code.copy")}
              </span>
            </Button>
          </div>
        </div>
      ) : null}
      {conversation && copyError ? (
        <p
          role="alert"
          className="border-b border-destructive/20 bg-destructive/5 px-3 py-1.5 text-caption text-destructive"
        >
          复制失败，请检查剪贴板权限。
        </p>
      ) : null}
      <div
        data-testid="code-block-body"
        className={cn(
          constrainHeight && "max-h-96 overflow-auto scrollbar-thin",
          conversation && "bg-background/50 text-caption text-foreground",
        )}
      >
        {highlight ? (
          <Suspense
            fallback={(
              <PlainCodeFallback
                code={code}
                conversation={conversation}
                wrapLongLines={shouldWrapLongLines}
              />
            )}
          >
            <LazyHighlightedCode
              language={language || "text"}
              code={code}
              isDark={isDark}
              conversation={conversation}
              wrapLongLines={shouldWrapLongLines}
            />
          </Suspense>
        ) : (
          <PlainCodeFallback
            code={code}
            conversation={conversation}
            wrapLongLines={shouldWrapLongLines}
          />
        )}
      </div>
    </div>
  );
}
