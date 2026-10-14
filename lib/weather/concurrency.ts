export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `maxConcurrent` tasks at once; the rest wait in FIFO order. */
export function createLimiter(maxConcurrent: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrent) {
      // The finishing task hands its slot straight to us, so `active` is not touched here.
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * Process-wide singletons. Next.js can load a module more than once (per route bundle,
 * or on dev reloads); caches and limiters must still be shared.
 */
export function singleton<T>(key: string, create: () => T): T {
  const store = globalThis as typeof globalThis & { __weatherSingletons?: Map<string, unknown> };
  store.__weatherSingletons ??= new Map();
  if (!store.__weatherSingletons.has(key)) {
    store.__weatherSingletons.set(key, create());
  }
  return store.__weatherSingletons.get(key) as T;
}
