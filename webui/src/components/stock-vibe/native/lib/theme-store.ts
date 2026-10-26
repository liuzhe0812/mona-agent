import { useSyncExternalStore } from "react";
function subscribe(listener: () => void) { const observer = new MutationObserver(listener); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); return () => observer.disconnect(); }
const snapshot = () => document.documentElement.classList.contains("dark");
export function useThemeDark() { return useSyncExternalStore(subscribe, snapshot, () => false); }
