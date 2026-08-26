import { useEffect, useState } from "react";

const STARTUP_DELAY_MS = 400;

/**
 * Small, delayed brand surface for the real runtime connection.
 *
 * Keeping the delay here means a fast boot never flashes a loading screen,
 * while the parent can unmount this scene as soon as the runtime is ready.
 */
export function StartupScene() {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setRevealed(true), STARTUP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!revealed) return null;

  return (
    <section
      className="mona-startup-scene fixed inset-x-0 bottom-0 top-9 z-40 flex items-center justify-center overflow-hidden px-6"
      data-testid="startup-scene"
      role="status"
      aria-live="polite"
      aria-label="Mona 正在醒来"
    >
      <div className="mona-startup-grid" aria-hidden="true" />
      <div className="mona-startup-content flex w-full max-w-lg flex-col items-center text-center">
        <div className="mona-startup-kicker flex items-center gap-2 text-caption font-semibold tracking-[0.22em]">
          <span className="mona-startup-kicker-signal" aria-hidden="true" />
          <span>MONA / BOOTING</span>
        </div>

        <div className="mona-startup-logo-wrap" aria-label="Mona">
          <span className="mona-startup-orbit" aria-hidden="true" />
          <span className="mona-startup-scan" aria-hidden="true" />
          <img
            className="mona-startup-logo"
            src="/brand/mona_app_icon.png"
            alt="Mona"
          />
        </div>

        <div className="mona-startup-copy flex flex-col items-center">
          <h1 className="text-title">Mona 正在醒来</h1>
          <p className="mt-2 text-body text-muted-foreground">正在接通你的工作台</p>
        </div>

        <div className="mona-startup-status mt-8 flex items-center gap-3 text-micro font-medium tracking-[0.18em] text-muted-foreground">
          <span className="mona-startup-status-line" aria-hidden="true" />
          <span>WORKSPACE / CONNECTING</span>
        </div>
      </div>
    </section>
  );
}
