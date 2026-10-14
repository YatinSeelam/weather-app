import { connection, type NextRequest } from "next/server";
import { singleton } from "@/lib/weather/concurrency";
import { WeatherError } from "@/lib/weather/errors";
import { getCoordinatesForZip } from "@/lib/weather/geocoder";
import { errorResponse, jsonResponse, validationErrorResponse } from "@/lib/weather/http-response";
import { clientKey, createRateLimiter } from "@/lib/weather/rate-limit";
import { zipCodeSchema } from "@/lib/weather/schemas";

const rateLimiter = () => singleton("geocode-rate-limiter", () => createRateLimiter({ limit: 60, windowMs: 60_000 }));

/** Server-side ZIP lookup, so the browser never depends on the third-party geocoder directly. */
export async function GET(request: NextRequest) {
  await connection();
  try {
    const decision = rateLimiter().check(clientKey(request));
    if (!decision.allowed) {
      throw new WeatherError("RATE_LIMITED", "Too many ZIP lookups in a short time. Wait a moment and try again.", {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    const parsed = zipCodeSchema.safeParse(request.nextUrl.searchParams.get("zip") ?? "");
    if (!parsed.success) return validationErrorResponse(parsed.error);

    return jsonResponse(await getCoordinatesForZip(parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
