import bbox from "@turf/bbox";
import simplify from "@turf/simplify";
import type { BBox, Geometry } from "geojson";
import { z } from "zod";
import { PersistentCache, TtlCache } from "./cache";
import { createLimiter, singleton } from "./concurrency";
import { nwsBaseUrl, nwsUserAgent } from "./config";
import { CACHE_TTL, NWS_REQUEST } from "./constants";
import { isWeatherError, WeatherError } from "./errors";
import { polygonsOf, toMultiPolygon, type PolygonCoordinates } from "./geography";
import type { NwsAlertFeature } from "./nws-normalizer";
import type { PointForecast } from "./risk-engine";
import { parseValidTime, type TimeInterval } from "./time-series";
import { converterFor, type TargetUnit } from "./units";

export type RequestOptions = {
  /** Aborts outstanding work when the overall weather check runs out of time. */
  signal?: AbortSignal;
};

export type PointMetadata = {
  gridId: string;
  gridX: number;
  gridY: number;
  city?: string;
  state?: string;
  timeZone?: string;
};

export type ResolvedZone = {
  id: string;
  name?: string;
  polygons: PolygonCoordinates[];
  bbox: BBox;
};

// ---------------------------------------------------------------------------
// Transport: one shared concurrency limit, per-request timeout, bounded retries.
// ---------------------------------------------------------------------------

const limiter = () => singleton("nws-limiter", () => createLimiter(NWS_REQUEST.maxConcurrent));

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : 1000;
}

async function requestJson(url: string, options: RequestOptions): Promise<unknown> {
  let lastError = new WeatherError("NWS_UNAVAILABLE", "The National Weather Service did not respond.");

  for (let attempt = 0; attempt <= NWS_REQUEST.maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw new WeatherError("TIMEOUT", "The weather check ran out of time.");
    }
    if (attempt > 0) await delay(300 * attempt);

    try {
      const timeout = AbortSignal.timeout(NWS_REQUEST.timeoutMs);
      const response = await fetch(url, {
        headers: { "User-Agent": nwsUserAgent(), Accept: "application/geo+json" },
        cache: "no-store",
        signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
      });

      if (response.ok) return await response.json();

      if (response.status === 404) {
        throw new WeatherError("NOT_FOUND", `NWS has no data for ${url}.`);
      }
      if (response.status === 429) {
        const wait = retryAfterMs(response);
        lastError = new WeatherError("RATE_LIMITED", "The National Weather Service is rate limiting requests.", {
          retryAfterSeconds: Math.ceil(wait / 1000),
        });
        if (wait > NWS_REQUEST.maxRetryAfterMs) throw lastError;
        await delay(wait);
        continue;
      }
      if (response.status >= 500) {
        // NWS 5xx responses are frequently transient, so these are worth retrying.
        lastError = new WeatherError("NWS_UNAVAILABLE", `The National Weather Service returned ${response.status}.`);
        continue;
      }
      throw new WeatherError("NWS_UNAVAILABLE", `The National Weather Service rejected the request (${response.status}).`);
    } catch (error) {
      if (isWeatherError(error)) throw error;
      const name = error instanceof Error ? error.name : "";
      lastError =
        name === "TimeoutError" || name === "AbortError"
          ? new WeatherError("TIMEOUT", "The National Weather Service took too long to respond.", { cause: error })
          : new WeatherError("NETWORK", "Could not reach the National Weather Service.", { cause: error });
    }
  }
  throw lastError;
}

