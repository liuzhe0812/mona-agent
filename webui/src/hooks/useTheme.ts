import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { isTauri, setWindowBackgroundColor } from "@/lib/tauri";

type Theme = "light" | "dark";
const STORAGE_KEY = "mona-webui.theme";
const ThemeContext = createContext<Theme>("light");

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

/** 同步主窗口背景色到当前主题，避免拖动调整大小时露出对比色残影。 */
function syncWindowBackground(theme: Theme): void {
  if (!isTauri()) return;
  // 深色主题用 #1a1a1a 匹配 index.html 的 body 背景；浅色主题用 #ffffff
  const color = theme === "dark" ? [26, 26, 26, 255] : [255, 255, 255, 255];
  void setWindowBackgroundColor(color[0], color[1], color[2], color[3]).catch(
    () => {
      // 主题切换时窗口背景同步失败不影响 UI
    },
  );
}

export function useTheme(): {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
} {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = readStored();
    if (stored) return stored;
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return "light";
  });

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
    syncWindowBackground(theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(
    () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
    [],
  );
  return { theme, toggle, setTheme };
}

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

export function useThemeValue(): Theme {
  return useContext(ThemeContext);
}
