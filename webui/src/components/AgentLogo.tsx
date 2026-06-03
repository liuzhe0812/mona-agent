import { useId } from "react";

import { cn } from "@/lib/utils";

type AgentLogoState = "working" | "idle" | "welcome";

interface AgentLogoProps {
  state: AgentLogoState;
  className?: string;
  title?: string;
}

const AGENT_LOGO_STYLES = `
  .mona-agent-logo * {
    transform-box: fill-box;
  }
  .mona-agent-logo--welcome .plush-body {
    animation: mona-agent-welcome-breathe 1800ms ease-in-out infinite;
    transform-origin: 50% 84%;
  }
  .mona-agent-logo--welcome .plush-head {
    animation: mona-agent-welcome-head 2400ms ease-in-out infinite;
    transform-origin: 50% 58%;
  }
  .mona-agent-logo--welcome .wave-paw {
    animation: mona-agent-wave 1250ms ease-in-out infinite;
    transform-origin: 38% 83%;
  }
  .mona-agent-logo--welcome .tail {
    animation: mona-agent-welcome-tail 2200ms ease-in-out infinite;
    transform-origin: 18% 50%;
  }
  .mona-agent-logo--welcome .eye-shine {
    animation: mona-agent-eye-shine 1180ms ease-in-out infinite;
  }
  .mona-agent-logo--working .plush-body {
    animation: mona-agent-body-bob 980ms ease-in-out infinite;
    transform-origin: 50% 84%;
  }
  .mona-agent-logo--working .plush-head {
    animation: mona-agent-head-focus 1420ms ease-in-out infinite;
    transform-origin: 50% 58%;
  }
  .mona-agent-logo--working .left-paw {
    animation: mona-agent-left-type 410ms ease-in-out infinite;
    transform-origin: 72% 28%;
  }
  .mona-agent-logo--working .right-paw {
    animation: mona-agent-right-type 370ms ease-in-out infinite;
    transform-origin: 28% 30%;
  }
  .mona-agent-logo--working .screen-glow {
    animation: mona-agent-screen-glow 1150ms ease-in-out infinite;
  }
  .mona-agent-logo--working .cursor {
    animation: mona-agent-cursor-blink 620ms steps(2, end) infinite;
  }
  .mona-agent-logo--working .code-a {
    animation: mona-agent-code-scan 1300ms ease-in-out infinite;
  }
  .mona-agent-logo--working .code-b {
    animation: mona-agent-code-scan 1300ms ease-in-out 180ms infinite;
  }
  .mona-agent-logo--working .key-a {
    animation: mona-agent-key-tap 410ms ease-in-out infinite;
  }
  .mona-agent-logo--working .key-b {
    animation: mona-agent-key-tap 370ms ease-in-out 120ms infinite;
  }
  .mona-agent-logo--working .eye-shine {
    animation: mona-agent-eye-shine 980ms ease-in-out infinite;
  }
  .mona-agent-logo .tail {
    animation: mona-agent-tail-twitch 1500ms ease-in-out infinite;
    transform-origin: 18% 50%;
  }
  .mona-agent-logo--idle .sleeping-agent {
    animation: mona-agent-idle-breathe 2600ms ease-in-out infinite;
    transform-origin: 50% 84%;
  }
  .mona-agent-logo--idle .sleeping-head {
    animation: mona-agent-sleepy-head 3200ms ease-in-out infinite;
    transform-origin: 54% 66%;
  }
  .mona-agent-logo--idle .tail {
    animation: mona-agent-sleepy-tail 3800ms ease-in-out infinite;
    transform-origin: 20% 78%;
  }
  .mona-agent-logo--idle .pillow-paw {
    animation: mona-agent-paw-breathe 2600ms ease-in-out infinite;
    transform-origin: 50% 50%;
  }
  .mona-agent-logo--idle .zzz-one {
    animation: mona-agent-zzz-float 2800ms ease-in-out infinite;
  }
  .mona-agent-logo--idle .zzz-two {
    animation: mona-agent-zzz-float 2800ms ease-in-out 520ms infinite;
  }
  .mona-agent-logo--idle .zzz-three {
    animation: mona-agent-zzz-float 2800ms ease-in-out 980ms infinite;
  }
  .mona-agent-logo--idle .sleep-line {
    animation: mona-agent-sleep-line 2600ms ease-in-out infinite;
  }
  @keyframes mona-agent-body-bob {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-1.8px); }
  }
  @keyframes mona-agent-welcome-breathe {
    0%, 100% { transform: translateY(0) scaleY(1); }
    50% { transform: translateY(-1.5px) scaleY(1.012); }
  }
  @keyframes mona-agent-welcome-head {
    0%, 100% { transform: translateY(0) rotate(0deg); }
    50% { transform: translateY(-0.8px) rotate(-0.8deg); }
  }
  @keyframes mona-agent-wave {
    0%, 100% { transform: translate(0, 0) rotate(0deg); }
    35% { transform: translate(-1.8px, -4px) rotate(-14deg); }
    70% { transform: translate(1px, -2px) rotate(8deg); }
  }
  @keyframes mona-agent-welcome-tail {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(6deg); }
  }
  @keyframes mona-agent-head-focus {
    0%, 100% { transform: translate(0, 0) rotate(0deg); }
    35% { transform: translate(-0.8px, 0.4px) rotate(-1deg); }
    68% { transform: translate(0.8px, -0.2px) rotate(0.9deg); }
  }
  @keyframes mona-agent-left-type {
    0%, 100% { transform: translate(0, 0) rotate(0deg); }
    45% { transform: translate(2.8px, 3px) rotate(8deg); }
  }
  @keyframes mona-agent-right-type {
    0%, 100% { transform: translate(0, 0) rotate(0deg); }
    48% { transform: translate(-2.8px, 3px) rotate(-8deg); }
  }
  @keyframes mona-agent-screen-glow {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 0.86; }
  }
  @keyframes mona-agent-cursor-blink {
    0%, 44% { opacity: 1; }
    45%, 100% { opacity: 0; }
  }
  @keyframes mona-agent-code-scan {
    0%, 100% { opacity: 0.45; transform: translateX(0); }
    45% { opacity: 1; transform: translateX(2px); }
  }
  @keyframes mona-agent-key-tap {
    0%, 100% { opacity: 0.32; transform: translateY(0); }
    48% { opacity: 0.95; transform: translateY(1px); }
  }
  @keyframes mona-agent-eye-shine {
    0%, 100% { opacity: 0.58; }
    50% { opacity: 1; }
  }
  @keyframes mona-agent-tail-twitch {
    0%, 82%, 100% { transform: rotate(0deg); }
    88% { transform: rotate(8deg); }
    94% { transform: rotate(-5deg); }
  }
  @keyframes mona-agent-idle-breathe {
    0%, 100% { transform: translateY(0) scaleY(1); }
    50% { transform: translateY(-1.4px) scaleY(1.018); }
  }
  @keyframes mona-agent-sleepy-head {
    0%, 100% { transform: rotate(-8deg) translate(0, 0); }
    50% { transform: rotate(-8deg) translate(0.8px, 1.2px); }
  }
  @keyframes mona-agent-sleepy-tail {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(4deg); }
  }
  @keyframes mona-agent-paw-breathe {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-1px); }
  }
  @keyframes mona-agent-zzz-float {
    0% { opacity: 0; transform: translate(0, 7px) scale(0.84); }
    25% { opacity: 0.85; }
    78% { opacity: 0.85; }
    100% { opacity: 0; transform: translate(6px, -14px) scale(1.04); }
  }
  @keyframes mona-agent-sleep-line {
    0%, 100% { opacity: 0.82; }
    50% { opacity: 0.48; }
  }
  @media (prefers-reduced-motion: reduce) {
    .mona-agent-logo * {
      animation: none !important;
    }
  }
`;

