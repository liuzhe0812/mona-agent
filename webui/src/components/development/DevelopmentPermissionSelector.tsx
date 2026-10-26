import { useRef, useState } from "react";
import { ChevronDown, LockKeyhole, ShieldQuestion, Sparkles, Zap } from "lucide-react";
import { TooltipButton } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type DevelopmentPermissionMode = "ask" | "auto" | "full_access";

interface DevelopmentPermissionSelectorProps {
  mode: DevelopmentPermissionMode;
  disabled?: boolean;
  readonly?: boolean;
  onChange: (mode: DevelopmentPermissionMode) => void | Promise<void>;
}

const MODES: { value: DevelopmentPermissionMode; label: string; icon: typeof ShieldQuestion }[] = [
  { value: "ask", label: "请求批准", icon: ShieldQuestion },
  { value: "auto", label: "自动审批", icon: Sparkles },
  { value: "full_access", label: "完全访问", icon: Zap },
];

export function DevelopmentPermissionSelector({
  mode,
  disabled = false,
  readonly = false,
  onChange,
}: DevelopmentPermissionSelectorProps) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const current = MODES.find((option) => option.value === mode) ?? MODES[0];
  const CurrentIcon = readonly ? LockKeyhole : current.icon;

  const selectMode = async (value: string) => {
    if (disabled || readonly || pending.current || value === mode) return;
    pending.current = true;
    setBusy(true);
    try {
      await onChange(value as DevelopmentPermissionMode);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled || readonly || busy}>
        <TooltipButton
          type="button"
          variant="ghost"
          size="sm"
          className="composer-icon-control gap-1.5 px-2"
          aria-label={readonly ? "权限模式：只读" : `权限模式：${current.label}`}
          aria-busy={busy}
          title={readonly ? "只读" : current.label}
        >
          <CurrentIcon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="composer-control-label">{readonly ? "只读" : current.label}</span>
          {!readonly && <ChevronDown className="composer-control-chevron h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        </TooltipButton>
      </DropdownMenuTrigger>
      {!readonly && (
        <DropdownMenuContent align="start" className="w-40">
          {MODES.map(({ value, label, icon: Icon }) => (
            <DropdownMenuItem key={value} disabled={disabled || busy} className="gap-2" onSelect={() => { void selectMode(value); }}>
              <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
