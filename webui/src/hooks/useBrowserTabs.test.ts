import { describe, expect, it } from "vitest";
import {
  createBrowserTabId,
  mergeServerTabs,
  shouldPersistBrowserSession,
  type Tab,
} from "./useBrowserTabs";

const monaTab: Tab = {
  id: "mona",
  type: "mona",
  title: "Mona",
  isAiControlled: false,
  webviewCreated: false,
};

describe("mergeServerTabs", () => {
  it("keeps a local browser tab while the initial server list is empty", () => {
    const localBrowserTab: Tab = {
      id: "tab-local",
      type: "browser",
      title: "Example Domain",
      url: "https://example.com",
      isAiControlled: false,
      webviewCreated: true,
    };

    expect(mergeServerTabs([monaTab, localBrowserTab], [])).toEqual([
      monaTab,
      localBrowserTab,
    ]);
  });
});

describe("browser session persistence", () => {
  it("is disabled in development so dev never reopens production tabs", () => {
    expect(shouldPersistBrowserSession(true)).toBe(false);
    expect(shouldPersistBrowserSession(false)).toBe(true);
  });
});

describe("browser tab ids", () => {
  it("uses collision-resistant UUIDs instead of a resettable counter", () => {
    const first = createBrowserTabId();
    const second = createBrowserTabId();

    expect(first).toMatch(/^tab-[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });
});
