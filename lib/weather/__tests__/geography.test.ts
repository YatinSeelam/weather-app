import { describe, expect, it } from "vitest";
import {
  bboxesOverlap,
  destinationPoint,
  distanceMiles,
  distanceToGeometryMiles,
  geometryIntersectsRadius,
  radiusBbox,
  radiusCircle,
} from "../geography";
import { ugcMayIntersect } from "../regions";
import { generateSamplePoints, targetSampleCount } from "../sampling";
import { celsiusToFahrenheit, converterFor, kmToMiles, kmhToMph, milesToKm, mmToInches } from "../units";
import { CENTER, squareAround } from "./fixtures";

describe("unit conversion", () => {
  it("converts between miles and kilometres", () => {
    expect(milesToKm(100)).toBeCloseTo(160.934, 3);
    expect(kmToMiles(160.9344)).toBeCloseTo(100, 6);
    expect(kmToMiles(milesToKm(37.5))).toBeCloseTo(37.5, 9);
  });

  it("converts the units NWS grid data uses", () => {
    expect(celsiusToFahrenheit(0)).toBe(32);
    expect(celsiusToFahrenheit(-40)).toBe(-40);
    expect(kmhToMph(72.42)).toBeCloseTo(45, 1);
    expect(mmToInches(25.4)).toBe(1);
  });

  it("refuses to guess at units it does not know", () => {
    expect(converterFor("wmoUnit:degC", "degF")?.(100)).toBe(212);
    expect(converterFor("wmoUnit:furlongs", "mph")).toBeNull();
    expect(converterFor(null, "in")).toBeNull();
  });
});

describe("distance", () => {
  it("measures great-circle distance in miles", () => {
    const albany = { latitude: 42.6526, longitude: -73.7562 };
    const newYork = { latitude: 40.7128, longitude: -74.006 };
    // Saugerties to Albany is about 41 miles; to New York City about 94.
    expect(distanceMiles(CENTER, albany)).toBeGreaterThan(39);
    expect(distanceMiles(CENTER, albany)).toBeLessThan(43);
    expect(distanceMiles(CENTER, newYork)).toBeGreaterThan(91);
    expect(distanceMiles(CENTER, newYork)).toBeLessThan(97);
  });

  it("is not fooled by longitude degrees shrinking away from the equator", () => {
    const oneDegreeEast = { latitude: CENTER.latitude, longitude: CENTER.longitude + 1 };
    const oneDegreeNorth = { latitude: CENTER.latitude + 1, longitude: CENTER.longitude };
    expect(distanceMiles(CENTER, oneDegreeEast)).toBeCloseTo(51.3, 0);
    expect(distanceMiles(CENTER, oneDegreeNorth)).toBeCloseTo(69.1, 0);
  });
});

describe("radius circle", () => {
  it("puts every vertex of the circle the requested distance from the center", () => {
    const ring = radiusCircle(CENTER, 100).geometry.coordinates[0];
    expect(ring.length).toBeGreaterThan(100);
    for (const [longitude, latitude] of ring) {
      expect(distanceMiles(CENTER, { latitude, longitude })).toBeCloseTo(100, 0);
    }
  });

  it("is wider in degrees of longitude than latitude, as a true circle must be at 42°N", () => {
    const [west, south, east, north] = radiusBbox(CENTER, 100);
    expect(east - west).toBeGreaterThan((north - south) * 1.25);
  });
});

