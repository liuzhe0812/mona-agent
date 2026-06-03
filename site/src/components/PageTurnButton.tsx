import { motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { usePageTurn } from "@/components/PageTurnContext";

interface PageTurnButtonProps {
  href: string;
  label: string;
  tone?: "dark" | "light";
}

const toePositions = [
  { left: 11, top: 8, rotate: -14 },
  { left: 23, top: 4, rotate: -5 },
  { right: 23, top: 4, rotate: 5 },
  { right: 11, top: 8, rotate: 14 },
];

export default function PageTurnButton({
  href,
  label,
  tone = "dark",
}: PageTurnButtonProps) {
  const isLight = tone === "light";
  const padClass = isLight
    ? "border-black/10 bg-[#101010] text-white"
    : "border-white/10 bg-white text-[#101010]";
  const toeClass = isLight ? "bg-[#101010]" : "bg-white";
  const pageTurn = usePageTurn();

  const handleClick = () => {
    if (pageTurn) {
      pageTurn.goToHref(href);
      return;
    }

    const scrollToPage = (top: number) => {
      const root = document.scrollingElement || document.documentElement;
      root.scrollTo({ top, behavior: "smooth" });
      window.setTimeout(() => {
        if (Math.abs(window.scrollY - top) > 4) {
          root.scrollTop = top;
          document.documentElement.scrollTop = top;
          document.body.scrollTop = top;
        }
      }, 360);
    };

    if (href === "#") {
      window.history.pushState(null, "", "#");
      scrollToPage(0);
      return;
    }

    const target = document.querySelector(href);
    if (target) {
      window.history.pushState(null, "", href);
      const top = target.getBoundingClientRect().top + window.scrollY;
      scrollToPage(top);
    }
  };

  return (
    <button
      type="button"
      aria-label={label}
      onClick={handleClick}
      className="paw-scroll-button group absolute bottom-4 z-40 cursor-pointer transition hover:-translate-y-1 hover:scale-[1.04] active:scale-95"
      style={{
        left: "calc(50% - 34px)",
        width: 68,
        height: 56,
        background: "transparent",
        border: "none",
        boxShadow: "none",
        padding: 0,
      }}
    >
      <motion.span
        className="absolute inset-0"
        animate={{ y: [0, 3, 0] }}
        transition={{ duration: 1.45, repeat: Infinity, ease: "easeInOut" }}
      >
        {toePositions.map((position) => (
          <span
            key={`${position.left ?? position.right}-${position.top}`}
            className={`absolute rounded-full ${toeClass} shadow-[inset_0_-3px_0_rgba(0,0,0,0.1)]`}
            style={{
              width: 11,
              height: 14,
              top: position.top,
              left: position.left,
              right: position.right,
              transform: `rotate(${position.rotate}deg)`,
            }}
          />
        ))}
        <span
          className={`absolute flex items-center justify-center border ${padClass} shadow-[inset_0_-4px_0_rgba(0,0,0,0.12)]`}
          style={{
            width: 36,
            height: 28,
            left: "50%",
            bottom: 7,
            borderRadius: "18px 18px 15px 15px",
            transform: "translateX(-50%)",
          }}
        >
          <ChevronDown className="h-4 w-4" />
        </span>
      </motion.span>

      <span
        className={`pointer-events-none absolute bottom-0 left-1/2 h-2 w-8 -translate-x-1/2 rounded-full blur-sm transition-opacity group-hover:opacity-60 ${
          isLight ? "bg-black/14 opacity-20" : "bg-black/24 opacity-25"
        }`}
      />
    </button>
  );
}
