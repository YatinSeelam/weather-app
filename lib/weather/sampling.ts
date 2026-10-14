import { SAMPLE_POINT_TARGETS } from "./constants";
import { destinationPoint } from "./geography";
import type { Coordinates } from "./types";

export type SamplePoint = Coordinates & {
  /** Great-circle distance from the center. */
  distanceMiles: number;
};

export function targetSampleCount(radiusMiles: number): number {
  const tier = SAMPLE_POINT_TARGETS.find((t) => radiusMiles <= t.maxRadiusMiles);
  return (tier ?? SAMPLE_POINT_TARGETS[SAMPLE_POINT_TARGETS.length - 1]).points;
}

// NWS /points accepts at most 4 decimal places (~11 m), which also keeps cache keys stable.
const roundCoordinate = (value: number) => Math.round(value * 1e4) / 1e4;

/**
 * Evenly covers the radius with a hexagonal lattice (center included) instead of querying
 * every address. Density scales with radius: about 7 points at 25 mi up to about 61 at 150 mi.
 * The lattice is deterministic for a given center and radius, so repeat checks hit the same
 * forecast grid cells and their caches.
 */
export function generateSamplePoints(center: Coordinates, radiusMiles: number): SamplePoint[] {
  const target = targetSampleCount(radiusMiles);
  // A hex lattice has one point per (sqrt(3)/2 * spacing^2) of area.
  const spacing = radiusMiles * Math.sqrt(Math.PI / ((Math.sqrt(3) / 2) * target));
  const reach = Math.ceil(radiusMiles / spacing) + 1;
  const points: SamplePoint[] = [];

  for (let row = -reach; row <= reach; row++) {
    for (let col = -reach; col <= reach; col++) {
      const east = spacing * (col + row / 2);
      const north = spacing * row * (Math.sqrt(3) / 2);
      const offsetMiles = Math.hypot(east, north);
      if (offsetMiles > radiusMiles) continue;

      if (offsetMiles === 0) {
        points.push({
          latitude: roundCoordinate(center.latitude),
          longitude: roundCoordinate(center.longitude),
          distanceMiles: 0,
        });
        continue;
      }
      const bearing = (Math.atan2(east, north) * 180) / Math.PI;
      const position = destinationPoint(center, offsetMiles, bearing);
      points.push({
        latitude: roundCoordinate(position.latitude),
        longitude: roundCoordinate(position.longitude),
        distanceMiles: offsetMiles,
      });
    }
  }

  return points.sort((a, b) => a.distanceMiles - b.distanceMiles);
}
