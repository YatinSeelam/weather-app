import { timingSafeEqual } from "node:crypto";
import { connection } from "next/server";
import { WeatherError } from "@/lib/weather/errors";
import { errorResponse, jsonResponse } from "@/lib/weather/http-response";
import { processDueMonitors } from "@/lib/weather/monitor-runner";

/**
 * Entry point for an external scheduler (Vercel Cron, system cron, uptime pinger...).
 * Call it every 15 minutes or more often; it runs whichever monitors are due.
 * Requires `Authorization: Bearer $CRON_SECRET`. Without a configured secret it only
 * answers outside production.
 */
function authorize(request: Request): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new WeatherError("UNAUTHORIZED", "Set CRON_SECRET to enable this endpoint.");
    }
    return;
  }
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new WeatherError("UNAUTHORIZED", "Missing or incorrect cron credentials.");
  }
}

async function handle(request: Request) {
  await connection();
  try {
    authorize(request);
    return jsonResponse(await processDueMonitors());
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = handle;
export const POST = handle;
