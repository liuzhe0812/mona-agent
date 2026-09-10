import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const STARTUP_DELAY_MS = 400;
const EXIT_DURATION_MS = 860;

interface StartupSceneProps {
  exiting?: boolean;
  onExitComplete?: () => void;
}

interface StartupSceneStyle extends CSSProperties {
  "--mona-startup-exit-x"?: string;
  "--mona-startup-exit-y"?: string;
  "--mona-startup-exit-scale"?: string;
}

export function StartupScene({ exiting = false, onExitComplete }: StartupSceneProps) {
  const [revealed, setRevealed] = useState(false);
  const [exitStyle, setExitStyle] = useState<StartupSceneStyle>();
  const solidRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setRevealed(true),
      exiting ? 0 : STARTUP_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [exiting]);

  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => onExitComplete?.(), EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [exiting, onExitComplete]);

  useLayoutEffect(() => {
    if (!exiting || !revealed) return;
    const source = solidRef.current?.getBoundingClientRect();
    const target = document.querySelector<HTMLElement>("[data-testid='mona-human-portrait']")?.getBoundingClientRect();
    if (!source || !target || source.width === 0 || source.height === 0) {
      setExitStyle({ "--mona-startup-exit-scale": "0.86" });
      return;
    }
    const scale = Math.min(target.width / source.width, target.height / source.height);
    setExitStyle({
      "--mona-startup-exit-x": `${target.left + target.width / 2 - source.left - source.width / 2}px`,
      "--mona-startup-exit-y": `${target.top + target.height / 2 - source.top - source.height / 2}px`,
      "--mona-startup-exit-scale": `${scale}`,
    });
  }, [exiting, revealed]);

  if (!revealed) return null;

  return (
    <section
      className={`mona-startup-scene absolute inset-0 z-40 flex flex-col items-center justify-center overflow-hidden ${exiting ? "is-exiting" : ""}`}
      data-testid="startup-scene"
      role="status"
      aria-live="polite"
      aria-label="Mona 正在醒来"
      style={exitStyle}
    >
      <div className="mona-startup-halo" aria-hidden="true" />
      <div className="mona-startup-stage" aria-hidden="true">
        <div className="mona-startup-human-stack">
          <img
            className="mona-startup-human mona-startup-human-ghost-dark"
            data-testid="startup-human-ghost-dark"
            src="/brand/mona_startup_human_ghost_dark.png"
            alt=""
          />
          <img
            className="mona-startup-human mona-startup-human-ghost-light"
            data-testid="startup-human-ghost-light"
            src="/brand/mona_startup_human_ghost_light.png"
            alt=""
          />
          <img
            ref={solidRef}
            className="mona-startup-human mona-startup-human-solid"
            data-testid="startup-human-solid"
            src="/brand/mona_startup_human_solid.png"
            alt=""
          />
        </div>
        <img
          className="mona-startup-cat"
          data-testid="startup-cat-sleeping"
          src="/brand/mona_startup_cat_sleeping.png"
          alt=""
        />
      </div>
      <p className="mona-startup-awakening">Mona 唤醒中</p>
    </section>
  );
}
