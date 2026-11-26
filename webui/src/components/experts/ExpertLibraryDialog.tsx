import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  LoaderCircle,
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
import { useClientContextOrNull } from "@/providers/ClientProvider";
import {
  cancelExpertInstall,
  fetchExpertCatalog,
  fetchExpertInstallJob,
  listExpertInstallJobs,
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

interface StartAttempt {
  version: string;
  startedAt: number;
  state: "starting" | "unconfirmed" | "checking" | "notFound";
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
  const [unconfirmedJobs, setUnconfirmedJobs] = useState<Set<string>>(() => new Set());
  const [startAttempts, setStartAttempts] = useState<Record<string, StartAttempt>>({});
  const polling = useRef(new Set<string>());
  const checkingStarts = useRef(new Set<string>());
  const mounted = useRef(true);
  const catalogRequest = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const client = useClientContextOrNull()?.client;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      catalogRequest.current += 1;
    };
  }, []);

  const loadCatalog = useCallback(async (preserve = false): Promise<ExpertCatalogPayload | null> => {
    if (!token) return null;
    const request = ++catalogRequest.current;
    if (!preserve) setCatalog(null);
    setLoading(true);
    setError(null);
    try {
      const nextCatalog = await fetchExpertCatalog(token);
      if (mounted.current && catalogRequest.current === request) {
        setCatalog(nextCatalog);
        return nextCatalog;
      }
    } catch {
      if (mounted.current && catalogRequest.current === request) setError(t("experts.catalogError"));
    } finally {
      if (mounted.current && catalogRequest.current === request) setLoading(false);
    }
    return null;
  }, [t, token]);

  useEffect(() => {
    if (open) {
      setJobs((current) => Object.fromEntries(
        Object.entries(current).filter(([, job]) => job.state === "queued" || job.state === "running"),
      ));
      void loadCatalog();
    } else {
      catalogRequest.current += 1;
      setCatalog(null);
      setError(null);
      setLoading(false);
    }
  }, [loadCatalog, open]);

  useEffect(() => {
    if (!open || !client) return;
    return client.onAgentsUpdated((_agentId, event) => {
      if (event === "agents_updated") void loadCatalog();
    });
  }, [client, loadCatalog, open]);

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
    setUnconfirmedJobs((current) => {
      const next = new Set(current);
      next.delete(initial.jobId);
      return next;
    });
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
        if (mounted.current && openRef.current) await loadCatalog();
      }
      if (job.state === "failed" && job.errorCode === "catalog_version_unavailable"
        && mounted.current && openRef.current) {
        const refreshed = await loadCatalog(true);
        if (refreshed && !refreshed.experts.some((expert) => expert.id === job.expertId)) {
          setError(t("experts.catalogVersionChanged"));
        }
      }
    } catch {
      if (mounted.current) {
        setUnconfirmedJobs((current) => new Set(current).add(job.jobId));
      }
    } finally {
      polling.current.delete(initial.jobId);
    }
  }, [loadCatalog, t, token]);

  const install = useCallback(async (expert: ExpertCatalogItem) => {
    if (!token || checkingStarts.current.has(expert.id)
      || (startAttempts[expert.id] && startAttempts[expert.id].state !== "notFound")) return;
    checkingStarts.current.add(expert.id);
    const attempt: StartAttempt = { version: expert.version, startedAt: Date.now(), state: "starting" };
    setStartAttempts((current) => ({ ...current, [expert.id]: attempt }));
    setError(null);
    try {
      const response = await startExpertInstall(token, expert.id, expert.version);
      setStartAttempts((current) => {
        const next = { ...current };
        delete next[expert.id];
        return next;
      });
      setJobs((current) => ({ ...current, [expert.id]: response.job }));
      void followJob(response.job);
    } catch {
      setStartAttempts((current) => ({ ...current, [expert.id]: { ...attempt, state: "unconfirmed" } }));
    } finally {
      checkingStarts.current.delete(expert.id);
    }
  }, [followJob, startAttempts, token]);

  const checkStart = useCallback(async (expert: ExpertCatalogItem) => {
    const attempt = startAttempts[expert.id];
    if (!token || !attempt || checkingStarts.current.has(expert.id)) return;
    checkingStarts.current.add(expert.id);
    setStartAttempts((current) => ({ ...current, [expert.id]: { ...attempt, state: "checking" } }));
    try {
      const { jobs: knownJobs } = await listExpertInstallJobs(token);
      const sameExpert = knownJobs.filter((job) => job.expertId === expert.id);
      const job = sameExpert.find((item) => item.state === "queued" || item.state === "running")
        ?? sameExpert.find((item) => item.version === attempt.version && item.createdAt >= attempt.startedAt);
      if (job) {
        setStartAttempts((current) => {
          const next = { ...current };
          delete next[expert.id];
          return next;
        });
        setJobs((current) => ({ ...current, [expert.id]: job }));
        void followJob(job);
      } else {
        setStartAttempts((current) => ({ ...current, [expert.id]: { ...attempt, state: "notFound" } }));
      }
    } catch {
      setStartAttempts((current) => ({ ...current, [expert.id]: { ...attempt, state: "unconfirmed" } }));
    } finally {
      checkingStarts.current.delete(expert.id);
    }
  }, [followJob, startAttempts, token]);

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
          ) : !catalog ? null : visibleExperts.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {catalog.source === "unavailable" || (!query.trim() && catalog.experts.length === 0)
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
                  startAttempt={startAttempts[expert.id]}
                  statusUnconfirmed={!!jobs[expert.id] && unconfirmedJobs.has(jobs[expert.id].jobId)}
                  installEnabled={(catalog?.installEnabled ?? false) && expert.compatible}
                  unavailableReason={expert.unavailableReason ?? catalog?.installUnavailableReason}
                  onInstall={() => void install(expert)}
                  onCancel={(job) => void cancel(job)}
                  onCheckStatus={(job) => void followJob(job)}
                  onCheckStart={() => void checkStart(expert)}
                  onRefreshCatalog={() => void loadCatalog(true)}
                  onStart={() => startConversation(expert)}
                />
              ))}
            </div>
          )}
          <div className="mt-3 flex justify-end border-t border-border/60 pt-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              disabled={!onCreateCustom}
              onClick={() => {
                if (!onCreateCustom) return;
                onOpenChange(false);
                onCreateCustom();
              }}
            >
              {t("experts.custom")}
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
  startAttempt,
  statusUnconfirmed,
  installEnabled,
  unavailableReason,
  onInstall,
  onCancel,
  onCheckStatus,
  onCheckStart,
  onRefreshCatalog,
  onStart,
}: {
  expert: ExpertCatalogItem;
  job?: ExpertInstallJob;
  startAttempt?: StartAttempt;
  statusUnconfirmed: boolean;
  installEnabled: boolean;
  unavailableReason?: string | null;
  onInstall: () => void;
  onCancel: (job: ExpertInstallJob) => void;
  onCheckStatus: (job: ExpertInstallJob) => void;
  onCheckStart: () => void;
  onRefreshCatalog: () => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const running = job?.state === "queued" || job?.state === "running";
  const failed = job?.state === "failed";
  const versionUnavailable = failed && job.errorCode === "catalog_version_unavailable";
  const needsCatalogRefresh = versionUnavailable && job.version === expert.version;
  const installed = expert.installed;
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
            {installed ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t("experts.installed")}
                {expert.installedVersion && expert.installedVersion !== expert.version
                  ? ` v${expert.installedVersion}` : null}
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
          {running && !statusUnconfirmed ? (
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
          {startAttempt?.state === "notFound" ? (
            <p className="mt-2 text-xs text-destructive">{t("experts.startNotFound")}</p>
          ) : startAttempt?.state === "unconfirmed" || startAttempt?.state === "checking" ? (
            <p className="mt-2 text-xs text-destructive">{t("experts.installStartUnconfirmed")}</p>
          ) : statusUnconfirmed ? (
            <p className="mt-2 text-xs text-destructive">{t("experts.statusUnconfirmed")}</p>
          ) : !startAttempt && failed ? (
            <p className="mt-2 text-xs text-destructive">
              {t(versionUnavailable ? "experts.catalogVersionChanged" : "experts.installFailedRetry")}
            </p>
          ) : !startAttempt && job?.state === "cancelled" ? (
            <p className="mt-2 text-xs text-muted-foreground">{t("experts.stages.cancelled")}</p>
          ) : null}
          {!installEnabled && (!installed || expert.updateAvailable) ? (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {unavailableReason}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {startAttempt?.state === "notFound" ? (
            <>
              <Button variant="outline" size="sm" className="h-8" onClick={onCheckStart}>
                {t("experts.checkStatus")}
              </Button>
              <Button size="sm" className="h-8" disabled={!installEnabled} onClick={onInstall}>
                {t("experts.retry")}
              </Button>
            </>
          ) : startAttempt ? (
            <Button variant="outline" size="sm" className="h-8"
              disabled={startAttempt.state === "starting" || startAttempt.state === "checking"}
              onClick={onCheckStart}>
              {startAttempt.state === "starting" ? t("experts.stages.queued") : t("experts.checkStatus")}
            </Button>
          ) : statusUnconfirmed && job ? (
            <Button variant="outline" size="sm" className="h-8" onClick={() => onCheckStatus(job)}>
              {t("experts.checkStatus")}
            </Button>
          ) : running && job ? (
            <Button variant="outline" size="sm" className="h-8" onClick={() => onCancel(job)}>
              {t("experts.cancel")}
            </Button>
          ) : (
            <>
              {installed ? <Button size="sm" className="h-8" onClick={onStart}>{t("experts.start")}</Button> : null}
              {!installed || expert.updateAvailable ? (
                needsCatalogRefresh ? (
                  <Button variant="outline" size="sm" className="h-8" onClick={onRefreshCatalog}>
                    {t("experts.refreshList")}
                  </Button>
                ) : (
                  <Button variant={installed ? "outline" : "default"} size="sm" className="h-8" disabled={!installEnabled} onClick={onInstall}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    {failed ? t("experts.retry") : expert.updateAvailable ? t("experts.update") : t("experts.install")}
                  </Button>
                )
              ) : null}
            </>
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
