import { WeatherError } from "@/lib/weather/errors";
import { errorResponse, jsonResponse, readJsonBody, validationErrorResponse } from "@/lib/weather/http-response";
import { computeNextCheckAt } from "@/lib/weather/monitor-schedule";
import { getMonitorStore, type WeatherMonitor } from "@/lib/weather/monitor-store";
import { updateMonitorSchema } from "@/lib/weather/schemas";

type Context = { params: Promise<{ id: string }> };

const notFound = () => new WeatherError("NOT_FOUND", "That monitor no longer exists.");

export async function PATCH(request: Request, { params }: Context) {
  try {
    const { id } = await params;
    const parsed = updateMonitorSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) return validationErrorResponse(parsed.error);

    const store = getMonitorStore();
    const existing = await store.getMonitor(id);
    if (!existing) throw notFound();

    const { risks, ...rest } = parsed.data;
    const now = new Date();
    const patch: Partial<WeatherMonitor> = { ...rest, updatedAt: now.toISOString() };
    if (risks) patch.riskTypes = risks;

    // Re-enabling, or changing what is watched, makes the monitor due on the next tick.
    // A new frequency alone is measured from the last check.
    const becameEnabled = rest.enabled === true && !existing.enabled;
    const scopeChanged = risks !== undefined || rest.radiusMiles !== undefined;
    if (becameEnabled || scopeChanged) {
      patch.nextCheckAt = now.toISOString();
    } else if (rest.intervalMinutes !== undefined) {
      const from = existing.lastCheckedAt ? new Date(existing.lastCheckedAt) : now;
      patch.nextCheckAt = computeNextCheckAt(from, rest.intervalMinutes).toISOString();
    }

    const monitor = await store.updateMonitor(id, patch);
    if (!monitor) throw notFound();
    return jsonResponse({ monitor });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    const { id } = await params;
    if (!(await getMonitorStore().deleteMonitor(id))) throw notFound();
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
