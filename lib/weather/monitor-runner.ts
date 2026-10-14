import { randomUUID } from "node:crypto";
import { reconcileAlertStates, toTrackedRisks } from "./alert-change";
import { singleton } from "./concurrency";
import { isCheckComplete } from "./coverage";
import { computeNextCheckAt, selectDueMonitors } from "./monitor-schedule";
import { getMonitorStore, type MonitorRun, type MonitorStore, type WeatherMonitor } from "./monitor-store";
import { getNotificationProvider, shouldNotify, type MonitorUpdate, type WeatherNotificationProvider } from "./notifications";
import type { WeatherCheckResult } from "./types";
import { checkWeather, type CheckWeatherInput } from "./weather-service";

export type RunnerDependencies = {
  store: MonitorStore;
  check: (input: CheckWeatherInput, now: Date) => Promise<WeatherCheckResult>;
  notifier: WeatherNotificationProvider;
};

const defaultDependencies = (): RunnerDependencies => ({
  store: getMonitorStore(),
  check: checkWeather,
  notifier: getNotificationProvider(),
});

/**
 * Runs one monitor: check the weather, work out what changed since the last run, send one
 * update (every run, or only when something changed, per the monitor), and schedule the next check.
 */
export async function runMonitor(
  monitor: WeatherMonitor,
  now: Date = new Date(),
  deps: RunnerDependencies = defaultDependencies(),
): Promise<MonitorRun> {
  const startedAt = now.toISOString();
  let run: MonitorRun;
  let activeRisks: MonitorUpdate["activeRisks"] = [];

  try {
    const result = await deps.check(
      {
        zipCode: monitor.zipCode,
        radiusMiles: monitor.radiusMiles,
        risks: monitor.riskTypes,
        thresholds: monitor.thresholds,
      },
      now,
    );

    const previous = await deps.store.getAlertStates(monitor.id);
    const { states, changes } = reconcileAlertStates(monitor.id, previous, toTrackedRisks(result), now);
    await deps.store.replaceAlertStates(monitor.id, states);

    const notable = changes.filter((change) => change.change !== "UNCHANGED");
    activeRisks = states
      .filter((state) => state.status === "active")
      .map((state) => ({ key: state.externalAlertId, level: state.severity, ...state.payload }));

    const incomplete = !isCheckComplete(result.source);
    run = {
      id: randomUUID(),
      monitorId: monitor.id,
      startedAt,
      completedAt: new Date().toISOString(),
      status: incomplete ? "partial" : "ok",
      activeRiskCount: result.summary.totalActiveRisks,
      highestSeverity: result.summary.highestSeverity,
      errorSummary: incomplete ? result.warnings.join(" ") : null,
      changes: notable,
    };
  } catch (error) {
    // A failed check leaves the alert state untouched, so an outage is never mistaken
    // for "everything expired" followed by a burst of "new" alerts on recovery.
    run = {
      id: randomUUID(),
      monitorId: monitor.id,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "failed",
      activeRiskCount: monitor.lastRun?.activeRiskCount ?? 0,
      highestSeverity: monitor.lastRun?.highestSeverity ?? null,
      errorSummary: error instanceof Error ? error.message : "The weather check failed.",
      changes: [],
    };
  }

  if (shouldNotify(monitor, run.changes)) {
    try {
      await deps.notifier.notify({ monitor, run, changes: run.changes, activeRisks });
    } catch (error) {
      console.error(`[weather-monitor] ${deps.notifier.name} notification failed`, error);
    }
  }

  await deps.store.appendRun(run);
  await deps.store.updateMonitor(monitor.id, {
    lastCheckedAt: run.completedAt,
    ...(run.status === "failed" ? {} : { lastSuccessfulCheckAt: run.completedAt }),
    nextCheckAt: computeNextCheckAt(now, monitor.intervalMinutes).toISOString(),
    lastRun: run,
  });
  return run;
}

export type DueMonitorsReport = {
  skipped: boolean;
  dueCount: number;
  runs: Array<Pick<MonitorRun, "monitorId" | "status" | "activeRiskCount">>;
};

const workerState = () => singleton("monitor-worker", () => ({ running: false }));

/**
 * The single scheduled worker. Each tick it selects every enabled monitor whose
 * `nextCheckAt` has passed and runs them one after another — one worker for all monitors,
 * whatever their individual frequency. Overlapping ticks are skipped.
 */
export async function processDueMonitors(
  now: Date = new Date(),
  deps: RunnerDependencies = defaultDependencies(),
): Promise<DueMonitorsReport> {
  const state = workerState();
  if (state.running) return { skipped: true, dueCount: 0, runs: [] };
  state.running = true;
  try {
    const due = selectDueMonitors(await deps.store.listMonitors(), now);
    const runs: DueMonitorsReport["runs"] = [];
    for (const monitor of due) {
      const run = await runMonitor(monitor, now, deps);
      runs.push({ monitorId: run.monitorId, status: run.status, activeRiskCount: run.activeRiskCount });
    }
    return { skipped: false, dueCount: due.length, runs };
  } finally {
    state.running = false;
  }
}
