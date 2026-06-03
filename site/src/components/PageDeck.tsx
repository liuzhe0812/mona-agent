import {
  Children,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { PageTurnContext } from "@/components/PageTurnContext";

const PAGE_IDS = ["hero", "agent", "modules", "whitebox", "desktop", "quickstart"];

interface PageDeckProps {
  nav: ReactNode;
  children: ReactNode;
}

function hrefToIndex(href: string) {
  const id = href === "#" ? "hero" : href.replace(/^#/, "");
  const index = PAGE_IDS.indexOf(id);
  return index >= 0 ? index : 0;
}

export default function PageDeck({ nav, children }: PageDeckProps) {
  const [activeIndex, setActiveIndex] = useState(() => hrefToIndex(window.location.hash || "#"));
  const wheelLockedRef = useRef(false);
  const pages = Children.toArray(children);

  const setPage = useCallback((index: number) => {
    const nextIndex = Math.max(0, Math.min(PAGE_IDS.length - 1, index));
    const nextHash = nextIndex === 0 ? "#" : `#${PAGE_IDS[nextIndex]}`;
    setActiveIndex(nextIndex);
    window.history.pushState(null, "", nextHash);
  }, []);

  const goToHref = useCallback(
    (href: string) => {
      setPage(hrefToIndex(href));
    },
    [setPage],
  );

  useEffect(() => {
    const handlePopState = () => setActiveIndex(hrefToIndex(window.location.hash || "#"));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) < 32 || wheelLockedRef.current) return;
    wheelLockedRef.current = true;
    setPage(activeIndex + (event.deltaY > 0 ? 1 : -1));
    window.setTimeout(() => {
      wheelLockedRef.current = false;
    }, 720);
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href^='#']");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    goToHref(href);
  };

  return (
    <PageTurnContext.Provider value={{ goToHref }}>
      <div
        className="relative h-[100svh] overflow-hidden bg-[#f7f7f5] text-[#101010]"
        onWheel={handleWheel}
        onClick={handleClick}
      >
        {nav}
        {pages.map((page, index) => (
          <div key={PAGE_IDS[index] || index} className={index === activeIndex ? "block" : "hidden"}>
            {page}
          </div>
        ))}
      </div>
    </PageTurnContext.Provider>
  );
}
