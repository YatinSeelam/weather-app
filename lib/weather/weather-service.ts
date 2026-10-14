import { locateAlertsInRadius } from "./alert-locator";
import { dataProviders } from "./config";
import { DEFAULT_THRESHOLDS, NWS_REQUEST, SELECTION_ALERT_TYPES, SELECTION_DETECTED_TYPES } from "./constants";
import { isWeatherError, WeatherError } from "./errors";
import { getCoordinatesForZip } from "./geocoder";
import { fetchActiveAlerts, fetchGridForecast, fetchPointMetadata, fetchZone, gridKey, type RequestOptions } from "./nws-client";
import { evaluateRisks, hasAnyConditions, summarizeWindow } from "./risk-engine";
import { generateSamplePoints, type SamplePoint } from "./sampling";
import { highestSeverity, severityRank } from "./severity";
import type {
  AlertRiskType,
  CheckCenter,
  CoverageStatus,
  DetectedRiskType,
  DetectedWeatherRisk,
  RiskSelection,
  SamplingReport,
  WeatherAlert,
  WeatherCheckResult,
  WeatherCheckSummary,
  WeatherThresholds,
} from "./types";

export type CheckWeatherInput = {
  zipCode: string;
  radiusMiles: number;
  risks: RiskSelection[];
  thresholds?: Partial<WeatherThresholds>;
};

export function selectedAlertTypes(risks: readonly RiskSelection[]): Set<AlertRiskType> {
  return new Set(risks.flatMap((risk) => SELECTION_ALERT_TYPES[risk]));
}

export function selectedDetectedTypes(risks: readonly RiskSelection[]): Set<DetectedRiskType> {
  return new Set(risks.flatMap((risk) => SELECTION_DETECTED_TYPES[risk]));
}

const byDistance = (a: number | null | undefined, b: number | null | undefined) =>
  (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY);

export function sortAlerts(alerts: WeatherAlert[]): WeatherAlert[] {
  return [...alerts].sort(
    (a, b) => severityRank(b.level) - severityRank(a.level) || byDistance(a.distanceMiles, b.distanceMiles),
  );
}

export function sortDetectedRisks(risks: DetectedWeatherRisk[]): DetectedWeatherRisk[] {
  return [...risks].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || byDistance(a.distanceMiles, b.distanceMiles),
  );
}

export function summarize(alerts: WeatherAlert[], risks: DetectedWeatherRisk[]): WeatherCheckSummary {
  const detectedTypes = new Set(risks.map((risk) => risk.riskType));
  const detectedLocations = new Set(risks.map((risk) => `${risk.latitude},${risk.longitude}`));
  return {
    totalActiveRisks: alerts.length + detectedTypes.size,
    officialAlertCount: alerts.length,
    detectedRiskTypeCount: detectedTypes.size,
    affectedLocations: alerts.length + detectedLocations.size,
    highestSeverity: highestSeverity([...alerts.map((a) => a.level), ...risks.map((r) => r.severity)]),
  };
}

type AlertOutcome = {
  alerts: WeatherAlert[];
  warnings: string[];
  coverage: CoverageStatus;
  /** Active alerts NWS returned nationwide. */
  received: number | null;
  /** Alerts whose area intersects the radius, before the user's risk-type filter. */
  inRadius: number;
  fetchedAt: string | null;
};

