/*
 * Derived from ZCode packages/ui/src/components/ai-elements/tool.tsx.
 * The ToolInput implementation originated in vercel/ai-elements and is licensed under Apache-2.0.
 * Adapted to Mona's copied CodeBlock import and hides empty parameters.
 */
import type { ComponentProps } from "react";
import { CodeBlock } from "../markdown/ai-elements/code-block";
import { cn } from "@/components/development/zcode/utils";
import { useZCodeIntl } from "../primitives/intl";

export function ToolInput({ input, className, ...props }: ComponentProps<"div"> & { input: unknown }) {
  const { intl } = useZCodeIntl();
  if (input == null || typeof input === "string" && !input.trim()
    || typeof input === "object" && Object.keys(input).length === 0) return null;
  return (
    <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-ui-base uppercase tracking-wide">
        {intl.formatMessage({ id: "chat.toolCall.mcp.parameters" })}
      </h4>
      <div className="max-h-60 overflow-auto rounded-md bg-muted/50">
        <CodeBlock code={JSON.stringify(input, null, 2) ?? ""} language="json" />
      </div>
    </div>
  );
}
