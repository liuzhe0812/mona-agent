export function waitForCanvasTask<T>(task: Promise<T>, signal?: AbortSignal, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (error?: unknown, value?: T) => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = () => finish(signal?.reason ?? new Error("画布操作已取消"));
    const timer = window.setTimeout(() => finish(new Error("等待画布渲染超时")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    task.then((value) => finish(undefined, value), (error) => finish(error));
    if (signal?.aborted) onAbort();
  });
}

export async function waitForCanvasRender(root: HTMLElement | null, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!root?.isConnected) throw new Error("画布 DOM 尚未挂载");
  const rect = root.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2 || document.visibilityState === "hidden") {
    throw new Error("画布当前不可见，无法进行真实渲染检查");
  }
  if (document.fonts?.status === "loading") await waitForCanvasTask(document.fonts.ready, signal);
  let frame = 0;
  try {
    await waitForCanvasTask(new Promise<void>((resolve) => {
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => resolve()); });
    }), signal);
    signal?.throwIfAborted();
    if (!root.isConnected) throw new Error("画布已关闭");
  } finally {
    cancelAnimationFrame(frame);
  }
}
