import bbox from "@turf/bbox";
import centroid from "@turf/centroid";
import circle from "@turf/circle";
import destination from "@turf/destination";
import distance from "@turf/distance";
import { point, polygon } from "@turf/helpers";
import { pointToPolygonDistance } from "@turf/point-to-polygon-distance";
import type { BBox, Feature, Geometry, MultiPolygon, Polygon, Position } from "geojson";
import type { Coordinates, LonLat } from "./types";

export type PolygonCoordinates = Position[][];

const toPosition = (c: Coordinates): Position => [c.longitude, c.latitude];

/** Great-circle distance in miles. */
export function distanceMiles(a: Coordinates, b: Coordinates): number {
  return distance(toPosition(a), toPosition(b), { units: "miles" });
}

/** A geographically correct circle (geodesic buffer around a point), as a polygon. */
export function radiusCircle(center: Coordinates, radiusMiles: number, steps = 128): Feature<Polygon> {
  return circle(toPosition(center), radiusMiles, { units: "miles", steps });
}

export function radiusBbox(center: Coordinates, radiusMiles: number): BBox {
  return bbox(radiusCircle(center, radiusMiles, 64));
}

/** The point reached by travelling `miles` from `origin` along `bearingDegrees` (0 = north, clockwise). */
export function destinationPoint(origin: Coordinates, miles: number, bearingDegrees: number): Coordinates {
  const [longitude, latitude] = destination(toPosition(origin), miles, bearingDegrees, { units: "miles" }).geometry
    .coordinates;
  return { latitude, longitude };
}

export function bboxesOverlap(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Every polygon contained in a geometry. Points and lines contribute nothing. */
export function polygonsOf(geometry: Geometry): PolygonCoordinates[] {
  switch (geometry.type) {
    case "Polygon":
      return [geometry.coordinates];
    case "MultiPolygon":
      return geometry.coordinates;
    case "GeometryCollection":
      return geometry.geometries.flatMap(polygonsOf);
    default:
      return [];
  }
}

export function toMultiPolygon(polygons: PolygonCoordinates[]): MultiPolygon {
  return { type: "MultiPolygon", coordinates: polygons };
}

export function bboxOfPolygons(polygons: PolygonCoordinates[]): BBox | null {
  if (polygons.length === 0) return null;
  return bbox(toMultiPolygon(polygons));
}

/**
 * Miles from a point to the nearest edge of a polygon; 0 when the point is inside it.
 * Returns null for rings too malformed to measure.
 */
export function distanceToPolygonMiles(center: Coordinates, coordinates: PolygonCoordinates): number | null {
  try {
    const miles = pointToPolygonDistance(point(toPosition(center)), polygon(coordinates), {
      units: "miles",
      method: "geodesic",
    });
    return Number.isFinite(miles) ? Math.max(0, miles) : null;
  } catch {
    return null;
  }
}

export type NearestPolygon = { distanceMiles: number; polygon: PolygonCoordinates };

export function nearestPolygon(center: Coordinates, polygons: PolygonCoordinates[]): NearestPolygon | null {
  let nearest: NearestPolygon | null = null;
  for (const candidate of polygons) {
    const miles = distanceToPolygonMiles(center, candidate);
    if (miles === null) continue;
    if (!nearest || miles < nearest.distanceMiles) nearest = { distanceMiles: miles, polygon: candidate };
  }
  return nearest;
}

/**
 * Distance from the center to a geometry's nearest edge, in miles. Null when the geometry
 * has no measurable area (so we never report a made-up distance).
 */
export function distanceToGeometryMiles(center: Coordinates, geometry: Geometry): number | null {
  return nearestPolygon(center, polygonsOf(geometry))?.distanceMiles ?? null;
}

/**
 * True when any part of the geometry lies within `radiusMiles` of the center. This is a real
 * circle/polygon intersection test (nearest edge within the radius), not a centroid check,
 * so areas that only partially enter the circle still count.
 */
export function geometryIntersectsRadius(center: Coordinates, radiusMiles: number, geometry: Geometry): boolean {
  const miles = distanceToGeometryMiles(center, geometry);
  return miles !== null && miles <= radiusMiles;
}

/** A representative point for a polygon, used to anchor markers and popups. */
export function polygonAnchor(coordinates: PolygonCoordinates): LonLat | null {
  try {
    const [lon, lat] = centroid(polygon(coordinates)).geometry.coordinates;
    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
  } catch {
    return null;
  }
}
