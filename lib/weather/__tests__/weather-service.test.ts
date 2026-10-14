import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "../cache";
import { createLimiter } from "../concurrency";
import { isCheckComplete } from "../coverage";
import { destinationPoint } from "../geography";
import { checkWeather } from "../weather-service";
import {
  alertFeature,
  CENTER,
  gridpointPayload,
  jsonResponse,
  NOW,
  pointPayload,
  squareAround,
  zipPayload,
  zonePayload,
} from "./fixtures";

type Handler = (url: URL) => Response | Promise<Response>;

/**
 * Replaces global fetch with a router over the NWS and ZIP endpoints. Each test starts with
 * fresh in-memory caches, and the network is never touched.
 */
function mockNetwork(handlers: {
  alerts?: unknown[] | Handler;
  zones?: Record<string, unknown> | Handler;
  point?: Handler;
  gridpoint?: Handler;
  zip?: Handler;
}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);

    if (url.hostname === "api.zippopotam.us") return handlers.zip ? handlers.zip(url) : jsonResponse(zipPayload);
    if (url.pathname === "/alerts/active") {
      if (typeof handlers.alerts === "function") return handlers.alerts(url);
      return jsonResponse({ type: "FeatureCollection", features: handlers.alerts ?? [] });
    }
    if (url.pathname.startsWith("/zones/")) {
      if (typeof handlers.zones === "function") return handlers.zones(url);
      const zone = handlers.zones?.[url.pathname.split("/").pop() ?? ""];
      return zone ? jsonResponse(zone) : jsonResponse({ detail: "Not Found" }, 404);
    }
    if (url.pathname.startsWith("/points/")) {
      return handlers.point ? handlers.point(url) : jsonResponse(pointPayload(1, 1));
    }
    if (url.pathname.startsWith("/gridpoints/")) {
      return handlers.gridpoint ? handlers.gridpoint(url) : jsonResponse(gridpointPayload({ temperatureC: [15, 14] }));
    }
    return jsonResponse({ detail: "Unexpected request" }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const ALL_RISKS = ["tornado", "thunderstorm", "flood", "wind", "heavy-rain", "freezing", "winter", "other"] as const;
const check = (overrides: Partial<Parameters<typeof checkWeather>[0]> = {}) =>
  checkWeather({ zipCode: "12477", radiusMiles: 100, risks: [...ALL_RISKS], ...overrides }, NOW);

/** Every sample point maps to its own grid cell, so each one produces its own result. */
const uniqueGridCells: Handler = (url) => {
  const [latitude, longitude] = url.pathname.split("/").pop()!.split(",").map(Number);
  return jsonResponse(pointPayload(Math.round(latitude * 100), Math.round(Math.abs(longitude) * 100)));
};

beforeEach(() => {
  // Drop process-wide caches between tests.
  (globalThis as { __weatherSingletons?: Map<string, unknown> }).__weatherSingletons?.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("checkWeather: official alerts within the radius", () => {
  const east = (miles: number) => destinationPoint(CENTER, miles, 90);

  it("resolves the ZIP code to its center", async () => {
    mockNetwork({});
    const result = await check();
    expect(result.center).toEqual({
      zipCode: "12477",
      city: "Saugerties",
      state: "NY",
      latitude: 42.0738,
      longitude: -73.9797,
    });
    expect(result.checkedAt).toBe(NOW.toISOString());
  });

  it("finds an alert far from the center but inside the radius, and ignores one outside it", async () => {
    const near = east(80);
    const far = east(160);
    mockNetwork({
      alerts: [
        alertFeature({ id: "inside", event: "Tornado Warning", severity: "Extreme", geometry: squareAround(near.longitude, near.latitude) }),
        alertFeature({ id: "outside", event: "Flood Warning", geometry: squareAround(far.longitude, far.latitude) }),
      ],
    });

    const result = await check();
    expect(result.officialAlerts.map((alert) => alert.id)).toEqual(["inside"]);
    const [alert] = result.officialAlerts;
    expect(alert).toMatchObject({
      source: "NWS",
      category: "official-alert",
      event: "Tornado Warning",
      riskType: "tornado",
      level: "critical",
      geometrySource: "nws-polygon",
    });
    expect(alert.distanceMiles).toBeGreaterThan(70);
    expect(alert.distanceMiles).toBeLessThan(80);
    expect(alert.geometry?.type).toBe("Polygon");
    expect(alert.anchor).not.toBeNull();
  });

  it("includes a polygon that only clips the edge of the radius", async () => {
    const centroid = east(108);
    mockNetwork({
      alerts: [alertFeature({ id: "clipping", geometry: squareAround(centroid.longitude, centroid.latitude, 0.3) })],
    });
    expect((await check()).officialAlerts.map((alert) => alert.id)).toEqual(["clipping"]);
    expect((await check({ radiusMiles: 50 })).officialAlerts).toEqual([]);
  });

  it("locates alerts that have no geometry by resolving their forecast zones", async () => {
    const zoneCenter = east(40);
    const { calls } = mockNetwork({
      alerts: [
        alertFeature({
          id: "zone-based",
          event: "Winter Storm Warning",
          geometry: null,
          affectedZones: ["https://api.weather.gov/zones/forecast/NYZ064", "https://api.weather.gov/zones/forecast/NYZ065"],
          geocode: { UGC: ["NYZ064", "NYZ065"] },
        }),
      ],
      zones: {
        NYZ064: zonePayload("NYZ064", squareAround(zoneCenter.longitude, zoneCenter.latitude, 0.2)),
        NYZ065: zonePayload("NYZ065", squareAround(zoneCenter.longitude + 0.5, zoneCenter.latitude, 0.2)),
      },
    });

    const [alert] = (await check()).officialAlerts;
    expect(alert).toMatchObject({ id: "zone-based", riskType: "winter", geometrySource: "nws-zones" });
    expect(alert.geometry?.type).toBe("MultiPolygon");
    expect(alert.distanceMiles).toBeGreaterThan(25);
    expect(alert.distanceMiles).toBeLessThan(35);
    expect(calls.filter((path) => path.startsWith("/zones/"))).toHaveLength(2);
  });

  it("does not fetch zone boundaries for alerts in distant states", async () => {
    const { calls } = mockNetwork({
      alerts: [
        alertFeature({
          id: "florida",
          geometry: null,
          affectedZones: ["https://api.weather.gov/zones/forecast/FLZ076"],
          geocode: { UGC: ["FLZ076"] },
        }),
      ],
    });
    expect((await check()).officialAlerts).toEqual([]);
    expect(calls.some((path) => path.startsWith("/zones/"))).toBe(false);
  });

  it("warns instead of guessing when a zone-based alert cannot be located", async () => {
    mockNetwork({
      alerts: [
        alertFeature({
          id: "unlocatable",
          geometry: null,
          affectedZones: ["https://api.weather.gov/zones/forecast/NYZ064"],
          geocode: { UGC: ["NYZ064"] },
        }),
      ],
      zones: () => {
        throw new TypeError("network down");
      },
    });

    const result = await check();
    expect(result.officialAlerts).toEqual([]);
    expect(result.warnings.join(" ")).toContain("1 active alert in the region could not be placed on the map");
  });

  it("drops cancelled and expired alerts", async () => {
    const near = east(10);
    const geometry = squareAround(near.longitude, near.latitude);
    mockNetwork({
      alerts: [
        alertFeature({ id: "cancelled", response: "AllClear", geometry }),
        alertFeature({ id: "expired", ends: "2026-10-06T19:00:00Z", geometry }),
        alertFeature({ id: "current", geometry }),
      ],
    });
    expect((await check()).officialAlerts.map((alert) => alert.id)).toEqual(["current"]);
  });

  it("only returns the risk types the user asked for", async () => {
    const near = east(10);
    const geometry = squareAround(near.longitude, near.latitude);
    mockNetwork({
      alerts: [
        alertFeature({ id: "tornado", event: "Tornado Warning", geometry }),
        alertFeature({ id: "flood", event: "Flood Warning", geometry }),
        alertFeature({ id: "marine", event: "Small Craft Advisory", geometry }),
      ],
    });
    expect((await check({ risks: ["flood"] })).officialAlerts.map((a) => a.id)).toEqual(["flood"]);
    expect((await check({ risks: ["tornado", "other"] })).officialAlerts.map((a) => a.id).sort()).toEqual(["marine", "tornado"]);
  });

  it("sorts by severity, then by distance", async () => {
    const at = (miles: number) => {
      const p = east(miles);
      return squareAround(p.longitude, p.latitude, 0.05);
    };
    mockNetwork({
      alerts: [
        alertFeature({ id: "minor-near", event: "Frost Advisory", severity: "Minor", geometry: at(5) }),
        alertFeature({ id: "severe-far", event: "Flood Warning", severity: "Severe", geometry: at(70) }),
        alertFeature({ id: "severe-near", event: "Flood Warning", severity: "Severe", geometry: at(20) }),
        alertFeature({ id: "tornado", event: "Tornado Warning", severity: "Extreme", geometry: at(90) }),
      ],
    });
    const result = await check();
    expect(result.officialAlerts.map((a) => a.id)).toEqual(["tornado", "severe-near", "severe-far", "minor-near"]);
    expect(result.summary).toMatchObject({ officialAlertCount: 4, totalActiveRisks: 4, highestSeverity: "critical" });
  });

  it("skips a malformed alert without losing the rest of the feed", async () => {
    const near = east(10);
    mockNetwork({
      alerts: [
        { properties: { nothing: "useful" } },
        "not even an object",
        alertFeature({ id: "good", geometry: squareAround(near.longitude, near.latitude) }),
      ],
    });
    expect((await check()).officialAlerts.map((alert) => alert.id)).toEqual(["good"]);
  });

  it("fails loudly when the alert feed is unavailable rather than reporting no alerts", async () => {
    mockNetwork({ alerts: () => jsonResponse({ detail: "upstream error" }, 503) });
    await expect(check()).rejects.toMatchObject({
      code: "NWS_UNAVAILABLE",
      status: 502,
      source: "alerts",
      message: "Unable to retrieve live NWS alerts. The National Weather Service returned 503.",
    });
  });

  it("does not ask NWS for alerts when no alert-based risk is selected", async () => {
    const { calls } = mockNetwork({});
    await check({ risks: ["heavy-rain"] });
    expect(calls).not.toContain("/alerts/active");
  });
});

describe("checkWeather: detected risks across the radius", () => {
  it("samples the whole radius and reports nothing in mild weather", async () => {
    mockNetwork({ point: uniqueGridCells });
    const result = await check();
    expect(result.sampling).toEqual({
      requestedPoints: 37,
      successfulPoints: 37,
      failedPoints: 0,
      outsideCoveragePoints: 0,
    });
    expect(result.source.coverage).toEqual({ alerts: "complete", forecasts: "complete" });
    expect(result.detectedRisks).toEqual([]);
    expect(result.summary).toMatchObject({ totalActiveRisks: 0, highestSeverity: null });
    expect(result.warnings).toEqual([]);
  });

  it("detects freezing, wind and rain from forecast grid data and converts units", async () => {
    mockNetwork({
      point: uniqueGridCells,
      gridpoint: () =>
        jsonResponse(
          gridpointPayload({
            temperatureC: [-3, -4],
            apparentC: [-8, -9],
            windKmh: [30, 35],
            gustKmh: [70, 84],
            rainMm: [30, 5],
          }),
        ),
    });
    const result = await check({ radiusMiles: 25 });
    expect(result.sampling.requestedPoints).toBe(7);
    expect(result.detectedRisks).toHaveLength(21);
    expect(result.summary).toMatchObject({ detectedRiskTypeCount: 3, totalActiveRisks: 3, affectedLocations: 7 });

    const atCenter = result.detectedRisks.filter((risk) => risk.distanceMiles === 0);
    expect(atCenter.find((risk) => risk.riskType === "freezing")).toMatchObject({
      category: "detected-risk",
      severity: "moderate",
      observedValue: 25,
      threshold: 32,
      unit: "°F",
      locationLabel: "Near Kingston, NY",
    });
    expect(atCenter.find((risk) => risk.riskType === "high-wind")).toMatchObject({ observedValue: 52, unit: "mph" });
    expect(atCenter.find((risk) => risk.riskType === "heavy-rain")).toMatchObject({ observedValue: 1.18, unit: "in" });
  });

  it("returns partial results when some sample locations fail", async () => {
    const broken = new Set<string>();
    mockNetwork({
      point: (url) => {
        // Three locations fail every time, including on retry.
        if (broken.size < 3) broken.add(url.pathname);
        return broken.has(url.pathname) ? jsonResponse({ detail: "upstream error" }, 500) : uniqueGridCells(url);
      },
      gridpoint: () => jsonResponse(gridpointPayload({ temperatureC: [-5] })),
    });

    const result = await check({ radiusMiles: 50 });
    expect(result.sampling).toEqual({
      requestedPoints: 19,
      successfulPoints: 16,
      failedPoints: 3,
      outsideCoveragePoints: 0,
    });
    expect(result.warnings).toEqual(["Weather data was unavailable for 3 of 19 sample locations."]);
    expect(result.source.coverage.forecasts).toBe("partial");
    expect(result.detectedRisks).toHaveLength(16);
  });

  it("treats locations NWS does not cover as expected gaps, not failures", async () => {
    const offshore = new Set<string>();
    mockNetwork({
      point: (url) => {
        if (offshore.size < 3) offshore.add(url.pathname);
        return offshore.has(url.pathname) ? jsonResponse({ detail: "Not Found" }, 404) : uniqueGridCells(url);
      },
    });

    const result = await check({ radiusMiles: 50 });
    expect(result.sampling).toEqual({
      requestedPoints: 19,
      successfulPoints: 16,
      failedPoints: 0,
      outsideCoveragePoints: 3,
    });
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual([
      "3 of 19 sample locations are outside NWS forecast coverage (offshore or outside the U.S.) and were skipped.",
    ]);
    expect(result.source.coverage.forecasts).toBe("complete");
  });

  it("still returns official alerts when every forecast request fails, and says the check is incomplete", async () => {
    const near = destinationPoint(CENTER, 10, 0);
    mockNetwork({
      alerts: [alertFeature({ id: "still-here", geometry: squareAround(near.longitude, near.latitude) })],
      point: uniqueGridCells,
      gridpoint: () => jsonResponse({ detail: "upstream error" }, 500),
    });
    const result = await check({ radiusMiles: 25 });
    expect(result.officialAlerts.map((a) => a.id)).toEqual(["still-here"]);
    expect(result.sampling).toMatchObject({ successfulPoints: 0, failedPoints: 7 });
    expect(result.source.coverage).toEqual({ alerts: "complete", forecasts: "unavailable" });
    expect(result.warnings).toEqual([
      "Unable to retrieve live NWS forecast data for any of the 7 sample locations, so temperature, wind and rain risks were not evaluated.",
    ]);
  });

  it("never reports an empty result as complete when forecasts could not be read", async () => {
    mockNetwork({ point: () => jsonResponse({ detail: "Not Found" }, 404) });
    const result = await check({ radiusMiles: 25 });
    expect(result.summary.totalActiveRisks).toBe(0);
    expect(result.source.coverage.forecasts).toBe("unavailable");
    expect(isCheckComplete(result.source)).toBe(false);
    expect(result.warnings[0]).toContain("were not evaluated");
  });

  it("retries a transient NWS failure", async () => {
    let attempts = 0;
    mockNetwork({
      point: uniqueGridCells,
      gridpoint: () => {
        attempts++;
        return attempts === 1 ? jsonResponse({ detail: "try again" }, 500) : jsonResponse(gridpointPayload({ temperatureC: [10] }));
      },
    });
    const result = await check({ radiusMiles: 25 });
    expect(result.sampling.failedPoints).toBe(0);
  });

  it("fetches each forecast grid cell once even when several sample points share it", async () => {
    const { calls } = mockNetwork({ point: () => jsonResponse(pointPayload(5, 5)) });
    await check({ radiusMiles: 50 });
    expect(calls.filter((path) => path.startsWith("/points/"))).toHaveLength(19);
    expect(calls.filter((path) => path.startsWith("/gridpoints/"))).toHaveLength(1);
  });

  it("serves a repeat check from cache without new NWS requests", async () => {
    const { calls } = mockNetwork({ point: uniqueGridCells });
    await check({ radiusMiles: 25 });
    const afterFirst = calls.length;
    await check({ radiusMiles: 25 });
    expect(calls.length).toBe(afterFirst);
  });

  it("identifies itself to NWS with a User-Agent", async () => {
    vi.stubEnv("NWS_USER_AGENT", "test-suite (ops@example.com)");
    const { fetchMock } = mockNetwork({});
    await check({ radiusMiles: 25 });
    const nwsCall = fetchMock.mock.calls.find(([input]) => String(input).includes("api.weather.gov"));
    const [, init] = nwsCall as unknown as [unknown, RequestInit];
    expect(init.headers).toMatchObject({ "User-Agent": "test-suite (ops@example.com)" });
  });
});

describe("checkWeather: ZIP handling", () => {
  it("rejects malformed ZIP codes before any request", async () => {
    const { calls } = mockNetwork({});
    for (const zipCode of ["1247", "124777", "12a77", "", "12 477"]) {
      await expect(check({ zipCode })).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
    }
    expect(calls).toEqual([]);
  });

  it("reports an unknown ZIP code clearly", async () => {
    mockNetwork({ zip: () => jsonResponse({}, 404) });
    await expect(check({ zipCode: "00000" })).rejects.toMatchObject({
      code: "ZIP_NOT_FOUND",
      status: 404,
      message: "No U.S. location found for ZIP code 00000.",
    });
  });

  it("reports a geocoder outage as a geocoding failure", async () => {
    mockNetwork({ zip: () => jsonResponse({}, 503) });
    await expect(check()).rejects.toMatchObject({ code: "GEOCODING_FAILED", source: "geocoding" });
  });
});

describe("live data only", () => {
  it("reports where every part of the result came from", async () => {
    const near = destinationPoint(CENTER, 10, 0);
    mockNetwork({
      alerts: [
        alertFeature({ id: "near", geometry: squareAround(near.longitude, near.latitude) }),
        alertFeature({ id: "also-near", event: "Small Craft Advisory", geometry: squareAround(near.longitude, near.latitude) }),
      ],
    });
    const result = await check({ radiusMiles: 25, risks: ["flood", "freezing"] });
    expect(result.source).toEqual({
      live: true,
      providers: {
        alerts: "NOAA / National Weather Service",
        forecasts: "NOAA / National Weather Service",
        geocoding: "Zippopotam.us",
        map: "OpenFreeMap / OpenStreetMap",
      },
      hosts: { nws: "api.weather.gov", geocoding: "api.zippopotam.us" },
      checkedAt: NOW.toISOString(),
      fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      nwsAlertsReceived: 2,
      coverage: { alerts: "complete", forecasts: "complete" },
    });
    expect(isCheckComplete(result.source)).toBe(true);
    // Both alerts are in range; only the selected risk type is returned.
    expect(result.officialAlerts.map((alert) => alert.id)).toEqual(["near"]);
  });

  it("marks data it was not asked for as not requested", async () => {
    mockNetwork({});
    const result = await check({ radiusMiles: 25, risks: ["tornado"] });
    expect(result.source.coverage).toEqual({ alerts: "complete", forecasts: "not-requested" });
    expect(isCheckComplete(result.source)).toBe(true);
  });

  it("has no simulated mode: the old mock flag changes nothing and NWS is always consulted", async () => {
    vi.stubEnv("WEATHER_DEV_MOCK_MODE", "true");
    const { calls } = mockNetwork({});
    const result = await check({ radiusMiles: 25 });
    expect(result.source.live).toBe(true);
    expect(result.officialAlerts).toEqual([]);
    expect(result.detectedRisks).toEqual([]);
    expect(calls).toContain("/alerts/active");
    expect(calls.some((path) => path.startsWith("/gridpoints/"))).toBe(true);
  });

  it("marks the alert side incomplete when an alert in the region cannot be located", async () => {
    mockNetwork({
      alerts: [
        alertFeature({
          id: "unlocatable",
          geometry: null,
          affectedZones: ["https://api.weather.gov/zones/forecast/NYZ064"],
          geocode: { UGC: ["NYZ064"] },
        }),
      ],
      zones: () => {
        throw new TypeError("network down");
      },
    });
    const result = await check({ radiusMiles: 25 });
    expect(result.source.coverage.alerts).toBe("partial");
    expect(isCheckComplete(result.source)).toBe(false);
  });
});

describe("request plumbing", () => {
  it("limits how many tasks run at once", async () => {
    const limit = createLimiter(3);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        limit(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 2));
          running--;
        }),
      ),
    );
    expect(peak).toBe(3);
  });

  it("releases its slot when a task throws", async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(limit(async () => "ok")).resolves.toBe("ok");
  });

  it("de-duplicates concurrent loads and expires entries", async () => {
    const cache = new TtlCache<number>();
    const load = vi.fn(async () => 42);
    const values = await Promise.all([cache.getOrLoad("k", 1000, load), cache.getOrLoad("k", 1000, load)]);
    expect(values).toEqual([42, 42]);
    expect(load).toHaveBeenCalledTimes(1);

    cache.set("short", 1, 10, 1_000);
    expect(cache.get("short", 1_005)).toBe(1);
    expect(cache.get("short", 1_011)).toBeUndefined();
  });

  it("does not cache a failed load", async () => {
    const cache = new TtlCache<number>();
    await expect(cache.getOrLoad("k", 1000, async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    await expect(cache.getOrLoad("k", 1000, async () => 7)).resolves.toBe(7);
  });
});
