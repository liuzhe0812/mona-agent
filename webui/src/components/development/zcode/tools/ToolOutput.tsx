/*
 * The ToolOutput implementation originated in vercel/ai-elements and is licensed under Apache-2.0.
 * It is adapted to Mona's local CodeBlock and utility imports.
 */
import { isValidElement, type HTMLAttributes, type ReactNode } from "react";
import { CodeBlock } from "../markdown/ai-elements/code-block";
import { cn } from "@/components/development/zcode/utils";

export function ToolOutput({
  className,
  output,
  errorText,
  ...props
}: {
  className?: string;
  output: unknown;
  errorText?: string;
} & HTMLAttributes<HTMLDivElement>) {
  if (!(output || errorText) || !errorText && (typeof output === "string" && !output.trim()
    || typeof output === "object" && output !== null && Object.keys(output).length === 0)) return null;

  let outputNode: ReactNode = null;
  if (!errorText) {
    outputNode = <div>{output as ReactNode}</div>;
    if (typeof output === "object" && output !== null && !isValidElement(output)) {
      outputNode = <CodeBlock code={JSON.stringify(output, null, 2) ?? ""} language="json" />;
    } else if (typeof output === "string") {
      outputNode = <CodeBlock code={output} language="json" />;
    }
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-ui-base uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "max-h-60 overflow-auto rounded-md text-ui-base [&_table]:w-full",
          errorText ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        )}
      >
        {errorText ? <div className="whitespace-pre-wrap p-3">{errorText}</div> : null}
        {outputNode}
      </div>
    </div>
  );
}
