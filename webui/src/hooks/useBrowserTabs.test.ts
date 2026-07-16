import { describe, expect, it } from "vitest";
import { mergeServerTabs, type Tab } from "./useBrowserTabs";

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