export function AgentLogo({ state, className, title }: AgentLogoProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = {
    eye: `mona-agent-eye-${rawId}`,
    screen: `mona-agent-screen-${rawId}`,
    yellow: `mona-agent-yellow-${rawId}`,
    shadow: `mona-agent-shadow-${rawId}`,
    glow: `mona-agent-glow-${rawId}`,
  };

  const stateClass =
    state === "working"
      ? "mona-agent-logo--working"
      : state === "welcome"
        ? "mona-agent-logo--welcome"
        : "mona-agent-logo--idle";

  return (
    <svg
      className={cn(
        "mona-agent-logo block select-none",
        stateClass,
        className,
      )}
      viewBox="0 0 128 128"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable={false}
    >
      <style>{AGENT_LOGO_STYLES}</style>
      <defs>
        <radialGradient id={ids.eye} cx="50%" cy="42%" r="68%">
          <stop offset="0%" stopColor="#7fc8ff" />
          <stop offset="45%" stopColor="#3c83da" />
          <stop offset="100%" stopColor="#1151b7" />
        </radialGradient>
        <linearGradient id={ids.screen} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#16344d" />
          <stop offset="100%" stopColor="#071422" />
        </linearGradient>
        <linearGradient id={ids.yellow} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#fff45c" />
          <stop offset="100%" stopColor="#ffd400" />
        </linearGradient>
        <filter id={ids.shadow} x="-22%" y="-20%" width="144%" height="150%">
          <feDropShadow dx="0" dy="7" stdDeviation="4" floodColor="#0f172a" floodOpacity="0.18" />
        </filter>
        <filter id={ids.glow} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {state === "working" ? <WorkingAgent ids={ids} /> : null}
      {state === "welcome" ? <WelcomeAgent ids={ids} /> : null}
      {state === "idle" ? <IdleAgent ids={ids} /> : null}
    </svg>
  );
}

