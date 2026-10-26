import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface ModelOption {
  provider: string;
  providerLabel: string;
  model: string;
  label: string;
  active: boolean;
  isBuiltin?: boolean;
  executor?: string;
  selectionId?: string;
  disabledReason?: string | null;
  description?: string | null;
  contextWindow?: number | null;
  recommended?: boolean;
  tags?: string[];
  priceTier?: string | null;
  reasoningEfforts?: string[];
  reasoningEffort?: string | null;
  defaultReasoningEffort?: string | null;
  inputAmountPerMillion?: string | null;
  cachedInputAmountPerMillion?: string | null;
  outputAmountPerMillion?: string | null;
  promotionLabel?: string | null;
  promotionName?: string | null;
  discountPercent?: number | null;
  originalInputAmountPerMillion?: string | null;
  originalCachedInputAmountPerMillion?: string | null;
  originalOutputAmountPerMillion?: string | null;
}

export const PRIMARY_SOURCES = ["mona_managed", "openai", "anthropic", "native:codebuddy"] as const;
export function sourceId(provider: string, builtin = false): string {
  if (builtin || provider === "mona_managed") return "mona_managed";
  if (["openai", "openai_codex", "native:codex"].includes(provider)) return "openai";
  if (["anthropic", "native:claude"].includes(provider)) return "anthropic";
  return provider;
}
export function sourceLabel(provider: string, fallback?: string): string {
  return ({ mona_managed: "Mona AI", openai: "OpenAI", anthropic: "Anthropic", "native:codebuddy": "WorkBuddy" } as Record<string, string>)[sourceId(provider)] ?? fallback ?? provider;
}
export function modelKey(option: Pick<ModelOption, "provider" | "model" | "executor" | "selectionId">): string {
  return JSON.stringify([option.provider, option.model, option.executor ?? "mona", option.selectionId ?? ""]);
}
export function orderedSources(ids: string[], savedOrder: string[]): string[] {
  const unique = [...new Set(ids)];
  const available = new Set(unique);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (available.has(id) && !seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  };

  if (savedOrder.length === 0) {
    PRIMARY_SOURCES.forEach(add);
    unique.forEach(add);
    return ordered;
  }

  // Older v1 preferences only recorded user-added sources. Preserve their original
  // primary-first presentation until the next full-list reorder replaces this order.
  const savedHasPrimary = savedOrder.some((id) =>
    (PRIMARY_SOURCES as readonly string[]).includes(id),
  );
  if (!savedHasPrimary) PRIMARY_SOURCES.forEach(add);
  savedOrder.forEach(add);
  unique.forEach(add);
  return ordered;
}
export function contextLabel(value?: number | null): string {
  if (!value || value <= 0) return "";
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(1))}M` : `${Math.round(value / 1000)}K`;
}
export function effortLabel(value?: string | null): string {
  return ({ none: "关闭", minimal: "最低", minimum: "最低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "极高", adaptive: "自动" } as Record<string, string>)[value ?? ""] ?? value ?? "默认";
}
export function modelEffort(option: ModelOption): string | null {
  const value = option.reasoningEffort ?? option.defaultReasoningEffort ?? null;
  if (!option.reasoningEfforts || value && option.reasoningEfforts.includes(value)) return value;
  const recommended = option.defaultReasoningEffort;
  return recommended && option.reasoningEfforts.includes(recommended) ? recommended : null;
}

interface ModelPreferences {
  hiddenNative: string[];
  providerOrder: string[];
  setNativeVisible: (keys: string[], visible: boolean) => void;
  moveProvider: (source: string, before: string | null, currentOrder?: string[]) => void;
}
const storageName = "mona.model-source-presentation.v1";
const strings = (value: unknown, max: number) => Array.isArray(value)
  ? [...new Set(value.filter((s): s is string => typeof s === "string" && s.length < 2048))].slice(0, max) : [];
// Presentation only: no credentials, runtime paths, permissions or provider routing.
export const useModelPreferences = create<ModelPreferences>()(persist((set) => ({
  hiddenNative: [], providerOrder: [],
  setNativeVisible: (keys, visible) => set((state) => ({ hiddenNative: visible
    ? state.hiddenNative.filter((id) => !keys.includes(id)) : [...new Set([...state.hiddenNative, ...keys])].slice(-2000) })),
  moveProvider: (source, before, currentOrder) => set((state) => {
    if (source === before) return state;
    const order = currentOrder === undefined
      ? [...new Set(state.providerOrder.filter((id) => id !== source))]
      : [...new Set(currentOrder)];
    const sourceIndex = currentOrder === undefined ? -1 : order.indexOf(source);
    if (currentOrder !== undefined && (sourceIndex < 0 || before !== null && !order.includes(before))) return state;
    if (sourceIndex >= 0) order.splice(sourceIndex, 1);
    const index = before === null ? -1 : order.indexOf(before);
    if (before === null) order.push(source);
    else if (index < 0) order.push(source, before);
    else order.splice(index, 0, source);
    return { providerOrder: order.slice(0, 200) };
  }),
}), {
  name: storageName, version: 1, storage: createJSONStorage(() => localStorage),
  partialize: ({ hiddenNative, providerOrder }) => ({ hiddenNative, providerOrder }),
  merge: (saved, current) => {
    const value = saved && typeof saved === "object" ? saved as Partial<ModelPreferences> : {};
    return { ...current, hiddenNative: strings(value.hiddenNative, 2000), providerOrder: strings(value.providerOrder, 200) };
  },
}));
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === storageName) void useModelPreferences.persist.rehydrate();
});
