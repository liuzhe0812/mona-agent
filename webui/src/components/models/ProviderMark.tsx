import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg";
import alibabaCloud from "@lobehub/icons-static-svg/icons/alibabacloud-color.svg";
import codebuddy from "@lobehub/icons-static-svg/icons/codebuddy-color.svg";
import { sourceId } from "./model-sources";
import { cn } from "@/lib/utils";

export function ProviderMark({ provider, label, className }: { provider: string; label?: string; className?: string }) {
  const source = sourceId(provider);
  const icon = source === "mona_managed" || source === "inherit" ? "/brand/mona_icon.png" : source === "openai" ? openai : source === "anthropic" ? anthropic : source === "native:codebuddy" ? codebuddy
    : ["dashscope", "dashscope_coding_plan", "aliyun-bailian-coding", "aliyun-bailian-token-plan-cn", "aliyun-bailian-token-plan-team-cn"].includes(source) ? alibabaCloud : undefined;
  return icon ? <img src={icon} alt="" className={cn("h-5 w-5 shrink-0 object-contain", ["openai", "anthropic"].includes(source) && "dark:invert", className)} />
    : <span aria-hidden className={cn("flex h-5 w-5 shrink-0 items-center justify-center text-caption font-semibold", className)}>{(label || provider).slice(0, 2).toUpperCase()}</span>;
}
