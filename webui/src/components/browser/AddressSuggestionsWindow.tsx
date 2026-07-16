import { useEffect, useState } from "react";
import { Bookmark, Search } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  browserSelectAddressSuggestion,
  type AddressSuggestionPopup,
} from "@/lib/browser-ipc";
import { useTheme } from "@/hooks/useTheme";

function decodePopup(): AddressSuggestionPopup | null {
  try {
    const data = window.location.hash.match(/[?&]data=([^&]+)/)?.[1];
    if (!data) return null;
    const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8").decode(bytes)) as AddressSuggestionPopup;
  } catch {
    return null;
  }
}

export function AddressSuggestionsWindow() {
  useTheme();
  const [popup, setPopup] = useState<AddressSuggestionPopup | null>(decodePopup);

  useEffect(() => {
    document.body.classList.add("address-suggestions-body");
    return () => document.body.classList.remove("address-suggestions-body");
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<AddressSuggestionPopup>("browser-address-suggestions", (event) => setPopup(event.payload))
      .then((cleanup) => { unlisten = cleanup; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!popup) return;
    void invoke("show_browser_address_suggestions_window").catch(() => {});
  }, [popup]);

  if (!popup) return null;

  return (
    <div className="h-full w-full overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
      {popup.suggestions.map((suggestion) => (
        <button
          key={suggestion.url}
          type="button"
          className="flex h-[52px] w-full items-center gap-2 px-3 text-left text-[12px] hover:bg-accent"
          onMouseDown={() => void browserSelectAddressSuggestion(popup.tabId, suggestion.url)}
        >
          {suggestion.isBookmark ? (
            <Bookmark className="h-3 w-3 shrink-0 fill-yellow-500 text-yellow-500" />
          ) : (
            <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{suggestion.title || suggestion.url}</span>
            <span className="block truncate text-muted-foreground">{suggestion.url}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