async function findOfficialAlerts(
  center: CheckCenter,
  radiusMiles: number,
  wanted: Set<AlertRiskType>,
  now: Date,
  options: RequestOptions,
): Promise<AlertOutcome> {
  if (wanted.size === 0) {
    return { alerts: [], warnings: [], coverage: "not-requested", received: null, inRadius: 0, fetchedAt: null };
  }

  // If the alert feed itself is unreachable the whole check fails loudly. An API failure
  // must never be reported as "no alerts".
  let feed: Awaited<ReturnType<typeof fetchActiveAlerts>>;
  try {
    feed = await fetchActiveAlerts(options);
  } catch (error) {
    const reason = isWeatherError(error) ? error : null;
    throw new WeatherError(
      reason?.code ?? "NWS_UNAVAILABLE",
      `Unable to retrieve live NWS alerts. ${reason?.message ?? ""}`.trim(),
      { source: "alerts", retryAfterSeconds: reason?.retryAfterSeconds, cause: error },
    );
  }

  const { alerts, unresolvedCount } = await locateAlertsInRadius(feed.features, center, radiusMiles, now, (zoneUrl) =>
    fetchZone(zoneUrl, options),
  );

  const warnings =
    unresolvedCount > 0
      ? [
          `${unresolvedCount} active alert${unresolvedCount === 1 ? "" : "s"} in the region could not be placed on the map because zone boundaries were unavailable, and ${unresolvedCount === 1 ? "is" : "are"} not shown.`,
        ]
      : [];
  return {
    alerts: alerts.filter((alert) => wanted.has(alert.riskType)),
    warnings,
    coverage: unresolvedCount > 0 ? "partial" : "complete",
    received: feed.features.length,
    inRadius: alerts.length,
    fetchedAt: feed.fetchedAt,
  };
}

type SamplingOutcome = {
  risks: DetectedWeatherRisk[];
  sampling: SamplingReport;
  warnings: string[];
  notes: string[];
  coverage: CoverageStatus;
};

/** Returns null when NWS has no forecast coverage for the point (offshore, outside the U.S.). */
async function evaluateSamplePoint(
  point: SamplePoint,
  wanted: Set<DetectedRiskType>,
  thresholds: WeatherThresholds,
  now: Date,
  options: RequestOptions,
): Promise<DetectedWeatherRisk[] | null> {
  const meta = await fetchPointMetadata(point.latitude, point.longitude, options);
  if (!meta) return null;

  const forecast = await fetchGridForecast(meta, options, now.getTime());
  const conditions = summarizeWindow(forecast, now.getTime(), thresholds.lookaheadHours);
  if (!hasAnyConditions(conditions)) throw new Error("The NWS forecast grid had no usable data for this location.");

  const locationLabel = meta.city ? `Near ${meta.city}${meta.state ? `, ${meta.state}` : ""}` : undefined;
  return evaluateRisks(
    {
      latitude: point.latitude,
      longitude: point.longitude,
      distanceMiles: Math.round(point.distanceMiles * 10) / 10,
      locationLabel,
      gridKey: gridKey(meta),
    },
    conditions,
    thresholds,
    wanted,
    now,
  );
}

const NOT_EVALUATED = "so temperature, wind and rain risks were not evaluated";

async function detectRisksAcrossRadius(
  center: CheckCenter,
  radiusMiles: number,
  wanted: Set<DetectedRiskType>,
  thresholds: WeatherThresholds,
  now: Date,
  options: RequestOptions,
): Promise<SamplingOutcome> {
  if (wanted.size === 0) {
    return {
      risks: [],
      sampling: { requestedPoints: 0, successfulPoints: 0, failedPoints: 0, outsideCoveragePoints: 0 },
      warnings: [],
      notes: [],
      coverage: "not-requested",
    };
  }

  const points = generateSamplePoints(center, radiusMiles);
  // Concurrency is bounded inside the NWS client; allSettled keeps one bad point from failing the check.
  const settled = await Promise.allSettled(
    points.map((point) => evaluateSamplePoint(point, wanted, thresholds, now, options)),
  );

  const byId = new Map<string, DetectedWeatherRisk>();
  let failedPoints = 0;
  let outsideCoveragePoints = 0;
  for (const result of settled) {
    if (result.status === "rejected") {
      failedPoints++;
      continue;
    }
    if (result.value === null) {
      outsideCoveragePoints++;
      continue;
    }
    for (const risk of result.value) {
      // Two sample points can land in the same forecast cell; keep the nearer one.
      const existing = byId.get(risk.id);
      if (!existing || risk.distanceMiles < existing.distanceMiles) byId.set(risk.id, risk);
    }
  }

  const total = points.length;
  const successfulPoints = total - failedPoints - outsideCoveragePoints;
  const warnings: string[] = [];
  const notes: string[] = [];
  let coverage: CoverageStatus = "complete";

  if (successfulPoints === 0) {
    coverage = "unavailable";
    warnings.push(
      failedPoints > 0
        ? `Unable to retrieve live NWS forecast data for any of the ${total} sample locations, ${NOT_EVALUATED}.`
        : `None of the ${total} sample locations are inside NWS forecast coverage, ${NOT_EVALUATED}.`,
    );
  } else {
    if (failedPoints > 0) {
      coverage = "partial";
      warnings.push(`Weather data was unavailable for ${failedPoints} of ${total} sample locations.`);
    }
    if (outsideCoveragePoints > 0) {
      notes.push(
        `${outsideCoveragePoints} of ${total} sample locations are outside NWS forecast coverage (offshore or outside the U.S.) and were skipped.`,
      );
    }
  }

  return {
    risks: [...byId.values()],
    sampling: { requestedPoints: total, successfulPoints, failedPoints, outsideCoveragePoints },
    warnings,
    notes,
    coverage,
  };
}

