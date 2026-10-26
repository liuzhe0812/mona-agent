import { useEffect, useState } from "react";

import { MONA_BRAND_AVATAR } from "@/lib/brand-assets";

const STARTUP_DELAY_MS = 400;
const EXIT_DURATION_MS = 320;

interface StartupSceneProps {
  exiting?: boolean;
  onExitComplete?: () => void;
}

export function StartupScene({ exiting = false, onExitComplete }: StartupSceneProps) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (exiting) return;
    const timer = window.setTimeout(() => setRevealed(true), STARTUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [exiting]);

  useEffect(() => {
    if (!exiting || !onExitComplete) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(
      onExitComplete,
      revealed && !reducedMotion ? EXIT_DURATION_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [exiting, onExitComplete, revealed]);

  if (!revealed) return null;

  return (
    <section
      className={`mona-startup-scene absolute inset-0 z-40 flex items-center justify-center overflow-hidden ${exiting ? "is-exiting" : ""}`}
      data-testid="startup-scene"
      role="status"
      aria-live="polite"
      aria-label={exiting ? "Mona 已就绪" : "正在启动 Mona"}
    >
      <div className="mona-startup-lockup">
        <div className="mona-startup-emblem" aria-hidden="true">
          <svg className="mona-startup-orbit" viewBox="0 0 144 144" fill="none">
            <circle className="mona-startup-orbit-track" cx="72" cy="72" r="62" />
            <circle className="mona-startup-orbit-signal" cx="72" cy="72" r="62" />
          </svg>
          <img className="mona-startup-mark" src={MONA_BRAND_AVATAR} alt="" draggable={false} />
        </div>
        <p className="mona-startup-wordmark">Mona</p>
        <p className="mona-startup-status text-ui">
          <span className="mona-startup-status-dot" aria-hidden="true" />
          {exiting ? "工作台已就绪" : "正在接通你的工作台"}
        </p>
      </div>
    </section>
  );
}
