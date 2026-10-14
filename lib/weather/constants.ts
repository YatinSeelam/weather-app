import type {
  AlertRiskType,
  DetectedRiskType,
  EmailMode,
  MonitorInterval,
  RiskSelection,
  WeatherThresholds,
} from "./types";

export const RADIUS_OPTIONS = [25, 50, 100, 150] as const;
export const MIN_RADIUS_MILES = 5;
export const MAX_RADIUS_MILES = 200;

export const INTERVAL_OPTIONS: readonly MonitorInterval[] = [15, 60, 180];

export const DEFAULT_ZIP_CODE = "12477";
export const DEFAULT_RADIUS_MILES = 100;
export const DEFAULT_INTERVAL_MINUTES: MonitorInterval = 60;

export const EMAIL_MODE_OPTIONS: readonly EmailMode[] = ["every-check", "changes-only"];
export const DEFAULT_EMAIL_MODE: EmailMode = "every-check";
export const EMAIL_MODE_LABELS: Record<EmailMode, string> = {
  "every-check": "Every check",
  "changes-only": "Only changes",
};
/** Keeps a single Resend request well under its 50-recipient limit. */
export const MAX_MONITOR_EMAILS = 20;

export const RISK_SELECTION_LABELS: Record<RiskSelection, string> = {
  tornado: "Tornado",
  thunderstorm: "Severe thunderstorms",
  flood: "Flooding",
  wind: "High winds",
  "heavy-rain": "Heavy rain",
  freezing: "Freezing temperatures",
  winter: "Winter weather",
  other: "Other NWS alerts",
};

/** Which official alert types each user selection turns on. */
export const SELECTION_ALERT_TYPES: Record<RiskSelection, readonly AlertRiskType[]> = {
  tornado: ["tornado"],
  thunderstorm: ["thunderstorm"],
  flood: ["flood"],
  wind: ["wind"],
  "heavy-rain": [],
  freezing: ["freeze"],
  winter: ["winter", "ice"],
  other: ["other"],
};

/** Which system-detected risks each user selection turns on. */
export const SELECTION_DETECTED_TYPES: Record<RiskSelection, readonly DetectedRiskType[]> = {
  tornado: [],
  thunderstorm: [],
  flood: [],
  wind: ["high-wind"],
  "heavy-rain": ["heavy-rain"],
  freezing: ["freezing"],
  winter: [],
  other: [],
};

export const DEFAULT_THRESHOLDS: WeatherThresholds = {
  lookaheadHours: 12,

  freezingTemperatureF: 32,
  hardFreezeTemperatureF: 15,
  extremeColdTemperatureF: -5,
  dangerousApparentTemperatureF: 10,
  extremeApparentTemperatureF: -15,

  // 30 / 45 mph are the monitor's own trigger points; 40 / 58 mph match
  // NWS High Wind Warning criteria.
  dangerousSustainedWindMph: 30,
  dangerousWindGustMph: 45,
  highSustainedWindMph: 40,
  highWindGustMph: 58,
  extremeWindGustMph: 75,

  // NWS publishes rain totals in multi-hour buckets (usually 6 h), so the
  // threshold is expressed per 6 hours rather than as an hourly rate.
  heavyRainInchesPer6h: 1,
  veryHeavyRainInchesPer6h: 2,
  extremeRainInchesPer6h: 4,
};

/** Sample-location targets for system-detected risks, by radius. */
export const SAMPLE_POINT_TARGETS: ReadonlyArray<{ maxRadiusMiles: number; points: number }> = [
  { maxRadiusMiles: 25, points: 7 },
  { maxRadiusMiles: 50, points: 19 },
  { maxRadiusMiles: 100, points: 37 },
  { maxRadiusMiles: Infinity, points: 61 },
];

export const CACHE_TTL = {
  /** Official alerts: keep fresh. NWS itself caches this feed for only a few seconds. */
  activeAlertsMs: 60_000,
  /** Grid forecasts are reissued roughly hourly. */
  gridForecastMs: 10 * 60_000,
  /** Point -> forecast grid cell mapping is effectively static. */
  pointMetadataMs: 30 * 24 * 60 * 60_000,
  /** Zone boundaries change a few times a year at most. */
  zoneGeometryMs: 30 * 24 * 60 * 60_000,
  zipMs: 365 * 24 * 60 * 60_000,
} as const;

export const NWS_REQUEST = {
  maxConcurrent: 8,
  timeoutMs: 10_000,
  maxRetries: 2,
  /** Whole weather check gives up on outstanding requests after this long and returns what it has. */
  checkDeadlineMs: 25_000,
  maxRetryAfterMs: 5_000,
} as const;

export const CHECK_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

export const SCHEDULER_TICK_MS = 60_000;
