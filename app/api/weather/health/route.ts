import { connection } from "next/server";
import { checkWeatherHealth, isHealthy } from "@/lib/weather/health";
import { errorResponse, jsonResponse } from "@/lib/weather/http-response";

/**
 * Whether the live data sources are reachable right now. 200 when everything is, 503 when
 * something is down. Reports reachability and latency only; upstream probes are cached
 * briefly so this endpoint cannot be used to hammer NWS.
 */
export async function GET() {
  await connection();
  try {
    const health = await checkWeatherHealth();
    return jsonResponse(health, isHealthy(health) ? 200 : 503);
  } catch (error) {
    return errorResponse(error);
  }
}
