import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AlertStateRecord, RiskChange } from "./alert-change";
import { singleton } from "./concurrency";
import { dataDirectory } from "./config";
import { DEFAULT_EMAIL_MODE } from "./constants";
import { WeatherError } from "./errors";
import type { EmailMode, MonitorInterval, RiskSelection, SeverityLevel, WeatherThresholds } from "./types";

/** Mirrors a `weather_monitors` row, so moving to a database later is a storage swap only. */
export type WeatherMonitor = {
  id: string;
  /** Reserved for when the app gains accounts. Always null today. */
  userId: string | null;
  name: string;
  zipCode: string;
  city: string;
  state: string;
  centerLat: number;
  centerLng: number;
  radiusMiles: number;
  intervalMinutes: MonitorInterval;
  enabled: boolean;
  riskTypes: RiskSelection[];
  thresholds: Partial<WeatherThresholds>;
  /** Who gets emailed about this monitor. Empty means nobody. */
  emails: string[];
  emailMode: EmailMode;
  createdAt: string;
  updatedAt: string;
  /** Last attempt, successful or not. */
  lastCheckedAt: string | null;
  /** Last run that actually reached the live weather sources. */
  lastSuccessfulCheckAt?: string | null;
  nextCheckAt: string;
  lastRun: MonitorRun | null;
};

/** Mirrors a `weather_monitor_runs` row. */
export type MonitorRun = {
  id: string;
  monitorId: string;
  startedAt: string;
  completedAt: string;
  status: "ok" | "partial" | "failed";
  activeRiskCount: number;
  highestSeverity: SeverityLevel | null;
  errorSummary: string | null;
  /** What changed since the previous run (never includes UNCHANGED). */
  changes: RiskChange[];
};

export interface MonitorStore {
  listMonitors(): Promise<WeatherMonitor[]>;
  getMonitor(id: string): Promise<WeatherMonitor | null>;
  /** With `maxActive`, refuses (MONITOR_LIMIT) when that many monitors are already enabled. */
  createMonitor(monitor: WeatherMonitor, options?: CapacityOptions): Promise<WeatherMonitor>;
  /** With `maxActive`, refuses (MONITOR_LIMIT) to enable a paused monitor when the limit is reached. */
  updateMonitor(
    id: string,
    patch: Partial<Omit<WeatherMonitor, "id">>,
    options?: CapacityOptions,
  ): Promise<WeatherMonitor | null>;
  deleteMonitor(id: string): Promise<boolean>;
  getAlertStates(monitorId: string): Promise<AlertStateRecord[]>;
  replaceAlertStates(monitorId: string, states: AlertStateRecord[]): Promise<void>;
  appendRun(run: MonitorRun): Promise<void>;
  listRuns(monitorId: string, limit?: number): Promise<MonitorRun[]>;
}

export type CapacityOptions = { maxActive?: number };

/** Checked inside the store's transaction, so concurrent requests cannot both squeeze past it. */
function assertRoomForActiveMonitor(monitors: WeatherMonitor[], maxActive: number | undefined): void {
  if (maxActive === undefined) return;
  if (monitors.filter((m) => m.enabled).length >= maxActive) {
    throw new WeatherError(
      "MONITOR_LIMIT",
      `At most ${maxActive} monitors can be active at once. Pause or delete one first.`,
    );
  }
}

type StoreFile = {
  version: 1;
  monitors: WeatherMonitor[];
  alertStates: AlertStateRecord[];
  runs: MonitorRun[];
};

const EMPTY: StoreFile = { version: 1, monitors: [], alertStates: [], runs: [] };
const MAX_RUNS_PER_MONITOR = 50;

/**
 * Saved monitors in a single JSON file. Deliberately simple: no database to set up. All
 * access goes through one in-process queue and writes are atomic (temp file + rename).
 * Suitable for a single server process; swap in a database-backed MonitorStore to scale out.
 */
export class JsonFileMonitorStore implements MonitorStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async read(): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoreFile>;
      return {
        version: 1,
        // Monitors saved before email support have neither field.
        monitors: (parsed.monitors ?? []).map((monitor) => ({
          ...monitor,
          emails: monitor.emails ?? [],
          emailMode: monitor.emailMode ?? DEFAULT_EMAIL_MODE,
        })),
        alertStates: parsed.alertStates ?? [],
        runs: parsed.runs ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw error;
    }
  }

  private async write(data: StoreFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2), "utf8");
    await rename(temp, this.filePath);
  }

  /** Serializes every read-modify-write so concurrent requests cannot lose updates. */
  private transact<T>(work: (data: StoreFile) => { result: T; save: boolean }): Promise<T> {
    const next = this.queue.then(async () => {
      const data = await this.read();
      const { result, save } = work(data);
      if (save) await this.write(data);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  listMonitors() {
    return this.transact((data) => ({
      result: [...data.monitors].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      save: false,
    }));
  }

  getMonitor(id: string) {
    return this.transact((data) => ({ result: data.monitors.find((m) => m.id === id) ?? null, save: false }));
  }

  createMonitor(monitor: WeatherMonitor, options: CapacityOptions = {}) {
    return this.transact((data) => {
      if (monitor.enabled) assertRoomForActiveMonitor(data.monitors, options.maxActive);
      data.monitors.push(monitor);
      return { result: monitor, save: true };
    });
  }

  updateMonitor(id: string, patch: Partial<Omit<WeatherMonitor, "id">>, options: CapacityOptions = {}) {
    return this.transact((data) => {
      const index = data.monitors.findIndex((m) => m.id === id);
      if (index === -1) return { result: null, save: false };
      if (patch.enabled === true && !data.monitors[index].enabled) {
        assertRoomForActiveMonitor(data.monitors, options.maxActive);
      }
      data.monitors[index] = { ...data.monitors[index], ...patch };
      return { result: data.monitors[index], save: true };
    });
  }

  deleteMonitor(id: string) {
    return this.transact((data) => {
      const before = data.monitors.length;
      data.monitors = data.monitors.filter((m) => m.id !== id);
      data.alertStates = data.alertStates.filter((s) => s.monitorId !== id);
      data.runs = data.runs.filter((r) => r.monitorId !== id);
      const removed = data.monitors.length < before;
      return { result: removed, save: removed };
    });
  }

  getAlertStates(monitorId: string) {
    return this.transact((data) => ({
      result: data.alertStates.filter((s) => s.monitorId === monitorId),
      save: false,
    }));
  }

  replaceAlertStates(monitorId: string, states: AlertStateRecord[]) {
    return this.transact((data) => {
      data.alertStates = [...data.alertStates.filter((s) => s.monitorId !== monitorId), ...states];
      return { result: undefined, save: true };
    });
  }

  appendRun(run: MonitorRun) {
    return this.transact((data) => {
      const own = [...data.runs.filter((r) => r.monitorId === run.monitorId), run].slice(-MAX_RUNS_PER_MONITOR);
      data.runs = [...data.runs.filter((r) => r.monitorId !== run.monitorId), ...own];
      return { result: undefined, save: true };
    });
  }

  listRuns(monitorId: string, limit = 20) {
    return this.transact((data) => ({
      result: data.runs
        .filter((r) => r.monitorId === monitorId)
        .slice(-limit)
        .reverse(),
      save: false,
    }));
  }
}

export function getMonitorStore(): MonitorStore {
  return singleton(
    "monitor-store",
    () => new JsonFileMonitorStore(path.join(dataDirectory(), "weather-monitors.json")),
  );
}
