import type { Geometry } from "geojson";

/** Normalized severity scale shared by official alerts and detected risks, lowest first. */
export const SEVERITY_LEVELS = ["info", "low", "moderate", "high", "critical"] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/** What a user can choose to watch for. */
export const RISK_SELECTIONS = [
  "tornado",
  "thunderstorm",
  "flood",
  "wind",
  "heavy-rain",
  "freezing",
  "winter",
  "other",
] as const;
export type RiskSelection = (typeof RISK_SELECTIONS)[number];

export type AlertRiskType =
  | "tornado"
  | "thunderstorm"
  | "flood"
  | "wind"
  | "winter"
  | "freeze"
  | "ice"
  | "other";

export type DetectedRiskType = "freezing" | "high-wind" | "heavy-rain";

export type DetectedRiskSeverity = Exclude<SeverityLevel, "info">;

/** [longitude, latitude] */
export type LonLat = [number, number];

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type ZipCoordinates = Coordinates & {
  zip: string;
  city: string;
  state: string;
};

export type CheckCenter = Coordinates & {
  zipCode: string;
  city: string;
  state: string;
};

/**
 * Where an alert's map geometry came from:
 * - "nws-polygon": the alert itself carried a polygon (storm-based warnings).
 * - "nws-zones": the alert had no geometry; the shape is the union of its affected NWS zones.
 */
export type AlertGeometrySource = "nws-polygon" | "nws-zones";

export type WeatherAlert = {
  id: string;
  source: "NWS";
  category: "official-alert";
  event: string;
  headline: string;
  description?: string;
  instruction?: string;
  /** Raw NWS severity (Extreme, Severe, Moderate, Minor, Unknown). */
  severity?: string;
  /** Normalized severity, including event-based bumps (e.g. Tornado Warning). */
  level: SeverityLevel;
  certainty?: string;
  urgency?: string;
  status?: string;

  effective?: string;
  onset?: string;
  expires?: string;
  ends?: string;

  areaDescription?: string;
  senderName?: string;

  geometry?: Geometry | null;
  geometrySource: AlertGeometrySource;
  /** A point inside the alert area closest to the center, for markers and popups. */
  anchor: LonLat | null;

  /** Distance from the center to the nearest edge of the alert area. 0 when the center is inside it. */
  distanceMiles?: number | null;

  riskType: AlertRiskType;
  rawEvent: string;
  /** Identifiers of earlier alerts this one updates or replaces. */
  references: string[];
};

export type DetectedWeatherRisk = {
  id: string;
  category: "detected-risk";
  riskType: DetectedRiskType;
  severity: DetectedRiskSeverity;

  title: string;
  description: string;

  latitude: number;
  longitude: number;
  locationLabel?: string;

  observedValue?: number;
  threshold?: number;
  unit?: string;

  distanceMiles: number;

  detectedAt: string;
  validUntil?: string;

  source: string;
};

export type SamplingReport = {
  requestedPoints: number;
  successfulPoints: number;
  /** Requests that failed (outage, timeout). These make the check incomplete. */
  failedPoints: number;
  /** Locations NWS does not forecast for (offshore, outside the U.S.). Expected, not a failure. */
  outsideCoveragePoints: number;
};

/** Which part of the live data a failure belongs to. */
export type WeatherDataPortion = "alerts" | "forecasts" | "geocoding";

/**
 * How much of a data set the check actually saw. Anything other than "complete" (or
 * "not-requested") means an empty result must NOT be read as "all clear".
 */
export type CoverageStatus = "complete" | "partial" | "unavailable" | "not-requested";

/** Where the data in a check came from. Every check is live; there is no simulated mode. */
export type WeatherDataSource = {
  live: true;
  providers: {
    alerts: string;
    forecasts: string;
    geocoding: string;
    map: string;
  };
  /** Hosts the server actually called, for verification. */
  hosts: { nws: string; geocoding: string };
  checkedAt: string;
  /** When the copy of the NWS alert feed used for this check was fetched. Null if alerts were not requested. */
  fetchedAt: string | null;
  /** Total active alerts NWS returned nationwide, before radius filtering. */
  nwsAlertsReceived: number | null;
  coverage: { alerts: CoverageStatus; forecasts: CoverageStatus };
};

export type WeatherCheckSummary = {
  /** Official alerts plus distinct detected risk types. */
  totalActiveRisks: number;
  officialAlertCount: number;
  detectedRiskTypeCount: number;
  /** Alert areas plus distinct sampled locations with a detected risk. */
  affectedLocations: number;
  highestSeverity: SeverityLevel | null;
};

export type WeatherCheckResult = {
  center: CheckCenter;
  radiusMiles: number;
  risks: RiskSelection[];
  checkedAt: string;
  officialAlerts: WeatherAlert[];
  detectedRisks: DetectedWeatherRisk[];
  sampling: SamplingReport;
  summary: WeatherCheckSummary;
  /** Problems that make the result incomplete. */
  warnings: string[];
  /** Informational notes that do not affect completeness. */
  notes: string[];
  source: WeatherDataSource;
};

export type WeatherThresholds = {
  /** Detected risks look at the NWS forecast grid from now through this many hours ahead. */
  lookaheadHours: number;

  freezingTemperatureF: number;
  hardFreezeTemperatureF: number;
  extremeColdTemperatureF: number;
  dangerousApparentTemperatureF: number;
  extremeApparentTemperatureF: number;

  dangerousSustainedWindMph: number;
  dangerousWindGustMph: number;
  highSustainedWindMph: number;
  highWindGustMph: number;
  extremeWindGustMph: number;

  heavyRainInchesPer6h: number;
  veryHeavyRainInchesPer6h: number;
  extremeRainInchesPer6h: number;
};

export type MonitorInterval = 15 | 60 | 180;

/**
 * When a monitor emails its recipients.
 * - every-check: one email per scheduled run, whatever changed (the "update every 15 minutes" mode).
 * - changes-only: only when a risk is NEW, ESCALATED or UPDATED.
 */
export type EmailMode = "every-check" | "changes-only";
