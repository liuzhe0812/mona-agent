import { useEffect, useState } from "react";
import "./mona-composer-peek.css";

export function MonaComposerPeek({ paused = false }: { paused?: boolean }) {
  const [pageVisible, setPageVisible] = useState(true);
  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return (
    <svg
      className="mona-composer-peek"
      viewBox="0 0 96 78"
      width="96"
      height="78"
      data-paused={paused || !pageVisible}
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="mona-composer-peek-head"
        d="M 8 77 Q 5 77 5 73 L 5 51 Q 5 44 7 38 C 4 27 3 12 7 4 Q 8 1 11 2 C 19 5 27 12 33 18 Q 48 14 63 18 C 69 12 77 5 85 2 Q 88 1 89 4 C 93 12 92 27 89 38 Q 91 44 91 51 L 91 73 Q 91 77 88 77 Z"
        vectorEffect="non-scaling-stroke"
      />
      <g className="mona-composer-peek-eyes">
        <ellipse cx="28" cy="55" rx="8.25" ry="10.5" />
        <ellipse cx="68" cy="55" rx="8.25" ry="10.5" />
      </g>
    </svg>
  );
}
