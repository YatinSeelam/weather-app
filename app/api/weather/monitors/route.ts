import { randomUUID } from "node:crypto";
import { connection } from "next/server";
import { getCoordinatesForZip } from "@/lib/weather/geocoder";
import { errorResponse, jsonResponse, readJsonBody, validationErrorResponse } from "@/lib/weather/http-response";
import { runMonitor } from "@/lib/weather/monitor-runner";
import { getMonitorStore, type WeatherMonitor } from "@/lib/weather/monitor-store";
import { notificationStatus } from "@/lib/weather/notifications";
import { createMonitorSchema } from "@/lib/weather/schemas";

export async function GET() {
  // Always answered at request time: opts this handler out of build-time prerendering.
  await connection();
  try {
    return jsonResponse({ monitors: await getMonitorStore().listMonitors(), notifications: notificationStatus() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const parsed = createMonitorSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error);
    const input = parsed.data;

    const location = await getCoordinatesForZip(input.zipCode);
    const now = new Date();
    const monitor: WeatherMonitor = {
      id: randomUUID(),
      userId: null,
      name: input.name ?? `${location.city}, ${location.state} · ${input.radiusMiles} mi`,
      zipCode: location.zip,
      city: location.city,
      state: location.state,
      centerLat: location.latitude,
      centerLng: location.longitude,
      radiusMiles: input.radiusMiles,
      intervalMinutes: input.intervalMinutes,
      enabled: true,
      riskTypes: input.risks,
      thresholds: {},
      emails: input.emails,
      emailMode: input.emailMode,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastCheckedAt: null,
      nextCheckAt: now.toISOString(),
      lastRun: null,
    };

    const store = getMonitorStore();
    await store.createMonitor(monitor);
    // First run right away: it records the baseline alert state, so the scheduler only
    // reports what changes from here on.
    await runMonitor(monitor, now);

    return jsonResponse({ monitor: (await store.getMonitor(monitor.id)) ?? monitor }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
