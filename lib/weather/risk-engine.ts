import { severityRank } from "./severity";
import { intervalsOverlapping, type TimeInterval } from "./time-series";
import type { DetectedRiskSeverity, DetectedRiskType, DetectedWeatherRisk, WeatherThresholds } from "./types";

/** Forecast series for one NWS grid cell, already converted to °F, mph and inches. */
export type PointForecast = {
  temperatureF: TimeInterval[];
  apparentTemperatureF: TimeInterval[];
  windSpeedMph: TimeInterval[];
  windGustMph: TimeInterval[];
  precipitationIn: TimeInterval[];
};

export type WindowConditions = {
  windowStart: number;
  windowEnd: number;
  minTemperatureF: TimeInterval | null;
  minApparentTemperatureF: TimeInterval | null;
  maxWindSpeedMph: TimeInterval | null;
  maxWindGustMph: TimeInterval | null;
  /** The wettest forecast period overlapping the window, exactly as NWS bucketed it. */
  maxPrecipitation: (TimeInterval & { periodHours: number; inchesPer6h: number }) | null;
};

export type SampleContext = {
  latitude: number;
  longitude: number;
  distanceMiles: number;
  locationLabel?: string;
  /** Stable identifier of the forecast grid cell, e.g. "ALY:69,36". */
  gridKey: string;
};

const HOUR_MS = 60 * 60 * 1000;

function extreme(series: TimeInterval[], pick: "min" | "max"): TimeInterval | null {
  let best: TimeInterval | null = null;
  for (const interval of series) {
    if (!best || (pick === "min" ? interval.value < best.value : interval.value > best.value)) best = interval;
  }
  return best;
}

/** Reduces a point forecast to the worst values between now and `lookaheadHours` from now. */
export function summarizeWindow(forecast: PointForecast, nowMs: number, lookaheadHours: number): WindowConditions {
  const windowEnd = nowMs + lookaheadHours * HOUR_MS;
  const inWindow = (series: TimeInterval[]) => intervalsOverlapping(series, nowMs, windowEnd);

  const wettest = extreme(
    inWindow(forecast.precipitationIn).map((interval) => {
      const periodHours = (interval.end - interval.start) / HOUR_MS;
      // Totals for periods longer than 6 h are scaled down to a 6 h equivalent; shorter
      // periods are compared as-is, since that much rain in less time is at least as heavy.
      const inchesPer6h = periodHours > 6 ? (interval.value * 6) / periodHours : interval.value;
      return { ...interval, value: inchesPer6h };
    }),
    "max",
  );
  const wettestRaw = wettest
    ? forecast.precipitationIn.find((i) => i.start === wettest.start && i.end === wettest.end)
    : undefined;

  return {
    windowStart: nowMs,
    windowEnd,
    minTemperatureF: extreme(inWindow(forecast.temperatureF), "min"),
    minApparentTemperatureF: extreme(inWindow(forecast.apparentTemperatureF), "min"),
    maxWindSpeedMph: extreme(inWindow(forecast.windSpeedMph), "max"),
    maxWindGustMph: extreme(inWindow(forecast.windGustMph), "max"),
    maxPrecipitation:
      wettest && wettestRaw
        ? {
            ...wettestRaw,
            periodHours: (wettestRaw.end - wettestRaw.start) / HOUR_MS,
            inchesPer6h: wettest.value,
          }
        : null,
  };
}

export function hasAnyConditions(conditions: WindowConditions): boolean {
  return Boolean(
    conditions.minTemperatureF ||
      conditions.minApparentTemperatureF ||
      conditions.maxWindSpeedMph ||
      conditions.maxWindGustMph ||
      conditions.maxPrecipitation,
  );
}

const worse = (a: DetectedRiskSeverity | null, b: DetectedRiskSeverity | null): DetectedRiskSeverity | null => {
  if (!a) return b;
  if (!b) return a;
  return severityRank(a) >= severityRank(b) ? a : b;
};

export function classifyTemperature(
  temperatureF: number | null,
  thresholds: WeatherThresholds,
): DetectedRiskSeverity | null {
  if (temperatureF === null) return null;
  if (temperatureF <= thresholds.extremeColdTemperatureF) return "critical";
  if (temperatureF <= thresholds.hardFreezeTemperatureF) return "high";
  if (temperatureF <= thresholds.freezingTemperatureF) return "moderate";
  return null;
}

export function classifyApparentTemperature(
  apparentF: number | null,
  thresholds: WeatherThresholds,
): DetectedRiskSeverity | null {
  if (apparentF === null) return null;
  if (apparentF <= thresholds.extremeApparentTemperatureF) return "critical";
  if (apparentF <= thresholds.dangerousApparentTemperatureF) return "high";
  return null;
}

export function classifyWind(
  sustainedMph: number | null,
  gustMph: number | null,
  thresholds: WeatherThresholds,
): DetectedRiskSeverity | null {
  const sustained = sustainedMph ?? -Infinity;
  const gust = gustMph ?? -Infinity;
  if (gust >= thresholds.extremeWindGustMph) return "critical";
  if (sustained >= thresholds.highSustainedWindMph || gust >= thresholds.highWindGustMph) return "high";
  if (sustained >= thresholds.dangerousSustainedWindMph || gust >= thresholds.dangerousWindGustMph) return "moderate";
  return null;
}

