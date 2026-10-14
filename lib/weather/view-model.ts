import bbox from "@turf/bbox";
import type { BBox } from "geojson";
import { formatAlertDistance, formatPointDistance, formatUntil } from "./format";
import { highestSeverity, severityRank } from "./severity";
import type {
  DetectedRiskType,
  DetectedWeatherRisk,
  LonLat,
  SeverityLevel,
  WeatherAlert,
  WeatherCheckResult,
} from "./types";

/** What the results list shows: one row per official alert, one row per detected risk type. */
export type AlertItem = { kind: "alert"; id: string; level: SeverityLevel; alert: WeatherAlert };
export type DetectedGroupItem = {
  kind: "detected";
  id: string;
  level: SeverityLevel;
  riskType: DetectedRiskType;
  title: string;
  /** Worst first. */
  risks: DetectedWeatherRisk[];
};
export type RiskItem = AlertItem | DetectedGroupItem;

export type SourceFilter = "all" | "official" | "detected";
export type TypeFilter = "all" | "tornado" | "storm" | "flood" | "wind" | "winter" | "temperature" | "other";

export const TYPE_FILTER_LABELS: Record<TypeFilter, string> = {
  all: "Any type",
  tornado: "Tornado",
  storm: "Thunderstorm",
  flood: "Flood and rain",
  wind: "Wind",
  winter: "Winter",
  temperature: "Temperature",
  other: "Other",
};

export const DETECTED_TITLES: Record<DetectedRiskType, string> = {
  freezing: "Freezing temperatures",
  "high-wind": "High wind",
  "heavy-rain": "Heavy rain",
};

export function buildRiskItems(result: Pick<WeatherCheckResult, "officialAlerts" | "detectedRisks">): RiskItem[] {
  const groups = new Map<DetectedRiskType, DetectedWeatherRisk[]>();
  for (const risk of result.detectedRisks) {
    groups.set(risk.riskType, [...(groups.get(risk.riskType) ?? []), risk]);
  }

  const items: RiskItem[] = [
    ...result.officialAlerts.map((alert): AlertItem => ({ kind: "alert", id: alert.id, level: alert.level, alert })),
    ...[...groups.entries()].map(
      ([riskType, risks]): DetectedGroupItem => ({
        kind: "detected",
        id: `group:${riskType}`,
        level: highestSeverity(risks.map((risk) => risk.severity)) ?? "low",
        riskType,
        title: DETECTED_TITLES[riskType],
        risks,
      }),
    ),
  ];

  const distanceOf = (item: RiskItem) =>
    item.kind === "alert" ? (item.alert.distanceMiles ?? Number.POSITIVE_INFINITY) : item.risks[0].distanceMiles;
  return items.sort((a, b) => severityRank(b.level) - severityRank(a.level) || distanceOf(a) - distanceOf(b));
}

export function typeFilterOf(item: RiskItem): TypeFilter {
  if (item.kind === "detected") {
    return item.riskType === "freezing" ? "temperature" : item.riskType === "high-wind" ? "wind" : "flood";
  }
  switch (item.alert.riskType) {
    case "tornado":
      return "tornado";
    case "thunderstorm":
      return "storm";
    case "flood":
      return "flood";
    case "wind":
      return "wind";
    case "winter":
    case "ice":
      return "winter";
    case "freeze":
      return "temperature";
    default:
      return "other";
  }
}

export function filterItems(items: RiskItem[], source: SourceFilter, type: TypeFilter): RiskItem[] {
  return items.filter(
    (item) =>
      (source === "all" || (source === "official") === (item.kind === "alert")) &&
      (type === "all" || typeFilterOf(item) === type),
  );
}

/** The list row that a selected map feature belongs to. */
export function itemContaining(items: RiskItem[], selectedId: string | null): RiskItem | null {
  if (!selectedId) return null;
  return (
    items.find((item) =>
      item.kind === "alert" ? item.id === selectedId : item.risks.some((risk) => risk.id === selectedId),
    ) ?? null
  );
}

export type SelectionRequest = {
  id: string;
  /** Increments on every selection so re-selecting the same item re-opens its popup. */
  seq: number;
  /** List selections move the map; map clicks leave the camera where the user put it. */
  origin: "list" | "map";
  /** For detected risks chosen from the list: frame every location of that risk type. */
  frameGroup?: boolean;
};

export type MapPopupContent = {
  title: string;
  kind: "Official NWS alert" | "Detected risk";
  level: SeverityLevel;
  lines: string[];
};

export type MapSelection = {
  id: string;
  seq: number;
  anchor: LonLat | null;
  fit: BBox | null;
  moveCamera: boolean;
  popup: MapPopupContent;
};

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function pointsBbox(risks: DetectedWeatherRisk[]): BBox | null {
  if (risks.length < 2) return null;
  const longitudes = risks.map((risk) => risk.longitude);
  const latitudes = risks.map((risk) => risk.latitude);
  return [Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes)];
}

/** Turns a selection into what the map needs: where to point, what to frame, what to say. */
export function describeSelection(
  result: Pick<WeatherCheckResult, "officialAlerts" | "detectedRisks">,
  selection: SelectionRequest,
): MapSelection | null {
  const moveCamera = selection.origin === "list";

  const alert = result.officialAlerts.find((candidate) => candidate.id === selection.id);
  if (alert) {
    return {
      id: alert.id,
      seq: selection.seq,
      anchor: alert.anchor,
      fit: alert.geometry ? bbox(alert.geometry) : null,
      moveCamera,
      popup: {
        title: alert.event,
        kind: "Official NWS alert",
        level: alert.level,
        lines: [
          alert.areaDescription ? truncate(alert.areaDescription, 140) : null,
          formatAlertDistance(alert.distanceMiles),
          formatUntil(alert.ends ?? alert.expires),
        ].filter((line): line is string => Boolean(line)),
      },
    };
  }

  const risk = result.detectedRisks.find((candidate) => candidate.id === selection.id);
  if (risk) {
    const group = result.detectedRisks.filter((candidate) => candidate.riskType === risk.riskType);
    return {
      id: risk.id,
      seq: selection.seq,
      anchor: [risk.longitude, risk.latitude],
      fit: selection.frameGroup ? pointsBbox(group) : null,
      moveCamera,
      popup: {
        title: risk.title,
        kind: "Detected risk",
        level: risk.severity,
        lines: [risk.description, risk.locationLabel ?? null, formatPointDistance(risk.distanceMiles)].filter(
          (line): line is string => Boolean(line),
        ),
      },
    };
  }

  return null;
}