describe("circle and polygon intersection", () => {
  const eastOf = (miles: number) => destinationPoint(CENTER, miles, 90);

  it("includes a polygon entirely inside the radius", () => {
    const inside = eastOf(20);
    expect(geometryIntersectsRadius(CENTER, 100, squareAround(inside.longitude, inside.latitude))).toBe(true);
  });

  it("excludes a polygon entirely outside the radius", () => {
    const outside = eastOf(160);
    expect(geometryIntersectsRadius(CENTER, 100, squareAround(outside.longitude, outside.latitude))).toBe(false);
  });

  it("includes a polygon that only partly enters the radius even though its centroid is outside", () => {
    // Centered 108 miles out; half-width of 0.3° of longitude is about 15 miles, so its near edge is ~93 miles away.
    const centroid = eastOf(108);
    const polygon = squareAround(centroid.longitude, centroid.latitude, 0.3);
    expect(distanceMiles(CENTER, centroid)).toBeGreaterThan(100);
    expect(geometryIntersectsRadius(CENTER, 100, polygon)).toBe(true);
    expect(geometryIntersectsRadius(CENTER, 90, polygon)).toBe(false);
  });

  it("reports zero distance when the center is inside the polygon", () => {
    expect(distanceToGeometryMiles(CENTER, squareAround(CENTER.longitude, CENTER.latitude))).toBe(0);
  });

  it("measures to the nearest edge, across every part of a MultiPolygon", () => {
    const near = eastOf(30);
    const far = eastOf(150);
    const distance = distanceToGeometryMiles(CENTER, {
      type: "MultiPolygon",
      coordinates: [
        squareAround(far.longitude, far.latitude).coordinates,
        squareAround(near.longitude, near.latitude).coordinates,
      ],
    });
    // Near square is centered 30 miles east with a half-width of ~5 miles.
    expect(distance).toBeGreaterThan(23);
    expect(distance).toBeLessThan(27);
  });

  it("returns null rather than a made-up distance for geometry without area", () => {
    expect(distanceToGeometryMiles(CENTER, { type: "Point", coordinates: [-73, 42] })).toBeNull();
    expect(geometryIntersectsRadius(CENTER, 100, { type: "Point", coordinates: [-73.98, 42.07] })).toBe(false);
  });
});

describe("region pre-filter", () => {
  const search = radiusBbox(CENTER, 100);

  it("keeps zones in states the radius could touch and drops distant ones", () => {
    expect(ugcMayIntersect("NYZ063", search)).toBe(true);
    expect(ugcMayIntersect("CTZ001", search)).toBe(true);
    expect(ugcMayIntersect("FLZ076", search)).toBe(false);
    expect(ugcMayIntersect("PZZ535", search)).toBe(false);
  });

  it("never drops a zone it does not recognize", () => {
    expect(ugcMayIntersect("XXZ001", search)).toBe(true);
  });

  it("detects overlapping boxes", () => {
    expect(bboxesOverlap([0, 0, 2, 2], [1, 1, 3, 3])).toBe(true);
    expect(bboxesOverlap([0, 0, 1, 1], [2, 2, 3, 3])).toBe(false);
  });
});

describe("sampling grid", () => {
  it("scales the number of sample points with the radius", () => {
    expect(targetSampleCount(25)).toBe(7);
    expect(targetSampleCount(50)).toBe(19);
    expect(targetSampleCount(100)).toBe(37);
    expect(targetSampleCount(150)).toBe(61);
    expect(generateSamplePoints(CENTER, 25)).toHaveLength(7);
    expect(generateSamplePoints(CENTER, 100)).toHaveLength(37);
    expect(generateSamplePoints(CENTER, 150)).toHaveLength(61);
  });

  it("keeps every point inside the radius and includes the center", () => {
    const points = generateSamplePoints(CENTER, 100);
    expect(points[0].distanceMiles).toBe(0);
    for (const point of points) {
      expect(distanceMiles(CENTER, point)).toBeLessThanOrEqual(100.5);
    }
  });

  it("is deterministic, so repeat checks reuse cached grid lookups", () => {
    expect(generateSamplePoints(CENTER, 50)).toEqual(generateSamplePoints(CENTER, 50));
  });

  it("reaches the outer part of the circle, not just the middle", () => {
    const farthest = Math.max(...generateSamplePoints(CENTER, 100).map((point) => point.distanceMiles));
    expect(farthest).toBeGreaterThan(85);
  });
});
