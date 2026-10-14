import {
  bboxOfPolygons,
  bboxesOverlap,
  nearestPolygon,
  polygonAnchor,
  polygonsOf,
  radiusBbox,
  toMultiPolygon,
  type PolygonCoordinates,
} from "./geography";
import type { ResolvedZone } from "./nws-client";
import { alertIdentifier, isAlertActive, normalizeAlertProperties, type NwsAlertFeature } from "./nws-normalizer";
import { ugcMayIntersect } from "./regions";
import type { AlertGeometrySource, Coordinates, WeatherAlert } from "./types";

export type ZoneResolver = (zoneUrl: string) => Promise<ResolvedZone | null>;

export type LocatedAlerts = {
  alerts: WeatherAlert[];
  /**
   * Alerts that might be in range but could not be placed because their zone boundaries
   * failed to load. They are reported, never guessed at.
   */
  unresolvedCount: number;
};

type Outcome = { kind: "inside"; alert: WeatherAlert } | { kind: "outside" } | { kind: "unresolved" };

const OUTSIDE: Outcome = { kind: "outside" };

type AlertArea = {
  source: AlertGeometrySource;
  /** Full extent of the alert, for display. */
  polygons: PolygonCoordinates[];
  /** The parts close enough to be worth measuring. */
  nearby: PolygonCoordinates[];
  /** True when some of the alert's zones could not be loaded. */
  incomplete: boolean;
};

async function resolveArea(
  feature: NwsAlertFeature,
  searchBbox: ReturnType<typeof radiusBbox>,
  resolveZone: ZoneResolver,
): Promise<AlertArea | "outside" | "unresolved"> {
  // 1. Storm-based alerts (tornado, severe thunderstorm, flash flood...) carry their own polygon.
  const ownPolygons = feature.geometry ? polygonsOf(feature.geometry) : [];
  if (ownPolygons.length > 0) {
    const box = bboxOfPolygons(ownPolygons);
    if (!box || !bboxesOverlap(box, searchBbox)) return "outside";
    return { source: "nws-polygon", polygons: ownPolygons, nearby: ownPolygons, incomplete: false };
  }

  // 2. Everything else is issued for whole forecast zones or counties and has null geometry.
  //    Fall back to the published boundaries of those zones.
  const zoneUrls = feature.properties.affectedZones ?? [];
  if (zoneUrls.length === 0) return "outside";
  const codes = feature.properties.geocode?.UGC ?? zoneUrls.map((url) => url.slice(url.lastIndexOf("/") + 1));
  if (!codes.some((code) => ugcMayIntersect(code, searchBbox))) return "outside";

  const settled = await Promise.allSettled(zoneUrls.map(resolveZone));
  const zones = settled.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
  const incomplete = settled.some((result) => result.status === "rejected");

  const nearby = zones.filter((zone) => bboxesOverlap(zone.bbox, searchBbox)).flatMap((zone) => zone.polygons);
  if (nearby.length === 0) return incomplete ? "unresolved" : "outside";
  return { source: "nws-zones", polygons: zones.flatMap((zone) => zone.polygons), nearby, incomplete };
}

async function locateAlert(
  feature: NwsAlertFeature,
  center: Coordinates,
  radiusMiles: number,
  searchBbox: ReturnType<typeof radiusBbox>,
  resolveZone: ZoneResolver,
): Promise<Outcome> {
  const id = alertIdentifier(feature);
  if (!id) return OUTSIDE;

  const area = await resolveArea(feature, searchBbox, resolveZone);
  if (area === "outside") return OUTSIDE;
  if (area === "unresolved") return { kind: "unresolved" };

  // Include the alert when any part of its area reaches into the radius.
  const nearest = nearestPolygon(center, area.nearby);
  if (!nearest || nearest.distanceMiles > radiusMiles) {
    return area.incomplete ? { kind: "unresolved" } : OUTSIDE;
  }

  return {
    kind: "inside",
    alert: {
      id,
      ...normalizeAlertProperties(feature),
      geometry: area.source === "nws-polygon" ? feature.geometry : toMultiPolygon(area.polygons),
      geometrySource: area.source,
      anchor: polygonAnchor(nearest.polygon),
      distanceMiles: Math.round(nearest.distanceMiles * 10) / 10,
    },
  };
}

/** Keeps the active alerts whose area intersects the circle around `center`. */
export async function locateAlertsInRadius(
  features: NwsAlertFeature[],
  center: Coordinates,
  radiusMiles: number,
  now: Date,
  resolveZone: ZoneResolver,
): Promise<LocatedAlerts> {
  const searchBbox = radiusBbox(center, radiusMiles);
  const outcomes = await Promise.all(
    features
      .filter((feature) => isAlertActive(feature.properties, now))
      .map((feature) => locateAlert(feature, center, radiusMiles, searchBbox, resolveZone)),
  );

  const byId = new Map<string, WeatherAlert>();
  let unresolvedCount = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "inside") byId.set(outcome.alert.id, outcome.alert);
    else if (outcome.kind === "unresolved") unresolvedCount++;
  }
  return { alerts: [...byId.values()], unresolvedCount };
}
