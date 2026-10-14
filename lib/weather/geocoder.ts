import { z } from "zod";
import { PersistentCache } from "./cache";
import { singleton } from "./concurrency";
import { zipApiBaseUrl } from "./config";
import { CACHE_TTL } from "./constants";
import { isWeatherError, WeatherError } from "./errors";
import type { ZipCoordinates } from "./types";

const ZIP_PATTERN = /^\d{5}$/;
const REQUEST_TIMEOUT_MS = 8_000;

export function isValidZip(zip: string): boolean {
  return ZIP_PATTERN.test(zip);
}

// Zippopotam.us response shape, e.g. https://api.zippopotam.us/us/12477
const zipResponseSchema = z.object({
  places: z
    .array(
      z.object({
        "place name": z.string(),
        "state abbreviation": z.string(),
        latitude: z.coerce.number(),
        longitude: z.coerce.number(),
      }),
    )
    .min(1),
});

const zipCache = () => singleton("zip-cache", () => new PersistentCache<ZipCoordinates>("zip", CACHE_TTL.zipMs));

async function lookupZip(zip: string): Promise<ZipCoordinates> {
  let response: Response;
  try {
    response = await fetch(`${zipApiBaseUrl()}/us/${zip}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new WeatherError("GEOCODING_FAILED", "ZIP code lookup is unavailable right now. Try again in a moment.", {
      cause: error,
      source: "geocoding",
    });
  }

  if (response.status === 404) {
    throw new WeatherError("ZIP_NOT_FOUND", `No U.S. location found for ZIP code ${zip}.`);
  }
  if (!response.ok) {
    throw new WeatherError("GEOCODING_FAILED", "ZIP code lookup is unavailable right now. Try again in a moment.", {
      source: "geocoding",
    });
  }

  const parsed = zipResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new WeatherError("ZIP_NOT_FOUND", `No U.S. location found for ZIP code ${zip}.`);
  }
  const place = parsed.data.places[0];
  if (Math.abs(place.latitude) > 90 || Math.abs(place.longitude) > 180) {
    throw new WeatherError("GEOCODING_FAILED", `ZIP code ${zip} returned coordinates that are not valid.`);
  }
  return {
    zip,
    city: place["place name"],
    state: place["state abbreviation"],
    latitude: place.latitude,
    longitude: place.longitude,
  };
}

/**
 * Resolves a 5-digit U.S. ZIP code to its center point. Runs server-side only and caches
 * successful lookups on disk, so the upstream service is asked about each ZIP once.
 */
export async function getCoordinatesForZip(zip: string): Promise<ZipCoordinates> {
  const normalized = zip.trim();
  if (!isValidZip(normalized)) {
    throw new WeatherError("INVALID_INPUT", "Enter a 5-digit U.S. ZIP code.");
  }
  try {
    return await zipCache().getOrLoad(normalized, () => lookupZip(normalized));
  } catch (error) {
    if (isWeatherError(error)) throw error;
    throw new WeatherError("GEOCODING_FAILED", "ZIP code lookup failed.", { cause: error, source: "geocoding" });
  }
}
