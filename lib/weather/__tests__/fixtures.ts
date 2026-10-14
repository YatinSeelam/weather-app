import type { Polygon } from "geojson";
import type { NwsAlertFeature } from "../nws-normalizer";

/**
 * Hand-written fixtures in the shape of real api.weather.gov responses. Tests never call
 * the live API, so they do not depend on what the weather is doing today.
 */

/** ZIP 12477 (Saugerties, NY). */
export const CENTER = { latitude: 42.0738, longitude: -73.9797 };

/** A box of roughly `halfDegrees` around a point. */
export function squareAround(longitude: number, latitude: number, halfDegrees = 0.1): Polygon {
  return {
    type: "Polygon",
    coordinates: [
      [
        [longitude - halfDegrees, latitude - halfDegrees],
        [longitude + halfDegrees, latitude - halfDegrees],
        [longitude + halfDegrees, latitude + halfDegrees],
        [longitude - halfDegrees, latitude + halfDegrees],
        [longitude - halfDegrees, latitude - halfDegrees],
      ],
    ],
  };
}

const HOUR = 60 * 60 * 1000;
export const NOW = new Date("2026-10-06T20:00:00Z");
const inHours = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();

export function alertFeature(
  overrides: Partial<NwsAlertFeature["properties"]> & { geometry?: NwsAlertFeature["geometry"] } = {},
): NwsAlertFeature {
  const { geometry = null, ...properties } = overrides;
  const id = properties.id ?? `urn:oid:test.${Math.abs(hash(JSON.stringify(overrides)))}`;
  return {
    id: `https://api.weather.gov/alerts/${id}`,
    geometry,
    properties: {
      id,
      event: "Flood Warning",
      areaDesc: "Ulster, NY",
      severity: "Severe",
      certainty: "Observed",
      urgency: "Immediate",
      status: "Actual",
      messageType: "Alert",
      response: "Avoid",
      headline: "Flood Warning issued October 6 at 4:00PM EDT by NWS Albany NY",
      description: "Flooding caused by excessive rainfall\nis expected.",
      instruction: "Turn around, don't drown.",
      effective: inHours(-1),
      onset: inHours(-1),
      expires: inHours(2),
      ends: inHours(6),
      senderName: "NWS Albany NY",
      affectedZones: [],
      geocode: { UGC: [] },
      references: [],
      ...properties,
    },
  };
}

function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index++) value = (value * 31 + text.charCodeAt(index)) | 0;
  return value;
}

/** Raw /gridpoints payload with hourly series starting at NOW. */
export function gridpointPayload(series: {
  temperatureC?: number[];
  apparentC?: number[];
  windKmh?: number[];
  gustKmh?: number[];
  /** One value per 6-hour bucket, in millimetres. */
  rainMm?: number[];
}) {
  const hourly = (values: number[] | undefined, uom: string) => ({
    uom,
    values: (values ?? []).map((value, index) => ({
      validTime: `${new Date(NOW.getTime() + index * HOUR).toISOString()}/PT1H`,
      value,
    })),
  });
  return {
    properties: {
      temperature: hourly(series.temperatureC, "wmoUnit:degC"),
      apparentTemperature: hourly(series.apparentC, "wmoUnit:degC"),
      windSpeed: hourly(series.windKmh, "wmoUnit:km_h-1"),
      windGust: hourly(series.gustKmh, "wmoUnit:km_h-1"),
      quantitativePrecipitation: {
        uom: "wmoUnit:mm",
        values: (series.rainMm ?? []).map((value, index) => ({
          validTime: `${new Date(NOW.getTime() + index * 6 * HOUR).toISOString()}/PT6H`,
          value,
        })),
      },
    },
  };
}

export function pointPayload(gridX: number, gridY: number, city = "Kingston") {
  return {
    properties: {
      gridId: "ALY",
      gridX,
      gridY,
      timeZone: "America/New_York",
      relativeLocation: { properties: { city, state: "NY" } },
    },
  };
}

export function zonePayload(id: string, geometry: Polygon) {
  return { geometry, properties: { id, name: `Zone ${id}`, state: "NY" } };
}

export const zipPayload = {
  "post code": "12477",
  country: "United States",
  places: [
    {
      "place name": "Saugerties",
      longitude: "-73.9797",
      latitude: "42.0738",
      state: "New York",
      "state abbreviation": "NY",
    },
  ],
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
