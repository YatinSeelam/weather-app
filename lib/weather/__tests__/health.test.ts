import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkWeatherHealth, isHealthy } from "../health";
import type { MonitorStore } from "../monitor-store";

const store = (listMonitors: MonitorStore["listMonitors"]) => ({ listMonitors }) as MonitorStore;
const workingStore = store(async () => []);

function mockUpstreams(handlers: { nws?: () => Response | Promise<Response>; geocoder?: () => Response | Promise<Response> }) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.href);
      if (url.hostname === "api.weather.gov") return handlers.nws ? handlers.nws() : new Response("{}", { status: 200 });
      return handlers.geocoder ? handlers.geocoder() : new Response("{}", { status: 200 });
    }),
  );
  return urls;
}

beforeEach(() => {
  (globalThis as { __weatherSingletons?: Map<string, unknown> }).__weatherSingletons?.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("weather health check", () => {
  it("reports every dependency as reachable with a latency", async () => {
    const urls = mockUpstreams({});
    const health = await checkWeatherHealth(workingStore);
    expect(health.nws).toEqual({ reachable: true, latencyMs: expect.any(Number) });
    expect(health.geocoder).toEqual({ reachable: true, latencyMs: expect.any(Number) });
    expect(health.storage).toEqual({ reachable: true, kind: "json-file" });
    expect(Date.parse(health.checkedAt)).not.toBeNaN();
    expect(isHealthy(health)).toBe(true);
    expect(urls).toContain("https://api.weather.gov/alerts/active/count");
  });

  it("reports an NWS outage without failing the other probes", async () => {
    mockUpstreams({ nws: () => new Response("down", { status: 503 }) });
    const health = await checkWeatherHealth(workingStore);
    expect(health.nws).toMatchObject({ reachable: false, detail: "HTTP 503" });
    expect(health.geocoder.reachable).toBe(true);
    expect(isHealthy(health)).toBe(false);
  });

  it("reports a network failure and unreadable storage", async () => {
    mockUpstreams({
      geocoder: () => {
        throw new TypeError("fetch failed");
      },
    });
    const health = await checkWeatherHealth(
      store(async () => {
        throw new Error("EACCES: /secret/path/weather-monitors.json");
      }),
    );
    expect(health.geocoder).toEqual({ reachable: false, latencyMs: null, detail: "Network error" });
    expect(health.storage).toEqual({ reachable: false, kind: "json-file" });
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("probes upstream services at most once per cache window", async () => {
    const urls = mockUpstreams({});
    await checkWeatherHealth(workingStore);
    await checkWeatherHealth(workingStore);
    expect(urls).toHaveLength(2);
  });
});
