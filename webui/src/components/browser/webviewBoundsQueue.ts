export interface WebviewBounds { left: number; top: number; width: number; height: number; visible: boolean }

export function sameWebviewBounds(a: WebviewBounds | null, b: WebviewBounds): boolean {
  return !!a && a.left === b.left && a.top === b.top && a.width === b.width
    && a.height === b.height && a.visible === b.visible;
}

/** One native request at a time; the last intent wins, including final unmount. */
export function createWebviewBoundsQueue(send: (bounds: WebviewBounds) => Promise<void>, onError: (error: unknown) => void) {
  let applied: WebviewBounds | null = null;
  let latest: WebviewBounds | null = null;
  let pending: WebviewBounds | null = null;
  let running: Promise<void> | null = null;
  let active = true;
  const enqueue = (bounds: WebviewBounds): Promise<void> => {
    latest = bounds;
    if (!running && sameWebviewBounds(applied, bounds)) return Promise.resolve();
    // A previously hidden page can have a show in flight; never drop its final hide.
    pending = bounds;
    if (!running) {
      running = (async () => {
        while (pending) {
          const next = pending;
          pending = null;
          if (sameWebviewBounds(applied, next)) continue;
          try { await send(next); applied = next; }
          catch (error) { applied = null; onError(error); }
        }
      })().finally(() => {
        running = null;
        if (pending) void enqueue(pending);
      });
    }
    return running;
  };
  return {
    activate() { active = true; },
    update(bounds: WebviewBounds) { return active ? enqueue(bounds) : Promise.resolve(); },
    dispose() {
      active = false;
      return latest ? enqueue({ ...latest, visible: false }) : Promise.resolve();
    },
  };
}

interface TabBoundsQueue {
  queue: ReturnType<typeof createWebviewBoundsQueue>;
  owner: symbol | null;
  onError: (error: unknown) => void;
}
const tabQueues = new Map<string, TabBoundsQueue>();

/** A remounted view shares its tab's in-flight IPC; obsolete views cannot hide it. */
export function createTabBoundsOwner(tabId: string, send: (bounds: WebviewBounds) => Promise<void>, onError: (error: unknown) => void) {
  const owner = Symbol(tabId);
  let entry: TabBoundsQueue | undefined;
  return {
    activate() {
      entry = tabQueues.get(tabId);
      if (!entry) {
        const created: TabBoundsQueue = { queue: createWebviewBoundsQueue(send, (error) => created.onError(error)), owner: null, onError };
        tabQueues.set(tabId, created);
        entry = created;
      }
      entry.owner = owner;
      entry.onError = onError;
      entry.queue.activate();
    },
    update(bounds: WebviewBounds) {
      return entry?.owner === owner ? entry.queue.update(bounds) : Promise.resolve();
    },
    dispose() {
      if (!entry || entry.owner !== owner) return Promise.resolve();
      const released = entry;
      released.owner = null;
      return released.queue.dispose().finally(() => {
        if (released.owner === null && tabQueues.get(tabId) === released) tabQueues.delete(tabId);
      });
    },
  };
}