/** Development-only trace proving what the live sources returned for a check. */
function logLiveCheck(result: WeatherCheckResult, alertsInRadius: number, elapsedMs: number): void {
  if (process.env.NODE_ENV !== "development") return;
  const { center, sampling, source } = result;
  console.info(
    [
      "LIVE WEATHER CHECK",
      `ZIP: ${center.zipCode} (${center.city}, ${center.state}) -> ${center.latitude}, ${center.longitude} via ${source.hosts.geocoding}`,
      `Radius: ${result.radiusMiles} mi`,
      `NWS alerts received: ${source.nwsAlertsReceived ?? "not requested"} from ${source.hosts.nws} (fetched ${source.fetchedAt ?? "n/a"})`,
      `Alerts intersecting radius: ${alertsInRadius} (${result.officialAlerts.length} match selected risks)`,
      `Forecast sample locations: ${sampling.requestedPoints}`,
      `Successful samples: ${sampling.successfulPoints}`,
      `Failed samples: ${sampling.failedPoints}`,
      `Outside NWS coverage: ${sampling.outsideCoveragePoints}`,
      `Detected risks: ${result.detectedRisks.length}`,
      `Elapsed: ${elapsedMs} ms`,
    ].join("\n  "),
  );
}

/**
 * The full radius check: resolve the ZIP, find official NWS alerts whose area intersects the
 * radius, and evaluate temperature / wind / rain thresholds at sample locations across it.
 * Every value comes from a live source; there is no simulated or fallback weather.
 */
export async function checkWeather(input: CheckWeatherInput, now: Date = new Date()): Promise<WeatherCheckResult> {
  const startedAt = Date.now();
  const location = await getCoordinatesForZip(input.zipCode);
  const center: CheckCenter = {
    zipCode: location.zip,
    city: location.city,
    state: location.state,
    latitude: location.latitude,
    longitude: location.longitude,
  };
  const risks = [...new Set(input.risks)];
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };

  const options: RequestOptions = { signal: AbortSignal.timeout(NWS_REQUEST.checkDeadlineMs) };
  const [alertOutcome, samplingOutcome] = await Promise.all([
    findOfficialAlerts(center, input.radiusMiles, selectedAlertTypes(risks), now, options),
    detectRisksAcrossRadius(center, input.radiusMiles, selectedDetectedTypes(risks), thresholds, now, options),
  ]);

  const officialAlerts = sortAlerts(alertOutcome.alerts);
  const detectedRisks = sortDetectedRisks(samplingOutcome.risks);

  const result: WeatherCheckResult = {
    center,
    radiusMiles: input.radiusMiles,
    risks,
    checkedAt: now.toISOString(),
    officialAlerts,
    detectedRisks,
    sampling: samplingOutcome.sampling,
    summary: summarize(officialAlerts, detectedRisks),
    warnings: [...alertOutcome.warnings, ...samplingOutcome.warnings],
    notes: samplingOutcome.notes,
    source: {
      live: true,
      ...dataProviders(),
      checkedAt: now.toISOString(),
      fetchedAt: alertOutcome.fetchedAt,
      nwsAlertsReceived: alertOutcome.received,
      coverage: { alerts: alertOutcome.coverage, forecasts: samplingOutcome.coverage },
    },
  };

  logLiveCheck(result, alertOutcome.inRadius, Date.now() - startedAt);
  return result;
}
