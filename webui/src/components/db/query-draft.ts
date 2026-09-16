const drafts = new Map<string, string>();

export function setQueryDraft(tabId: string, sql: string): void {
  drafts.set(tabId, sql);
}

export function getQueryDraft(tabId: string, fallback = ""): string {
  return drafts.get(tabId) ?? fallback;
}

export function clearQueryDraft(tabId: string): void {
  drafts.delete(tabId);
}
