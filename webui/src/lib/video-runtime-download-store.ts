import { create } from "zustand";

import {
  cancelVideoRuntimeDownload,
  fetchVideoRuntimeDownloadJobs,
  startVideoRuntimeDownload,
  type VideoRuntimeComponent,
  type VideoRuntimeDownloadJob,
} from "@/lib/api";

interface RuntimeDownloadState {
  jobs: VideoRuntimeDownloadJob[];
  error: string | null;
  setJobs: (jobs: VideoRuntimeDownloadJob[]) => void;
  setError: (error: string | null) => void;
  clearFinished: () => void;
}

export async function cancelVideoRuntimeDownloads(
  token: string,
  jobId: string,
): Promise<void> {
  const result = await cancelVideoRuntimeDownload(token, jobId);
  if (!result.ok || !result.job) {
    throw new Error(result.error || "停止下载失败");
  }
  const current = useVideoRuntimeDownloadStore.getState().jobs;
  useVideoRuntimeDownloadStore
    .getState()
    .setJobs(current.map((job) => (job.jobId === jobId ? result.job! : job)));
}

export const useVideoRuntimeDownloadStore = create<RuntimeDownloadState>(
  (set) => ({
    jobs: [],
    error: null,
    setJobs: (jobs) => set({ jobs, error: null }),
    setError: (error) => set({ error }),
    clearFinished: () =>
      set((state) => ({
        jobs: state.jobs.filter((job) => job.state === "running"),
      })),
  }),
);

export async function refreshVideoRuntimeDownloads(
  token: string,
): Promise<void> {
  if (!token) return;
  try {
    const result = await fetchVideoRuntimeDownloadJobs(token);
    useVideoRuntimeDownloadStore.getState().setJobs(result.jobs ?? []);
  } catch (error) {
    useVideoRuntimeDownloadStore
      .getState()
      .setError(error instanceof Error ? error.message : String(error));
  }
}

export async function startVideoRuntimeDownloads(
  token: string,
  components: VideoRuntimeComponent[],
): Promise<VideoRuntimeDownloadJob> {
  const result = await startVideoRuntimeDownload(token, components);
  if (!result.ok || !result.job) {
    throw new Error(result.error || "启动下载失败");
  }
  const current = useVideoRuntimeDownloadStore.getState().jobs;
  useVideoRuntimeDownloadStore
    .getState()
    .setJobs([
      result.job,
      ...current.filter((job) => job.jobId !== result.job?.jobId),
    ]);
  return result.job;
}
