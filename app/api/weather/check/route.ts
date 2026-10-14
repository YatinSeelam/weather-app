import { singleton } from "@/lib/weather/concurrency";
import { CHECK_RATE_LIMIT } from "@/lib/weather/constants";
import { WeatherError } from "@/lib/weather/errors";
import { errorResponse, jsonResponse, readJsonBody, validationErrorResponse } from "@/lib/weather/http-response";
import { clientKey, createRateLimiter } from "@/lib/weather/rate-limit";
import { checkRequestSchema } from "@/lib/weather/schemas";
import { checkWeather } from "@/lib/weather/weather-service";

const rateLimiter = () => singleton("check-rate-limiter", () => createRateLimiter(CHECK_RATE_LIMIT));

export async function POST(request: Request) {
  try {
    const decision = rateLimiter().check(clientKey(request));
    if (!decision.allowed) {
      throw new WeatherError("RATE_LIMITED", "Too many weather checks in a short time. Wait a moment and try again.", {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }

    const parsed = checkRequestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error);

    return jsonResponse(await checkWeather(parsed.data));
  } catch (error) {
    return errorResponse(error);
  }
}