export function classifyRain(inchesPer6h: number | null, thresholds: WeatherThresholds): DetectedRiskSeverity | null {
  if (inchesPer6h === null) return null;
  if (inchesPer6h >= thresholds.extremeRainInchesPer6h) return "critical";
  if (inchesPer6h >= thresholds.veryHeavyRainInchesPer6h) return "high";
  if (inchesPer6h >= thresholds.heavyRainInchesPer6h) return "moderate";
  return null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const hoursLabel = (hours: number) => `${Number(hours.toFixed(1))} hour${hours === 1 ? "" : "s"}`;

/** Applies the configured thresholds to one sampled location. */
export function evaluateRisks(
  sample: SampleContext,
  conditions: WindowConditions,
  thresholds: WeatherThresholds,
  enabled: ReadonlySet<DetectedRiskType>,
  now: Date,
): DetectedWeatherRisk[] {
  const risks: DetectedWeatherRisk[] = [];
  const window = `the next ${hoursLabel(thresholds.lookaheadHours)}`;
  const base = {
    category: "detected-risk" as const,
    latitude: sample.latitude,
    longitude: sample.longitude,
    locationLabel: sample.locationLabel,
    distanceMiles: sample.distanceMiles,
    detectedAt: now.toISOString(),
    source: `NWS forecast grid ${sample.gridKey}`,
  };

  if (enabled.has("freezing")) {
    const temperature = conditions.minTemperatureF;
    const apparent = conditions.minApparentTemperatureF;
    const byTemperature = classifyTemperature(temperature?.value ?? null, thresholds);
    const byApparent = classifyApparentTemperature(apparent?.value ?? null, thresholds);
    const severity = worse(byTemperature, byApparent);
    if (severity) {
      const low = temperature ? Math.round(temperature.value) : null;
      const feels = apparent ? Math.round(apparent.value) : null;
      const showFeels = feels !== null && (low === null || feels < low);
      // Lead with whichever reading actually crossed its threshold.
      const ledByTemperature = byTemperature !== null && temperature !== null;
      const lead = ledByTemperature ? temperature : (apparent ?? temperature);
      const parts = [
        low !== null ? `Low of ${low}°F` : null,
        showFeels ? `feels like ${feels}°F` : null,
      ].filter(Boolean);
      risks.push({
        ...base,
        id: `freezing:${sample.gridKey}`,
        riskType: "freezing",
        severity,
        title: ledByTemperature ? "Freezing temperatures" : "Dangerous cold",
        description: `${parts.join(", ")} in ${window}.`,
        observedValue: ledByTemperature ? (low ?? undefined) : (feels ?? undefined),
        threshold: ledByTemperature ? thresholds.freezingTemperatureF : thresholds.dangerousApparentTemperatureF,
        unit: "°F",
        validUntil: lead ? iso(lead.end) : undefined,
      });
    }
  }

  if (enabled.has("high-wind")) {
    const sustained = conditions.maxWindSpeedMph;
    const gust = conditions.maxWindGustMph;
    const severity = classifyWind(sustained?.value ?? null, gust?.value ?? null, thresholds);
    if (severity) {
      const gustMph = gust ? Math.round(gust.value) : null;
      const sustainedMph = sustained ? Math.round(sustained.value) : null;
      const gustTriggered = gust !== null && gust.value >= thresholds.dangerousWindGustMph;
      const parts = [
        gustMph !== null ? `Gusts up to ${gustMph} mph` : null,
        sustainedMph !== null ? `${gustMph !== null ? "sustained" : "Sustained"} wind up to ${sustainedMph} mph` : null,
      ].filter(Boolean);
      const lead = gustTriggered ? gust : sustained;
      risks.push({
        ...base,
        id: `high-wind:${sample.gridKey}`,
        riskType: "high-wind",
        severity,
        title: "High wind",
        description: `${parts.join(", ")} in ${window}.`,
        observedValue: (gustTriggered ? gustMph : sustainedMph) ?? undefined,
        threshold: gustTriggered ? thresholds.dangerousWindGustMph : thresholds.dangerousSustainedWindMph,
        unit: "mph",
        validUntil: lead ? iso(lead.end) : undefined,
      });
    }
  }

  if (enabled.has("heavy-rain")) {
    const rain = conditions.maxPrecipitation;
    const severity = classifyRain(rain?.inchesPer6h ?? null, thresholds);
    if (rain && severity) {
      const inches = Math.round(rain.value * 100) / 100;
      risks.push({
        ...base,
        id: `heavy-rain:${sample.gridKey}`,
        riskType: "heavy-rain",
        severity,
        title: "Heavy rain",
        description: `${inches} in of rain forecast over ${hoursLabel(rain.periodHours)}.`,
        observedValue: inches,
        threshold: thresholds.heavyRainInchesPer6h,
        unit: "in",
        validUntil: iso(rain.end),
      });
    }
  }

  return risks;
}
