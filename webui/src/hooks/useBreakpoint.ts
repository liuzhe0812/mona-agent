import { useEffect, useState } from "react";

export type Breakpoint = "narrow" | "medium" | "wide";

/** Simple window-width breakpoint hook for responsive layout.
 *  - narrow: < 1100 px
 *  - medium: 1100–1439 px
 *  - wide:   >= 1440 px
 */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => resolveBp(window.innerWidth));

  useEffect(() => {
    const onResize = () => setBp(resolveBp(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return bp;
}

function resolveBp(w: number): Breakpoint {
  if (w < 1100) return "narrow";
  if (w < 1440) return "medium";
  return "wide";
}
