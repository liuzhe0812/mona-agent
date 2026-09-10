import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  LoaderCircle,
  PenLine,
  Search,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentAvatar } from "@/components/room/AgentAvatar";
import { invalidateAgents } from "@/components/room/useAgents";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  cancelExpertInstall,
  fetchExpertCatalog,
  fetchExpertInstallJob,
  startExpertInstall,
} from "@/lib/api";
import type {
  ExpertCatalogItem,
  ExpertCatalogPayload,
  ExpertInstallJob,
} from "@/lib/types";

interface ExpertLibraryDialogProps {
  open: boolean;
  token: string | null;
  onOpenChange: (open: boolean) => void;
  onStartDirect: (agentId: string, displayName?: string) => void;
  onCreateCustom?: () => void;
}

export function ExpertLibraryDialog({
  open,
  token,
  onOpenChange,
  onStartDirect,
  onCreateCustom,
}: ExpertLibraryDialogProps) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<ExpertCatalogPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [jobs, setJobs] = useState<Record<string, ExpertInstallJob>>({});
  const polling = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const loadCatalog = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      setCatalog(await fetchExpertCatalog(token));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("experts.catalogError"));
    } finally {
      setLoading(false);
    }
  }, [t, token]);

  useEffect(() => {
    if (open) void loadCatalog();
  }, [loadCatalog, open]);

  const visibleExperts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return catalog?.experts ?? [];
    return (catalog?.experts ?? []).filter((expert) =>
      `${expert.displayName} ${expert.description} ${expert.id}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [catalog, query]);

  const followJob = useCallback(async (initial: ExpertInstallJob) => {
    if (!token || polling.current.has(initial.jobId)) return;
    polling.current.add(initial.jobId);
    let job = initial;
    try {
      while (job.state === "queued" || job.state === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 650));
        job = (await fetchExpertInstallJob(token, job.jobId)).job;
        if (mounted.current) {
          setJobs((current) => ({ ...current, [job.expertId]: job }));
        }
      }
      if (job.state === "completed") {
        invalidateAgents();
        if (mounted.current) await loadCatalog();
      }
    } catch (reason) {
      if (mounted.current) {
        setJobs((current) => ({
          ...current,
          [job.expertId]: {
            ...job,
            state: "failed",
            stage: "failed",
            error: reason instanceof Error ? reason.message : t("experts.installError"),
          },
        }));
      }
    } finally {
      polling.current.delete(initial.jobId);
    }
  }, [loadCatalog, t, token]);

  const install = useCallback(async (expert: ExpertCatalogItem) => {
    if (!token) return;
    setError(null);
    try {
      const response = await startExpertInstall(token, expert.id, expert.version);
      setJobs((current) => ({ ...current, [expert.id]: response.job }));
      void followJob(response.job);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("experts.installError"));
    }
  }, [followJob, t, token]);

  const cancel = useCallback(async (job: ExpertInstallJob) => {
    if (!token) return;
    try {
      const response = await cancelExpertInstall(token, job.jobId);
      setJobs((current) => ({ ...current, [job.expertId]: response.job }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("experts.cancelError"));
    }
  }, [t, token]);

  const startConversation = useCallback((expert: ExpertCatalogItem) => {
    onOpenChange(false);
    onStartDirect(expert.id, expert.displayName);
  }, [onOpenChange, onStartDirect]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[78vh] max-w-xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-5 pb-3 pt-4">
          <DialogTitle>{t("experts.title")}</DialogTitle>
          <DialogDescription>{t("experts.description")}</DialogDescription>
        </DialogHeader>

        <div className="px-5 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("experts.search")}
              className="h-9 pl-9"
            />
          </div>
          {catalog?.stale ? (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {t("experts.offlineCache")}
            </p>
          ) : null}
          {error ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
              <Button variant="ghost" size="sm" onClick={() => void loadCatalog()}>
                {t("experts.retry")}
              </Button>
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-3">
          {loading && !catalog ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              {t("experts.loading")}
            </div>
          ) : visibleExperts.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {catalog?.source === "unavailable"
                ? t("experts.unavailable")
                : t("experts.empty")}
            </p>
          ) : (
            <div className="space-y-2">
              {visibleExperts.map((expert) => (
                <ExpertCard
                  key={expert.id}
                  expert={expert}
                  job={jobs[expert.id]}
                  installEnabled={(catalog?.installEnabled ?? false) && expert.compatible}
                  unavailableReason={expert.unavailableReason ?? catalog?.installUnavailableReason}
                  onInstall={() => void install(expert)}
                  onCancel={(job) => void cancel(job)}
                  onStart={() => startConversation(expert)}
                />
              ))}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2.5 border-t border-border/60 pt-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <PenLine className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
              {t("experts.custom")}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={!onCreateCustom}
              onClick={() => {
                if (!onCreateCustom) return;
                onOpenChange(false);
                onCreateCustom();
              }}
            >
              {t("experts.customAction")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExpertCard({
  expert,
  job,
  installEnabled,
  unavailableReason,
  onInstall,
  onCancel,
  onStart,
}: {
  expert: ExpertCatalogItem;
  job?: ExpertInstallJob;
  installEnabled: boolean;
  unavailableReason?: string | null;
  onInstall: () => void;
  onCancel: (job: ExpertInstallJob) => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const running = job?.state === "queued" || job?.state === "running";
  const completed = job?.state === "completed" || (expert.installed && !expert.updateAvailable);
  const percent = job && job.totalBytes > 0
    ? Math.min(100, Math.round(job.downloadedBytes / job.totalBytes * 100))
    : 0;
  return (
    <article className="rounded-lg border border-border/60 bg-card/60 p-3">
      <div className="flex items-start gap-3">
        <AgentAvatar
          agentId={expert.id}
          displayName={expert.displayName}
          className="h-10 w-10 rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="font-medium text-foreground">{expert.displayName}</h3>
            <span className="text-xs text-muted-foreground">v{expert.version}</span>
            {completed ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t("experts.installed")}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {expert.description}
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("experts.packageInfo", {
              size: formatBytes(expert.downloadBytes),
              count: expert.runtimePacks.length,
            })}
          </p>
          {running ? (
            <div className="mt-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${Math.max(3, percent)}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
                <span>{t(`experts.stages.${job.stage}`, { defaultValue: job.stage })}</span>
                <span>{percent}%</span>
              </div>
            </div>
          ) : null}
          {job?.state === "failed" || job?.state === "cancelled" ? (
            <p className="mt-2 text-xs text-destructive">{job.error}</p>
          ) : null}
          {!installEnabled && !completed ? (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {unavailableReason}
            </p>
          ) : null}
        </div>
        <div className="shrink-0">
          {running && job ? (
            <Button variant="outline" size="sm" className="h-8" onClick={() => onCancel(job)}>
              {t("experts.cancel")}
            </Button>
          ) : completed ? (
            <Button size="sm" className="h-8" onClick={onStart}>{t("experts.start")}</Button>
          ) : (
            <Button size="sm" className="h-8" disabled={!installEnabled} onClick={onInstall}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {expert.updateAvailable ? t("experts.update") : t("experts.install")}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function formatBytes(value: number): string {
  if (value < 100 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
