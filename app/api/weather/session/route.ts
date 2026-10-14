import { connection } from "next/server";
import { z } from "zod";
import { monitorApiSecret } from "@/lib/weather/config";
import { WeatherError } from "@/lib/weather/errors";
import { errorResponse, jsonResponse, readJsonBody, validationErrorResponse } from "@/lib/weather/http-response";
import {
  assertNotLockedOut,
  clearedSessionCookie,
  createSessionToken,
  isCrossSite,
  isMonitorSecret,
  recordFailedAttempt,
  sessionCookie,
  sessionStatus,
} from "@/lib/weather/monitor-auth";

/**
 * Browser access to saved monitors. POST trades the access key for an HttpOnly session cookie,
 * DELETE drops it, GET says whether the monitor API is configured and whether this browser is in.
 */

const unlockSchema = z.object({ secret: z.string().min(1, "Enter the access key.").max(512) });

export async function GET(request: Request) {
  await connection();
  return jsonResponse(sessionStatus(request));
}

export async function POST(request: Request) {
  try {
    const secret = monitorApiSecret();
    if (!secret) {
      throw new WeatherError("UNAUTHORIZED", "Saved monitors are turned off: MONITOR_API_SECRET is not set on the server.");
    }
    if (isCrossSite(request)) throw new WeatherError("UNAUTHORIZED", "Saved monitors can only be unlocked from this app.");
    assertNotLockedOut(request);

    const parsed = unlockSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error);
    if (!isMonitorSecret(parsed.data.secret)) {
      recordFailedAttempt(request);
      throw new WeatherError("UNAUTHORIZED", "That access key is not valid.");
    }

    const response = jsonResponse({ configured: true, unlocked: true });
    response.headers.append("Set-Cookie", sessionCookie(request, createSessionToken(secret)));
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const response = new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  response.headers.append("Set-Cookie", clearedSessionCookie(request));
  return response;
}
