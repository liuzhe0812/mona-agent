import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-micro",
        "text-caption",
        "text-ui",
        "text-body",
        "text-body-lg",
        "text-title-sm",
        "text-title",
        "text-display-sm",
        "text-clock",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
