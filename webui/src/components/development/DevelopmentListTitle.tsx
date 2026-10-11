import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import "./development-list-title.css";

export function DevelopmentListTitle({ text, actionsRef }: { text: string; actionsRef: RefObject<HTMLDivElement | null> }) {
  const viewport = useRef<HTMLSpanElement>(null), label = useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] = useState({ distance: 0, covered: 0 });
  useEffect(() => {
    const container = viewport.current, content = label.current, actions = actionsRef.current;
    if (!container || !content || !actions) return;
    const measure = () => {
      const bounds = container.getBoundingClientRect();
      const covered = Math.max(0, bounds.right - actions.getBoundingClientRect().left);
      const fade = parseFloat(getComputedStyle(container).fontSize);
      setMetrics({ covered, distance: container.clientWidth ? Math.max(0, content.scrollWidth - container.clientWidth + covered + fade) : 0 });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container); observer.observe(content); observer.observe(actions);
    return () => observer.disconnect();
  }, [text, actionsRef]);
  return <span ref={viewport} className="development-list-title min-w-0 flex-1 overflow-hidden" data-overflow={metrics.distance > 0}
    style={{ "--dev-list-title-offset": `${-metrics.distance}px`, "--dev-list-title-duration": `${Math.max(3, 1.5 + metrics.distance / 24)}s`, "--dev-list-title-covered": `${metrics.covered}px` } as CSSProperties}>
    <span ref={label} className="development-list-title-text block w-max whitespace-nowrap">{text}</span>
  </span>;
}
