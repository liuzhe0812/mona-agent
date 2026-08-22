import { Download, History, Search, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { AgentLogo } from "@/components/AgentLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { normalizeUrlOrSearch } from "./browser-navigation";

interface NewTabPageProps {
  isIncognito?: boolean;
  onNavigate: (url: string) => void;
  onOpenHistory?: () => void;
  onOpenDownloads?: () => void;
}

export function NewTabPage({
  isIncognito = false,
  onNavigate,
  onOpenHistory,
  onOpenDownloads,
}: NewTabPageProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = normalizeUrlOrSearch(query);
    if (target) onNavigate(target);
  };

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col items-center text-center">
        <AgentLogo state="welcome" className="h-16 w-16" />
        <h1 className="mt-5 text-2xl font-medium tracking-tight text-foreground">
          {t("browser.newTab.title")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {isIncognito ? t("browser.newTab.incognitoHint") : t("browser.newTab.hint")}
        </p>

        <form className="relative mt-8 w-full" onSubmit={submit}>
          <Search
            aria-hidden
            className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("browser.newTab.placeholder")}
            aria-label={t("browser.newTab.placeholder")}
            className="h-12 rounded-2xl border-border/70 bg-card pl-12 pr-4 text-base shadow-sm focus-visible:ring-2"
          />
        </form>

        <div className="mt-6 grid w-full max-w-md grid-cols-2 gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-11 justify-center gap-2 rounded-xl"
            onClick={onOpenHistory}
            disabled={!onOpenHistory}
          >
            <History className="h-4 w-4" />
            {t("browser.newTab.history")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 justify-center gap-2 rounded-xl"
            onClick={onOpenDownloads}
            disabled={!onOpenDownloads}
          >
            <Download className="h-4 w-4" />
            {t("browser.newTab.downloads")}
          </Button>
        </div>

        <div className="mt-8 flex items-center gap-2 text-xs text-muted-foreground/80">
          <ShieldCheck className="h-4 w-4" />
          {isIncognito ? t("browser.newTab.incognitoBadge") : t("browser.newTab.localBadge")}
        </div>
      </div>
    </div>
  );
}
