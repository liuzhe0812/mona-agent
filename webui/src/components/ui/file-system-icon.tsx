import { useState } from "react";

import { getFileIconFallback, getFileIconSource } from "@/lib/file-icons";
import { cn } from "@/lib/utils";

export function FileSystemIcon({ name, isDirectory = false, expanded = false, className }: {
  name: string;
  isDirectory?: boolean;
  expanded?: boolean;
  className?: string;
}) {
  const source = getFileIconSource(name, isDirectory, expanded);
  const [failure, setFailure] = useState<{ source: string; fallback: string } | null>(null);
  const displayed = failure?.source === source ? failure.fallback : source;
  return <img src={displayed} alt="" aria-hidden="true" width={16} height={16} draggable={false}
    className={cn("h-4 w-4 shrink-0 object-contain", className)}
    onError={() => {
      const fallback = getFileIconFallback(displayed);
      if (fallback) setFailure({ source, fallback });
    }} />;
}
