import { singleton } from "./concurrency";
import { SCHEDULER_TICK_MS } from "./constants";
import { processDueMonitors } from "./monitor-runner";

/**
 * In-process scheduler for a long-running server (`next dev` / `next start`): one timer that
 * ticks every minute and runs whichever monitors are due. On serverless hosting, disable it
 * with WEATHER_SCHEDULER=off and have a cron hit /api/cron/weather-monitors instead.
 */
export function startMonitorScheduler(): void {
  if (process.env.WEATHER_SCHEDULER === "off") return;
  const state = singleton<{ timer: NodeJS.Timeout | null }>("monitor-scheduler", () => ({ timer: null }));
  if (state.timer) return;

  const tick = () => {
    processDueMonitors().catch((error) => console.error("[weather-monitor] scheduled run failed", error));
  };
  state.timer = setInterval(tick, SCHEDULER_TICK_MS);
  // Never keep the process alive just for the scheduler.
  state.timer.unref();
}
