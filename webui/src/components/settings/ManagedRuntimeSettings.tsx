import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Code2,
  Loader2,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SubsectionLabel } from "@/components/ui/page-header";
import { Switch } from "@/components/ui/switch";
import {
  cancelManagedRuntimeInstall,
  cleanupManagedRuntimes,
  fetchManagedRuntimeInstallJob,
  fetchManagedRuntimeStatus,
  startManagedRuntimeInstall,
  updateManagedRuntimeSettings,
} from "@/lib/api";
import type {
  ManagedRuntimeComponent,
  ManagedRuntimeInstallJob,
  ManagedRuntimeStatusPayload,
} from "@/lib/types";

export function ManagedRuntimeSettings({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ManagedRuntimeStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatingAutoDownload, setUpdatingAutoDownload] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const polling = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchManagedRuntimeStatus(token));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("managedRuntime.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t, token]);

  const follow = useCallback(async (initial: ManagedRuntimeInstallJob) => {
    if (!token || polling.current.has(initial.jobId)) return;
    polling.current.add(initial.jobId);
    let job = initial;
    try {
      while (job.state === "queued" || job.state === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 650));
        job = (await fetchManagedRuntimeInstallJob(token, job.jobId)).job;
        if (mounted.current) {
          setStatus((current) => current ? {
            ...current,
            jobs: [job, ...current.jobs.filter((item) => item.jobId !== job.jobId)],
          } : current);
        }
      }
      if (mounted.current) await load();
    } catch (reason) {
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : t("managedRuntime.installError"));
      }
    } finally {
      polling.current.delete(initial.jobId);
    }
  }, [load, t, token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    for (const job of status?.jobs ?? []) {
      if (job.state === "queued" || job.state === "running") void follow(job);
    }
  }, [follow, status?.jobs]);

  const latestJobs = useMemo(() => {
    const result = new Map<string, ManagedRuntimeInstallJob>();
    for (const job of status?.jobs ?? []) {
      if (!result.has(job.component)) result.set(job.component, job);
    }
    return result;
  }, [status?.jobs]);

  const migration = status?.migration;
  const hasLegacyResources = migration?.cleanupAvailable ?? false;

  const start = useCallback(async (component: string, repair = false) => {
    if (!token) return;
    setError(null);
    try {
      const response = await startManagedRuntimeInstall(token, component, repair);
      setStatus((current) => current ? {
        ...current,
        jobs: [response.job, ...current.jobs.filter((job) => job.jobId !== response.job.jobId)],
      } : current);
      void follow(response.job);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("managedRuntime.installError"));
    }
  }, [follow, t, token]);

  const updateAutoDownload = useCallback(async (autoDownload: boolean) => {
    if (!token || !status || updatingAutoDownload) return;
    const previous = status.autoDownload;
    setStatus((current) => current ? { ...current, autoDownload } : current);
    setUpdatingAutoDownload(true);
    setError(null);
    try {
      const response = await updateManagedRuntimeSettings(token, autoDownload);
      if (mounted.current) {
        setStatus((current) => current ? {
          ...current,
          autoDownload: response.autoDownload,
        } : current);
      }
    } catch (reason) {
      if (mounted.current) {
        setStatus((current) => current ? { ...current, autoDownload: previous } : current);
        setError(reason instanceof Error ? reason.message : t("managedRuntime.updateError"));
      }
    } finally {
      if (mounted.current) setUpdatingAutoDownload(false);
    }
  }, [status?.autoDownload, t, token, updatingAutoDownload]);

  const cleanup = useCallback(async () => {
    if (!token || cleaning) return;
    setCleaning(true);
    setError(null);
    try {
      await cleanupManagedRuntimes(token);
      await load();
    } catch (reason) {
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : t("managedRuntime.cleanupError"));
      }
    } finally {
      if (mounted.current) setCleaning(false);
    }
  }, [cleaning, load, t, token]);

  const cancel = useCallback(async (job: ManagedRuntimeInstallJob) => {
    if (!token) return;
    try {
      const response = await cancelManagedRuntimeInstall(token, job.jobId);
      setStatus((current) => current ? {
        ...current,
        jobs: [response.job, ...current.jobs.filter((item) => item.jobId !== job.jobId)],
      } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("managedRuntime.cancelError"));
    }
  }, [t, token]);

  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
        <SubsectionLabel>{t("managedRuntime.title")}</SubsectionLabel>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => void cleanup()} disabled={loading || cleaning}>
            <Trash2 className={`mr-1.5 h-3.5 w-3.5 ${cleaning ? "animate-pulse" : ""}`} />
            {cleaning
              ? t("managedRuntime.cleaning")
              : hasLegacyResources
                ? t("managedRuntime.cleanupLegacy")
                : t("managedRuntime.cleanup")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("managedRuntime.refresh")}
          </Button>
        </div>
      </div>
      <p className="mb-3 px-1 text-xs text-muted-foreground">{t("managedRuntime.description")}</p>
      {migration?.state === "completed" && migration.cleanupAvailable ? (
        <p className="mb-3 rounded-lg border border-success/30 bg-success/5 px-4 py-2 text-xs text-success">
          {t("managedRuntime.migration.completed", { size: formatBytes(migration.legacyBytes) })}
        </p>
      ) : null}
      {migration?.state === "partial" ? (
        <p className="mb-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-2 text-xs text-warning">
          {t("managedRuntime.migration.partial")}
        </p>
      ) : null}
      {migration && migration.repairComponents.length > 0 ? (
        <p className="mb-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-2 text-xs text-warning">
          {t("managedRuntime.migration.repair")}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/70">
        {error ? (
          <p className="border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-4 border-b border-border/45 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("managedRuntime.autoDownload")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("managedRuntime.autoDownloadDescription")}
            </p>
          </div>
          <Switch
            checked={status?.autoDownload ?? true}
            disabled={!status || loading || updatingAutoDownload || !token}
            aria-label={t("managedRuntime.autoDownload")}
            onCheckedChange={(value) => void updateAutoDownload(value)}
          />
        </div>
        {status?.components.map((component) => (
          <RuntimeRow
            key={component.component}
            component={component}
            job={latestJobs.get(component.component)}
            installEnabled={status.installEnabled}
            unavailableReason={status.installUnavailableReason}
            onInstall={(repair) => void start(component.component, repair)}
            onCancel={(job) => void cancel(job)}
          />
        ))}
        {!status && loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("managedRuntime.loading")}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RuntimeRow({
  component,
  job,
  installEnabled,
  unavailableReason,
  onInstall,
  onCancel,
}: {
  component: ManagedRuntimeComponent;
  job?: ManagedRuntimeInstallJob;
  installEnabled: boolean;
  unavailableReason?: string | null;
  onInstall: (repair: boolean) => void;
  onCancel: (job: ManagedRuntimeInstallJob) => void;
}) {
  const { t } = useTranslation();
  const running = job?.state === "queued" || job?.state === "running";
  const resumable = job?.state === "failed" || job?.state === "cancelled";
  const percent = job && job.totalBytes > 0
    ? Math.min(100, Math.round(job.downloadedBytes / job.totalBytes * 100))
    : 0;
  const Icon = component.component === "python" ? Code2 : TerminalSquare;
  const name = t(`managedRuntime.components.${component.component}.name`, {
    defaultValue: component.component,
  });
  const description = t(`managedRuntime.components.${component.component}.description`, {
    defaultValue: "",
  });
  const repair = resumable
    ? Boolean(job?.repair)
    : component.installed && !component.updateAvailable;
  return (
    <div className="flex items-center gap-4 border-b border-border/45 px-4 py-4 last:border-b-0">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {name}
          </span>
          {component.installed ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t("managedRuntime.installed", { version: component.installedVersion })}
            </span>
          ) : null}
        </div>
        {description || component.downloadBytes ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {description}
            {component.downloadBytes ? ` · ${formatBytes(component.downloadBytes)}` : ""}
          </p>
        ) : null}
        {running && job ? (
          <div className="mt-2 max-w-md">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(3, percent)}%` }} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("managedRuntime.installing", { percent })}
            </p>
          </div>
        ) : job?.state === "failed" || job?.state === "cancelled" ? (
          <p className="mt-1 text-xs text-destructive">
            {job.error || t("managedRuntime.installError")}
          </p>
        ) : !component.available && !component.installed ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("managedRuntime.catalogUnavailable")}
          </p>
        ) : !installEnabled && !component.installed ? (
          <p className="mt-1 text-xs text-warning">{unavailableReason}</p>
        ) : null}
      </div>
      {running && job ? (
        <Button variant="outline" size="sm" onClick={() => onCancel(job)}>
          {t("managedRuntime.cancel")}
        </Button>
      ) : (
        <Button
          variant={!resumable && component.installed && !component.updateAvailable ? "outline" : "default"}
          size="sm"
          disabled={!installEnabled || !component.available}
          onClick={() => onInstall(repair)}
        >
          {resumable
            ? t("managedRuntime.continue")
            : component.installed && !component.updateAvailable
              ? t("managedRuntime.repair")
            : component.updateAvailable
              ? t("managedRuntime.update")
              : t("managedRuntime.install")}
        </Button>
      )}
    </div>
  );
}

function formatBytes(value: number): string {
  return `${Math.max(1, Math.round(value / 1024 / 1024))} MB`;
}