function WorkingAgent({ ids }: { ids: Record<"eye" | "screen" | "yellow" | "shadow" | "glow", string> }) {
  return (
    <>
      <ellipse cx="64" cy="118" rx="42" ry="6" fill="#0f172a" opacity="0.13" />
      <g className="plush-body" filter={`url(#${ids.shadow})`}>
        <g className="tail">
          <path d="M90 101c18-8 13-26 24-32" fill="none" stroke="#18192b" strokeWidth="7.4" strokeLinecap="round" />
          <path d="M113 70c5-4 9 0 8 7" fill="none" stroke="#f1eee2" strokeWidth="7.4" strokeLinecap="round" />
        </g>
        <path d="M43 74c-8 9-12 23-12 43h66c0-20-4-34-12-43-13 7-29 7-42 0z" fill="#18192b" />
        <path d="M46 75h36L64 96z" fill={`url(#${ids.yellow})`} />
        <path d="M78 76c8 1 14 5 18 10l-17 2z" fill="#f6d34b" />
        <circle cx="53" cy="107" r="3.8" fill="#e5c06f" />
        <circle cx="75" cy="107" r="3.8" fill="#e5c06f" />
        <path d="M32 116c4-8 15-8 20 0z" fill="#18192b" />
        <path d="M76 116c5-8 16-8 20 0z" fill="#18192b" />
        <circle cx="35" cy="115" r="4.6" fill="#f6f8fa" />
        <circle cx="93" cy="115" r="4.6" fill="#f6f8fa" />
        <g className="left-paw">
          <path d="M39 84c-8 6-11 14-9 21 1 4 7 3 10-2l8-13z" fill="#18192b" />
          <ellipse cx="38" cy="103" rx="5.5" ry="4.2" fill="#f6f8fa" transform="rotate(-13 38 103)" />
        </g>
        <g className="right-paw">
          <path d="M89 84c8 6 11 14 9 21-1 4-7 3-10-2l-8-13z" fill="#18192b" />
          <ellipse cx="90" cy="103" rx="5.5" ry="4.2" fill="#f6f8fa" transform="rotate(13 90 103)" />
        </g>
      </g>

      <g className="plush-head" filter={`url(#${ids.shadow})`}>
        <path d="M17 52C18 36 23 17 29 4c13 5 25 17 36 35L42 59C34 55 26 53 17 52z" fill="#18192b" stroke="#0b0d17" strokeWidth="2.1" strokeLinejoin="round" />
        <path d="M111 52c-1-16-6-35-12-48-13 5-25 17-36 35l23 20c8-4 16-6 25-7z" fill="#18192b" stroke="#0b0d17" strokeWidth="2.1" strokeLinejoin="round" />
        <path d="M31 14c8 4 15 12 22 23l-7 2 3 5-7-1-4 9-5-11-5 2z" fill="#f8f6ee" stroke="#0b0d17" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M97 14c-8 4-15 12-22 23l7 2-3 5 7-1 4 9 5-11 5 2z" fill="#f8f6ee" stroke="#0b0d17" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M34 21c2.5 4.5 4 8.5 4 13M45 31c-3 3-4 6.5-3 10M94 21c-2.5 4.5-4 8.5-4 13M83 31c3 3 4 6.5 3 10" fill="none" stroke="#d6d2c7" strokeWidth="1.15" strokeLinecap="round" />
        <path d="M17 49c0-22 16-35 47-35s47 13 47 35c0 27-17 43-47 43S17 76 17 49z" fill="#18192b" stroke="#0b0d17" strokeWidth="1.4" />
        <path d="M18 58c13 5 29 7 46 7s33-2 46-7c-3 20-21 34-46 34S21 78 18 58z" fill="#f1eee2" />
        <path d="M50 17c9-3 20-3 30 0 0 5-7 8-16 8s-14-3-14-8z" fill="#363a55" opacity="0.55" />
        <g>
          <ellipse cx="42" cy="43" rx="13.2" ry="24" fill="#f8fafc" stroke="#0b0d17" strokeWidth="1.2" />
          <ellipse cx="42" cy="43" rx="8.9" ry="17.2" fill={`url(#${ids.eye})`} stroke="#0b0d17" strokeWidth="1.1" />
          <ellipse cx="43.6" cy="43" rx="2" ry="9.3" fill="#061225" />
          <path className="eye-shine" d="M50 50c2.1 0 3.1-1.1 3.1-2.4" fill="none" stroke="#f2fdff" strokeWidth="2" strokeLinecap="round" />
        </g>
        <g>
          <ellipse cx="86" cy="43" rx="13.2" ry="24" fill="#f8fafc" stroke="#0b0d17" strokeWidth="1.2" />
          <ellipse cx="86" cy="43" rx="8.9" ry="17.2" fill={`url(#${ids.eye})`} stroke="#0b0d17" strokeWidth="1.1" />
          <ellipse cx="87.6" cy="43" rx="2" ry="9.3" fill="#061225" />
          <path className="eye-shine" d="M94 50c2.1 0 3.1-1.1 3.1-2.4" fill="none" stroke="#f2fdff" strokeWidth="2" strokeLinecap="round" />
        </g>
        <path d="M53 75c3.3 5 8.1 5.3 11 0 2.9 5.3 7.7 5 11 0" fill="none" stroke="#111827" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      <g className="laptop" filter={`url(#${ids.shadow})`}>
        <rect x="39" y="84" width="50" height="22" rx="4" fill={`url(#${ids.screen})`} stroke="#19a7ff" strokeWidth="1.2" />
        <rect className="screen-glow" x="42" y="87" width="44" height="16" rx="3" fill="#0ea5e9" opacity="0.3" filter={`url(#${ids.glow})`} />
        <path className="code-a" d="M46 91h13" stroke="#a7f3d0" strokeWidth="2" strokeLinecap="round" />
        <path className="code-b" d="M46 98h21" stroke="#7dd3fc" strokeWidth="2" strokeLinecap="round" />
        <path className="cursor" d="M73 92v8" stroke="#e0f2fe" strokeWidth="2" strokeLinecap="round" />
        <path d="M32 106h64l6 8H26z" fill="#111827" />
        <path d="M38 108h52l3 3H35z" fill="#253040" />
        <rect className="key-a" x="47" y="109" width="8" height="2.1" rx="1" fill="#67e8f9" />
        <rect className="key-b" x="60" y="109" width="10" height="2.1" rx="1" fill="#67e8f9" />
        <rect className="key-a" x="75" y="109" width="8" height="2.1" rx="1" fill="#67e8f9" />
      </g>
    </>
  );
}

