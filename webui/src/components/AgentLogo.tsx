import { cn } from "@/lib/utils";

type AgentLogoState = "working" | "idle" | "welcome";

interface AgentLogoProps {
  state: AgentLogoState;
  /** Compact crop used where Mona is an identity, rather than a status illustration. */
  variant?: "scene" | "avatar";
  className?: string;
  title?: string;
}

const AGENT_LOGO_STYLES = `
  .mona-agent-logo::before {
    content: "";
    position: absolute;
    inset: -3px;
    z-index: 0;
    border: 1.5px solid transparent;
    border-radius: 24%;
    pointer-events: none;
  }
  .mona-agent-logo--working::before {
    border-color: hsl(var(--ai-cyan) / 0.88);
    box-shadow: 0 0 0 1px hsl(var(--ai-cyan) / 0.14), 0 0 14px hsl(var(--ai-cyan) / 0.28);
    animation: mona-agent-working-ring 1200ms ease-in-out infinite;
  }
  @keyframes mona-agent-working-ring {
    0%, 100% { opacity: 0.48; transform: scale(0.98); }
    50% { opacity: 1; transform: scale(1.04); }
  }
  @media (prefers-reduced-motion: reduce) {
    .mona-agent-logo--working::before {
      animation: none;
      transform: none;
    }
  }
`;

export function AgentLogo({ state, variant = "scene", className, title }: AgentLogoProps) {
  const stateClass =
    state === "working"
      ? "mona-agent-logo--working"
      : state === "welcome"
        ? "mona-agent-logo--welcome"
        : "mona-agent-logo--idle";
  const imageSrc = variant === "avatar" ? "/brand/mona_avatar_white.png" : "/brand/mona_app_icon.png";

  return (
    <span
      className={cn("mona-agent-logo relative isolate block select-none", stateClass, className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <style>{AGENT_LOGO_STYLES}</style>
      <img
        src={imageSrc}
        alt=""
        aria-hidden
        draggable={false}
        className={cn(
          "relative z-[1] block h-full w-full object-contain",
          variant === "scene" && "rounded-[24%]",
        )}
        style={variant === "scene" ? { clipPath: "inset(0 round 24%)" } : undefined}
      />
    </span>
  );
}
