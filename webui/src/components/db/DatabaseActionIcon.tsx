import { cn } from "@/lib/utils";

export function DatabaseActionIcon({ action, className }: {
  action: "create" | "edit" | "drop" | "export" | "import" | "refresh";
  className?: string;
}) {
  return <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" className={cn("h-4 w-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="8" cy="4.5" rx="5.5" ry="2.5" />
    <path d="M2.5 4.5v10c0 1.4 2.5 2.5 5.5 2.5M13.5 4.5v4M2.5 9.5c0 1.4 2.5 2.5 5.5 2.5" />
    {action === "create" && <path d="M14 11v7m-3.5-3.5h7" />}
    {action === "drop" && <path d="M10.5 14.5h7" />}
    {action === "edit" && <path d="m10 15.5 5.5-5.5 2 2-5.5 5.5H10zm4-4 2 2" />}
    {action === "export" && <path d="M14 10v8m-3-3 3 3 3-3" />}
    {action === "import" && <path d="M14 18v-8m-3 3 3-3 3 3" />}
    {action === "refresh" && <path d="M18 13a4 4 0 1 0-.5 4M18 10v3h-3" />}
  </svg>;
}