function nwsGet(pathOrUrl: string, options: RequestOptions = {}): Promise<unknown> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${nwsBaseUrl()}${pathOrUrl}`;
  return limiter()(() => requestJson(url, options));
}

// ---------------------------------------------------------------------------
// Response schemas. Only the fields this app reads; everything else is ignored.
// ---------------------------------------------------------------------------

function isGeometry(value: unknown): value is Geometry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  return typeof candidate.type === "string" && (Array.isArray(candidate.coordinates) || Array.isArray(candidate.geometries));
}

const geometrySchema = z.custom<Geometry>(isGeometry);
const optionalText = z.string().nullish();

const alertFeatureSchema = z.object({
  id: z.string().optional(),
  geometry: geometrySchema.nullish(),
  properties: z.object({
    id: z.string().optional(),
    event: z.string().min(1),
    areaDesc: optionalText,
    severity: optionalText,
    certainty: optionalText,
    urgency: optionalText,
    status: optionalText,
    messageType: optionalText,
    response: optionalText,
    headline: optionalText,
    description: optionalText,
    instruction: optionalText,
    effective: optionalText,
    onset: optionalText,
    expires: optionalText,
    ends: optionalText,
    senderName: optionalText,
    affectedZones: z.array(z.string()).nullish(),
    geocode: z.object({ UGC: z.array(z.string()).nullish() }).nullish(),
    references: z
      .array(z.object({ identifier: z.string().optional(), "@id": z.string().optional() }))
      .nullish(),
  }),
});

const featureCollectionSchema = z.object({ features: z.array(z.unknown()) });

const pointSchema = z.object({
  properties: z.object({
    gridId: z.string().min(1),
    gridX: z.number(),
    gridY: z.number(),
    timeZone: optionalText,
    relativeLocation: z
      .object({ properties: z.object({ city: optionalText, state: optionalText }) })
      .nullish(),
  }),
});

const seriesSchema = z
  .object({
    uom: optionalText,
    values: z.array(z.object({ validTime: z.string(), value: z.number().nullable() })),
  })
  .optional();

const gridpointSchema = z.object({
  properties: z.object({
    temperature: seriesSchema,
    apparentTemperature: seriesSchema,
    windSpeed: seriesSchema,
    windGust: seriesSchema,
    quantitativePrecipitation: seriesSchema,
  }),
});

const zoneSchema = z.object({
  geometry: geometrySchema.nullish(),
  properties: z.object({ id: z.string().min(1), name: optionalText }),
});

// ---------------------------------------------------------------------------
// Active alerts
// ---------------------------------------------------------------------------

export type ActiveAlertFeed = {
  features: NwsAlertFeature[];
  /** When this copy was fetched from NWS (it is reused for up to `CACHE_TTL.activeAlertsMs`). */
  fetchedAt: string;
};

const alertsCache = () => singleton("nws-alerts", () => new TtlCache<ActiveAlertFeed>(4));

/**
 * Every active alert in the country, in one request. One short-lived cached copy serves all
 * monitors and all radii, which is far cheaper than querying point by point — and it is the
 * only way to see alerts anywhere inside a radius rather than just at its center.
 */
export function fetchActiveAlerts(options: RequestOptions = {}): Promise<ActiveAlertFeed> {
  return alertsCache().getOrLoad("active", CACHE_TTL.activeAlertsMs, async () => {
    const body = featureCollectionSchema.safeParse(await nwsGet("/alerts/active?status=actual", options));
    if (!body.success) {
      throw new WeatherError("NWS_UNAVAILABLE", "The National Weather Service returned an unreadable alert feed.");
    }
    const features: NwsAlertFeature[] = [];
    for (const raw of body.data.features) {
      // One malformed alert must not hide all the others.
      const feature = alertFeatureSchema.safeParse(raw);
      if (feature.success) features.push(feature.data);
    }
    return { features, fetchedAt: new Date().toISOString() };
  });
}

// ---------------------------------------------------------------------------
// Point -> forecast grid cell
// ---------------------------------------------------------------------------

const pointCache = () =>
  singleton("nws-points", () => new PersistentCache<PointMetadata | null>("points", CACHE_TTL.pointMetadataMs));

/** Returns null when NWS has no forecast coverage for the location (offshore, outside the U.S.). */
export function fetchPointMetadata(
  latitude: number,
  longitude: number,
  options: RequestOptions = {},
): Promise<PointMetadata | null> {
  const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  return pointCache().getOrLoad(key, async () => {
    let raw: unknown;
    try {
      raw = await nwsGet(`/points/${key}`, options);
    } catch (error) {
      if (isWeatherError(error) && error.code === "NOT_FOUND") return null;
      throw error;
    }
    const parsed = pointSchema.safeParse(raw);
    if (!parsed.success) return null;
    const { gridId, gridX, gridY, timeZone, relativeLocation } = parsed.data.properties;
    return {
      gridId,
      gridX,
      gridY,
      timeZone: timeZone ?? undefined,
      city: relativeLocation?.properties.city ?? undefined,
      state: relativeLocation?.properties.state ?? undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Grid forecast
// ---------------------------------------------------------------------------

const FORECAST_HORIZON_MS = 72 * 60 * 60 * 1000;

function toSeries(raw: z.infer<typeof seriesSchema>, target: TargetUnit, now: number): TimeInterval[] {
  const convert = converterFor(raw?.uom, target);
  if (!raw || !convert) return [];
  const series: TimeInterval[] = [];
  for (const entry of raw.values) {
    if (entry.value === null) continue;
    const period = parseValidTime(entry.validTime);
    if (!period || period.end <= now || period.start > now + FORECAST_HORIZON_MS) continue;
    series.push({ ...period, value: convert(entry.value) });
  }
  return series;
}

const forecastCache = () => singleton("nws-forecasts", () => new TtlCache<PointForecast>(2000));

export const gridKey = (meta: Pick<PointMetadata, "gridId" | "gridX" | "gridY">) =>
  `${meta.gridId}:${meta.gridX},${meta.gridY}`;

/** Raw forecast grid data for one 2.5 km NWS grid cell, converted to °F / mph / inches. */
export function fetchGridForecast(
  meta: Pick<PointMetadata, "gridId" | "gridX" | "gridY">,
  options: RequestOptions = {},
  /** Periods that ended before this moment are dropped. Passed in so a check is reproducible. */
  now: number = Date.now(),
): Promise<PointForecast> {
  return forecastCache().getOrLoad(gridKey(meta), CACHE_TTL.gridForecastMs, async () => {
    const raw = await nwsGet(`/gridpoints/${encodeURIComponent(meta.gridId)}/${meta.gridX},${meta.gridY}`, options);
    const parsed = gridpointSchema.safeParse(raw);
    if (!parsed.success) {
      throw new WeatherError("NWS_UNAVAILABLE", "The National Weather Service returned an unreadable forecast.");
    }
    const p = parsed.data.properties;
    return {
      temperatureF: toSeries(p.temperature, "degF", now),
      apparentTemperatureF: toSeries(p.apparentTemperature, "degF", now),
      windSpeedMph: toSeries(p.windSpeed, "mph", now),
      windGustMph: toSeries(p.windGust, "mph", now),
      precipitationIn: toSeries(p.quantitativePrecipitation, "in", now),
    };
  });
}

// ---------------------------------------------------------------------------
// Zone boundaries (for alerts issued by zone/county without their own polygon)
// ---------------------------------------------------------------------------

const zoneCache = () =>
  singleton("nws-zones", () => new PersistentCache<ResolvedZone | null>("zones", CACHE_TTL.zoneGeometryMs));

const ZONE_PATH = /^\/zones\/([a-z]+)\/([A-Z0-9]+)$/;
/** About 200 m. Plenty for a radius measured in miles, and keeps coastlines small. */
const ZONE_SIMPLIFY_TOLERANCE_DEGREES = 0.002;

function simplifiedPolygons(geometry: Geometry): PolygonCoordinates[] {
  const polygons = polygonsOf(geometry);
  if (polygons.length === 0) return [];
  try {
    const simplified = simplify(toMultiPolygon(polygons), {
      tolerance: ZONE_SIMPLIFY_TOLERANCE_DEGREES,
      highQuality: false,
      mutate: false,
    });
    return simplified.coordinates;
  } catch {
    return polygons;
  }
}

/**
 * Resolves an `affectedZones` URL from an alert to that zone's boundary. Returns null when
 * the zone has no geometry. Only URLs on the configured NWS host are ever fetched.
 */
export function fetchZone(zoneUrl: string, options: RequestOptions = {}): Promise<ResolvedZone | null> {
  let url: URL;
  try {
    url = new URL(zoneUrl);
  } catch {
    return Promise.resolve(null);
  }
  const match = ZONE_PATH.exec(url.pathname);
  if (url.origin !== new URL(nwsBaseUrl()).origin || !match) return Promise.resolve(null);
  const [, type, id] = match;

  return zoneCache().getOrLoad(`${type}-${id}`, async () => {
    let raw: unknown;
    try {
      raw = await nwsGet(`/zones/${type}/${id}`, options);
    } catch (error) {
      if (isWeatherError(error) && error.code === "NOT_FOUND") return null;
      throw error;
    }
    const parsed = zoneSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.geometry) return null;
    const polygons = simplifiedPolygons(parsed.data.geometry);
    if (polygons.length === 0) return null;
    return {
      id: parsed.data.properties.id,
      name: parsed.data.properties.name ?? undefined,
      polygons,
      bbox: bbox(toMultiPolygon(polygons)),
    };
  });
}
