/** Run an async fn over items with bounded concurrency, preserving order. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Like `mapPool`, but each worker keeps a resource alive across the items it
 * handles — a browser page, in practice. Creating one page per task costs a page
 * lifecycle per screenshot; this reduces that to one per worker. `recycle` throws
 * the current resource away and builds a fresh one, for when it can't be trusted
 * any more (a wedged renderer after a failed capture).
 */
export async function mapPoolWithResource<T, R, C>(
  items: T[],
  concurrency: number,
  hooks: {
    create: () => Promise<C>;
    dispose: (resource: C) => Promise<void>;
    run: (item: T, resource: C, recycle: () => Promise<C>, index: number) => Promise<R>;
  },
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));

  const workers = Array.from({ length: workerCount }, async () => {
    let resource: C | undefined;
    const recycle = async (): Promise<C> => {
      if (resource !== undefined) await hooks.dispose(resource).catch(() => {});
      resource = await hooks.create();
      return resource;
    };
    try {
      for (;;) {
        const idx = next++;
        if (idx >= items.length) break;
        if (resource === undefined) resource = await hooks.create();
        results[idx] = await hooks.run(items[idx], resource, recycle, idx);
      }
    } finally {
      if (resource !== undefined) await hooks.dispose(resource).catch(() => {});
    }
  });

  await Promise.all(workers);
  return results;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}
