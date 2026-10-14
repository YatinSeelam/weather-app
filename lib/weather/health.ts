import { TtlCache } from "./cache";
import { singleton } from "./concurrency";
import { nwsBaseUrl, nwsUserAgent, zipApiBaseUrl } from "./config";
import { getMonitorStore, type MonitorStore } from "./monitor-store";

export type ProbeResult = {
  reachable: boolean;
  latencyMs: number | null;
  /** Why it is unreachable. Never contains credentials or internal paths. */
  detail?: string;
};

export type WeatherHealth = {
  nws: ProbeResult;
  geocoder: ProbeResult;
  storage: { reachable: boolean; kind: "json-file" | "postgres" };
  checkedAt: string;
};

const PROBE_TIMEOUT_MS = 5_000;
/** Upstream services are probed at most this often, however many times the endpoint is hit. */
const HEALTH_CACHE_MS = 15_000;

async function probe(url: string, headers: Record<string, string>): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const latencyMs = Math.round(performance.now() - started);
    return response.ok ? { reachable: true, latencyMs } : { reachable: false, latencyMs, detail: `HTTP ${response.status}` };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { reachable: false, latencyMs: null, detail: timedOut ? "Timed out" : "Network error" };
  }
}

async function probeStorage(store: MonitorStore): Promise<WeatherHealth["storage"]> {
  const kind = store.kind ?? "json-file";
  try {
    await store.listMonitors();
    return { reachable: true, kind };
  } catch {
    return { reachable: false, kind };
  }
}

const healthCache = () => singleton("weather-health", () => new TtlCache<WeatherHealth>(1));

/** Live reachability of everything a weather check depends on. Makes real requests. */
export function checkWeatherHealth(store: MonitorStore = getMonitorStore()): Promise<WeatherHealth> {
  return healthCache().getOrLoad("health", HEALTH_CACHE_MS, async () => {
    const [nws, geocoder, storage] = await Promise.all([
      // The lightest alert endpoint: just counts, a few hundred bytes.
      probe(`${nwsBaseUrl()}/alerts/active/count`, { "User-Agent": nwsUserAgent(), Accept: "application/ld+json" }),
      probe(`${zipApiBaseUrl()}/us/20500`, { Accept: "application/json" }),
      probeStorage(store),
    ]);
    return { nws, geocoder, storage, checkedAt: new Date().toISOString() };
  });
}

export function isHealthy(health: WeatherHealth): boolean {
  return health.nws.reachable && health.geocoder.reachable && health.storage.reachable;
}
