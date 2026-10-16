import type { AgentModelBinding } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { VideoModelSelector } from "./VideoModelSelector";

export function VideoModelControl({ token, value, onChange, disabled, loading, error, onRetry }: {
  token: string; value: AgentModelBinding | null;
  onChange: (binding: AgentModelBinding | null) => void | Promise<unknown>;
  disabled?: boolean; loading?: boolean; error?: string | null; onRetry: () => void;
}) {
  return <div className="flex min-w-0 items-center gap-2">
    <VideoModelSelector token={token} value={value} onChange={async (binding) => { await onChange(binding); }} disabled={disabled || loading || Boolean(error)} className="max-w-52" />
    {error ? <span className="flex items-center gap-1 text-micro text-destructive"><span>{error}</span><Button size="xs" variant="ghost" onClick={onRetry}>重试</Button></span> : null}
  </div>;
}
