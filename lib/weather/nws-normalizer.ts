import type { Geometry } from "geojson";
import { maxSeverity } from "./severity";
import type { AlertRiskType, SeverityLevel } from "./types";

/** The subset of an NWS alert feature this app reads, after validation. */
export type NwsAlertFeature = {
  id?: string;
  geometry?: Geometry | null;
  properties: {
    id?: string;
    event: string;
    areaDesc?: string | null;
    severity?: string | null;
    certainty?: string | null;
    urgency?: string | null;
    status?: string | null;
    messageType?: string | null;
    response?: string | null;
    headline?: string | null;
    description?: string | null;
    instruction?: string | null;
    effective?: string | null;
    onset?: string | null;
    expires?: string | null;
    ends?: string | null;
    senderName?: string | null;
    affectedZones?: string[] | null;
    geocode?: { UGC?: string[] | null } | null;
    references?: Array<{ identifier?: string; "@id"?: string }> | null;
  };
};

/** First matching rule wins, so more specific event names come first. */
const EVENT_RULES: ReadonlyArray<[RegExp, AlertRiskType]> = [
  [/tornado/i, "tornado"],
  [/thunderstorm/i, "thunderstorm"],
  [/dust|ashfall|smoke|fire|red flag|heat|fog|surf|rip current|small craft|seas|marine|tsunami|air quality/i, "other"],
  [/flood|storm surge|hydrologic/i, "flood"],
  [/ice storm|freezing rain|freezing drizzle|freezing fog|freezing spray|\bice\b/i, "ice"],
  [/freeze|frost|wind chill|extreme cold|cold weather/i, "freeze"],
  [/blizzard|winter|snow|sleet|lake effect|avalanche/i, "winter"],
  [/wind|gale|hurricane|typhoon|tropical|storm warning|storm watch/i, "wind"],
];

/** Maps any NWS event name ("Flash Flood Warning", "Frost Advisory", ...) to a risk type. */
export function classifyNwsEvent(event: string): AlertRiskType {
  for (const [pattern, riskType] of EVENT_RULES) {
    if (pattern.test(event)) return riskType;
  }
  return "other";
}

const NWS_SEVERITY: Record<string, SeverityLevel> = {
  extreme: "critical",
  severe: "high",
  moderate: "moderate",
  minor: "low",
  unknown: "info",
};

export function normalizeNwsSeverity(severity: string | null | undefined): SeverityLevel {
  return NWS_SEVERITY[(severity ?? "").trim().toLowerCase()] ?? "info";
}

/**
 * Life-threatening event types are never shown below these levels, whatever severity the
 * individual message was tagged with.
 */
const EVENT_MINIMUM_LEVEL: ReadonlyArray<[RegExp, SeverityLevel]> = [
  [/tornado warning|hurricane warning|typhoon warning|extreme wind warning|tsunami warning/i, "critical"],
  [
    /tornado watch|flash flood warning|severe thunderstorm warning|storm surge warning|blizzard warning|ice storm warning|hurricane force wind warning/i,
    "high",
  ],
];

export function alertLevel(event: string, severity: string | null | undefined): SeverityLevel {
  const base = normalizeNwsSeverity(severity);
  const minimum = EVENT_MINIMUM_LEVEL.find(([pattern]) => pattern.test(event))?.[1];
  return minimum ? maxSeverity(base, minimum) : base;
}

/**
 * The active feed still lists cancellations and messages past their end time for a short
 * while. Only real, current alerts count.
 */
export function isAlertActive(properties: NwsAlertFeature["properties"], now: Date): boolean {
  if (properties.status && properties.status !== "Actual") return false;
  if (properties.messageType === "Cancel") return false;
  if (properties.response === "AllClear") return false;
  const endText = properties.ends ?? properties.expires;
  if (endText) {
    const end = Date.parse(endText);
    if (!Number.isNaN(end) && end <= now.getTime()) return false;
  }
  return true;
}

export function alertIdentifier(feature: NwsAlertFeature): string | null {
  return feature.properties.id ?? feature.id ?? null;
}

export function alertReferences(feature: NwsAlertFeature): string[] {
  return (feature.properties.references ?? [])
    .map((reference) => reference.identifier ?? reference["@id"])
    .filter((value): value is string => Boolean(value));
}

const text = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** Everything about a normalized alert that does not depend on where the user is looking. */
export function normalizeAlertProperties(feature: NwsAlertFeature) {
  const p = feature.properties;
  const event = p.event.trim();
  return {
    source: "NWS" as const,
    category: "official-alert" as const,
    event,
    rawEvent: p.event,
    headline: text(p.headline) ?? event,
    description: text(p.description),
    instruction: text(p.instruction),
    severity: text(p.severity),
    level: alertLevel(event, p.severity),
    certainty: text(p.certainty),
    urgency: text(p.urgency),
    status: text(p.status),
    effective: text(p.effective),
    onset: text(p.onset),
    expires: text(p.expires),
    ends: text(p.ends),
    areaDescription: text(p.areaDesc),
    senderName: text(p.senderName),
    riskType: classifyNwsEvent(event),
    references: alertReferences(feature),
  };
}
