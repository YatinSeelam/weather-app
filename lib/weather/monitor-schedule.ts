import type { WeatherMonitor } from "./monitor-store";

export function computeNextCheckAt(from: Date, intervalMinutes: number): Date {
  return new Date(from.getTime() + intervalMinutes * 60_000);
}

export function isMonitorDue(monitor: Pick<WeatherMonitor, "enabled" | "nextCheckAt">, now: Date): boolean {
  if (!monitor.enabled) return false;
  const due = Date.parse(monitor.nextCheckAt);
  // An unreadable timestamp counts as due so a corrupted record is checked rather than silently skipped.
  return Number.isNaN(due) || due <= now.getTime();
}

/** The equivalent of `WHERE enabled AND next_check_at <= now() ORDER BY next_check_at`. */
export function selectDueMonitors<M extends Pick<WeatherMonitor, "enabled" | "nextCheckAt">>(
  monitors: M[],
  now: Date,
): M[] {
  return monitors
    .filter((monitor) => isMonitorDue(monitor, now))
    .sort((a, b) => a.nextCheckAt.localeCompare(b.nextCheckAt));
}