function WelcomeAgent({ ids }: { ids: Record<"eye" | "yellow" | "shadow", string> }) {
  return (
    <>
      <ellipse cx="64" cy="118" rx="42" ry="6" fill="#0f172a" opacity="0.13" />
      <g className="plush-body" filter={`url(#${ids.shadow})`}>
        <g className="tail">
          <path d="M90 101c18-8 13-26 24-32" fill="none" stroke="#18192b" strokeWidth="7.4" strokeLinecap="round" />
          <path d="M113 70c5-4 9 0 8 7" fill="none" stroke="#f1eee2" strokeWidth="7.4" strokeLinecap="round" />
        </g>
        <path d="M43 74c-8 9-12 23-12 43h66c0-20-4-34-12-43-13 7-29 7-42 0z" fill="#18192b" />
        <path d="M46 75h36L64 96z" fill={`url(#${ids.yellow})`} />
        <path d="M78 76c8 1 14 5 18 10l-17 2z" fill="#f6d34b" />
        <circle cx="53" cy="107" r="3.8" fill="#e5c06f" />
        <circle cx="75" cy="107" r="3.8" fill="#e5c06f" />
        <path d="M32 116c4-8 15-8 20 0z" fill="#18192b" />
        <path d="M76 116c5-8 16-8 20 0z" fill="#18192b" />
        <circle cx="35" cy="115" r="4.6" fill="#f6f8fa" />
        <circle cx="93" cy="115" r="4.6" fill="#f6f8fa" />
        <g>
          <path d="M39 84c-8 6-11 14-9 21 1 4 7 3 10-2l8-13z" fill="#18192b" />
          <ellipse cx="38" cy="103" rx="5.5" ry="4.2" fill="#f6f8fa" transform="rotate(-13 38 103)" />
        </g>
        <g className="wave-paw">
          <path d="M88 82c8-6 16-5 20 2 2 4-2 8-7 7l-15 8z" fill="#18192b" />
          <ellipse cx="105" cy="84" rx="5.8" ry="4.4" fill="#f6f8fa" transform="rotate(23 105 84)" />
        </g>
      </g>

      <g className="plush-head" filter={`url(#${ids.shadow})`}>
        <path d="M17 52C18 36 23 17 29 4c13 5 25 17 36 35L42 59C34 55 26 53 17 52z" fill="#18192b" stroke="#0b0d17" strokeWidth="2.1" strokeLinejoin="round" />
        <path d="M111 52c-1-16-6-35-12-48-13 5-25 17-36 35l23 20c8-4 16-6 25-7z" fill="#18192b" stroke="#0b0d17" strokeWidth="2.1" strokeLinejoin="round" />
        <path d="M31 14c8 4 15 12 22 23l-7 2 3 5-7-1-4 9-5-11-5 2z" fill="#f8f6ee" stroke="#0b0d17" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M97 14c-8 4-15 12-22 23l7 2-3 5 7-1 4 9 5-11 5 2z" fill="#f8f6ee" stroke="#0b0d17" strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M34 21c2.5 4.5 4 8.5 4 13M45 31c-3 3-4 6.5-3 10M94 21c-2.5 4.5-4 8.5-4 13M83 31c3 3 4 6.5 3 10" fill="none" stroke="#d6d2c7" strokeWidth="1.15" strokeLinecap="round" />
        <path d="M17 49c0-22 16-35 47-35s47 13 47 35c0 27-17 43-47 43S17 76 17 49z" fill="#18192b" stroke="#0b0d17" strokeWidth="1.4" />
        <path d="M18 58c13 5 29 7 46 7s33-2 46-7c-3 20-21 34-46 34S21 78 18 58z" fill="#f1eee2" />
        <path d="M50 17c9-3 20-3 30 0 0 5-7 8-16 8s-14-3-14-8z" fill="#363a55" opacity="0.55" />
        <g>
          <ellipse cx="42" cy="43" rx="13.2" ry="24" fill="#f8fafc" stroke="#0b0d17" strokeWidth="1.2" />
          <ellipse cx="42" cy="43" rx="8.9" ry="17.2" fill={`url(#${ids.eye})`} stroke="#0b0d17" strokeWidth="1.1" />
          <ellipse cx="43.6" cy="43" rx="2" ry="9.3" fill="#061225" />
          <path className="eye-shine" d="M50 50c2.1 0 3.1-1.1 3.1-2.4" fill="none" stroke="#f2fdff" strokeWidth="2" strokeLinecap="round" />
        </g>
        <g>
          <ellipse cx="86" cy="43" rx="13.2" ry="24" fill="#f8fafc" stroke="#0b0d17" strokeWidth="1.2" />
          <ellipse cx="86" cy="43" rx="8.9" ry="17.2" fill={`url(#${ids.eye})`} stroke="#0b0d17" strokeWidth="1.1" />
          <ellipse cx="87.6" cy="43" rx="2" ry="9.3" fill="#061225" />
          <path className="eye-shine" d="M94 50c2.1 0 3.1-1.1 3.1-2.4" fill="none" stroke="#f2fdff" strokeWidth="2" strokeLinecap="round" />
        </g>
        <path d="M53 75c3.3 5 8.1 5.3 11 0 2.9 5.3 7.7 5 11 0" fill="none" stroke="#111827" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </>
  );
}

