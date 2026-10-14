import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type Entry<V> = { value: V; expiresAt: number };

/** In-memory TTL cache that also de-duplicates concurrent loads of the same key. */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();

  constructor(private readonly maxEntries = 1000) {}

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + ttlMs });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  async getOrLoad(key: string, ttlMs: number, load: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = load()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}

function cacheDirectory(): string | null {
  if (process.env.WEATHER_DISK_CACHE === "off") return null;
  return process.env.WEATHER_CACHE_DIR ?? path.join(process.cwd(), ".cache", "weather");
}

type StoredFile<V> = { savedAt: number; value: V };

/**
 * Memory cache backed by one small JSON file per key, for data that is expensive to refetch
 * and rarely changes (ZIP centers, NWS grid lookups, zone boundaries). Disk failures are
 * never fatal: on a read-only filesystem this degrades to a memory-only cache.
 */
export class PersistentCache<V> {
  private readonly memory = new TtlCache<V>(10_000);

  constructor(
    private readonly namespace: string,
    private readonly ttlMs: number,
  ) {}

  getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    return this.memory.getOrLoad(key, this.ttlMs, async () => {
      const stored = await this.readFromDisk(key);
      if (stored !== undefined) return stored;
      const value = await load();
      void this.writeToDisk(key, value);
      return value;
    });
  }

  private filePath(key: string): string | null {
    const dir = cacheDirectory();
    if (!dir) return null;
    return path.join(dir, this.namespace, `${encodeURIComponent(key)}.json`);
  }

  private async readFromDisk(key: string): Promise<V | undefined> {
    const file = this.filePath(key);
    if (!file) return undefined;
    try {
      const stored = JSON.parse(await readFile(file, "utf8")) as StoredFile<V>;
      if (typeof stored?.savedAt !== "number" || Date.now() - stored.savedAt > this.ttlMs) return undefined;
      return stored.value;
    } catch {
      return undefined;
    }
  }

  private async writeToDisk(key: string, value: V): Promise<void> {
    const file = this.filePath(key);
    if (!file) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      const payload: StoredFile<V> = { savedAt: Date.now(), value };
      await writeFile(temp, JSON.stringify(payload), "utf8");
      await rename(temp, file);
    } catch {
      // Best effort only.
    }
  }
}