function IdleAgent({ ids }: { ids: Record<"yellow" | "shadow", string> }) {
  return (
    <>
      <ellipse cx="64" cy="118" rx="43" ry="6" fill="#0f172a" opacity="0.13" />
      <g className="zzz" fill="#8ca0b8" fontFamily="Inter, ui-sans-serif, system-ui" fontWeight="800">
        <text className="zzz-one" x="92" y="34" fontSize="10">Z</text>
        <text className="zzz-two" x="101" y="26" fontSize="8">Z</text>
        <text className="zzz-three" x="108" y="19" fontSize="6">Z</text>
      </g>
      <g className="sleeping-agent" filter={`url(#${ids.shadow})`}>
        <path d="M27 96c13-10 58-12 76-3 9 4 8 17-2 21-21 8-59 8-78 1-10-4-8-14 4-19z" fill="#eef3f8" stroke="#d8e0ea" strokeWidth="1.4" />
        <path d="M35 99c17-5 43-6 61-1" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" opacity="0.75" />
        <g className="tail">
          <path d="M88 102c18-1 21-18 30-21" fill="none" stroke="#18192b" strokeWidth="7.4" strokeLinecap="round" />
          <path d="M117 82c6-2 8 4 5 9" fill="none" stroke="#f1eee2" strokeWidth="7.4" strokeLinecap="round" />
        </g>
        <path d="M25 105c9-15 29-20 53-16 19 3 30 12 29 24H22c0-3 1-6 3-8z" fill="#18192b" />
        <path d="M47 88c10 8 27 9 39 1l-21 18z" fill={`url(#${ids.yellow})`} />
        <circle cx="57" cy="105" r="3.6" fill="#e5c06f" />
        <circle cx="78" cy="106" r="3.6" fill="#e5c06f" />
        <ellipse cx="34" cy="112" rx="9" ry="4.8" fill="#f6f8fa" />
        <ellipse cx="96" cy="112" rx="9" ry="4.8" fill="#f6f8fa" />
        <g className="pillow-paw">
          <path d="M43 90c-11 3-18 10-18 17 0 4 7 5 14 1l16-9z" fill="#18192b" />
          <ellipse cx="37" cy="106" rx="8" ry="5.2" fill="#f6f8fa" transform="rotate(-9 37 106)" />
        </g>
        <g className="sleeping-head">
          <path d="M18 55C19 39 24 20 30 7c13 5 25 17 36 35L43 62C35 58 27 56 18 55z" fill="#18192b" stroke="#0b0d17" strokeWidth="2.1" strokeLinejoin="round" />
          <path d="M112 55c-1-16-6-35-12-48-13 5-25 17-36 35l23 20c8-4 16-6 25-7z" fill="#18192b" stroke="#0b0d17" strokeWidth="2.1" strokeLinejoin="round" />
          <path d="M32 17c8 4 15 12 22 23l-7 2 3 5-7-1-4 9-5-11-5 2z" fill="#f8f6ee" stroke="#0b0d17" strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M98 17c-8 4-15 12-22 23l7 2-3 5 7-1 4 9 5-11 5 2z" fill="#f8f6ee" stroke="#0b0d17" strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M35 24c2.5 4.5 4 8.5 4 13M46 34c-3 3-4 6.5-3 10M95 24c-2.5 4.5-4 8.5-4 13M84 34c3 3 4 6.5 3 10" fill="none" stroke="#d6d2c7" strokeWidth="1.15" strokeLinecap="round" />
          <path d="M18 52c0-22 16-35 47-35s47 13 47 35c0 27-17 43-47 43S18 79 18 52z" fill="#18192b" stroke="#0b0d17" strokeWidth="1.4" />
          <path d="M19 61c13 5 29 7 46 7s33-2 46-7c-3 20-21 34-46 34S22 81 19 61z" fill="#f1eee2" />
          <path d="M51 20c9-3 20-3 30 0 0 5-7 8-16 8s-14-3-14-8z" fill="#363a55" opacity="0.55" />
          <path className="sleep-line" d="M33 48c6 4 13 4 19 0" fill="none" stroke="#f8fafc" strokeWidth="5.2" strokeLinecap="round" />
          <path className="sleep-line" d="M77 48c6 4 13 4 19 0" fill="none" stroke="#f8fafc" strokeWidth="5.2" strokeLinecap="round" />
          <path d="M33 48c6 4 13 4 19 0M77 48c6 4 13 4 19 0" fill="none" stroke="#0b0d17" strokeWidth="2.25" strokeLinecap="round" />
          <path d="M57 79c2.2 2.4 4.8 2.5 7 0 2.2 2.5 4.8 2.4 7 0" fill="none" stroke="#111827" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </g>
    </>
  );
}
