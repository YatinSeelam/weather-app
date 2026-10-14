import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeatherError } from "../errors";
import { processDueMonitors, runMonitor, type RunnerDependencies } from "../monitor-runner";
import { computeNextCheckAt, isMonitorDue, selectDueMonitors } from "../monitor-schedule";
import { JsonFileMonitorStore, type WeatherMonitor } from "../monitor-store";
import { shouldNotify, type MonitorUpdate } from "../notifications";
import { summarize } from "../weather-service";
import type { CoverageStatus, WeatherAlert, WeatherCheckResult } from "../types";

const NOW = new Date("2026-10-06T20:00:00Z");
const minutesAfter = (minutes: number, from = NOW) => new Date(from.getTime() + minutes * 60_000);

const monitor = (overrides: Partial<WeatherMonitor> = {}): WeatherMonitor => ({
  id: "m1",
  userId: null,
  name: "Saugerties, NY · 100 mi",
  zipCode: "12477",
  city: "Saugerties",
  state: "NY",
  centerLat: 42.0738,
  centerLng: -73.9797,
  radiusMiles: 100,
  intervalMinutes: 60,
  enabled: true,
  riskTypes: ["tornado", "flood"],
  thresholds: {},
  emails: ["ops@example.com"],
  emailMode: "changes-only",
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  lastCheckedAt: null,
  nextCheckAt: NOW.toISOString(),
  lastRun: null,
  ...overrides,
});

const tornadoWarning: WeatherAlert = {
  id: "urn:oid:tornado-1",
  source: "NWS",
  category: "official-alert",
  event: "Tornado Warning",
  rawEvent: "Tornado Warning",
  headline: "Tornado Warning",
  level: "critical",
  areaDescription: "Ulster, NY",
  ends: minutesAfter(45).toISOString(),
  geometry: null,
  geometrySource: "nws-polygon",
  anchor: null,
  distanceMiles: 26,
  riskType: "tornado",
  references: [],
};

const checkResult = (
  alerts: WeatherAlert[],
  warnings: string[] = [],
  forecasts: CoverageStatus = "complete",
): WeatherCheckResult => ({
  center: { zipCode: "12477", city: "Saugerties", state: "NY", latitude: 42.0738, longitude: -73.9797 },
  radiusMiles: 100,
  risks: ["tornado", "flood"],
  checkedAt: NOW.toISOString(),
  officialAlerts: alerts,
  detectedRisks: [],
  sampling: { requestedPoints: 0, successfulPoints: 0, failedPoints: 0, outsideCoveragePoints: 0 },
  summary: summarize(alerts, []),
  warnings,
  notes: [],
  source: {
    live: true,
    providers: {
      alerts: "NOAA / National Weather Service",
      forecasts: "NOAA / National Weather Service",
      geocoding: "Zippopotam.us",
      map: "OpenFreeMap / OpenStreetMap",
    },
    hosts: { nws: "api.weather.gov", geocoding: "api.zippopotam.us" },
    checkedAt: NOW.toISOString(),
    fetchedAt: NOW.toISOString(),
    nwsAlertsReceived: alerts.length,
    coverage: { alerts: "complete", forecasts },
  },
});

describe("monitor scheduling", () => {
  it("schedules the next check one interval after the run", () => {
    expect(computeNextCheckAt(NOW, 15).toISOString()).toBe("2026-10-06T20:15:00.000Z");
    expect(computeNextCheckAt(NOW, 60).toISOString()).toBe("2026-10-06T21:00:00.000Z");
    expect(computeNextCheckAt(NOW, 180).toISOString()).toBe("2026-10-06T23:00:00.000Z");
  });

  it("treats a monitor as due once its next check time arrives", () => {
    expect(isMonitorDue(monitor({ nextCheckAt: minutesAfter(-1).toISOString() }), NOW)).toBe(true);
    expect(isMonitorDue(monitor({ nextCheckAt: NOW.toISOString() }), NOW)).toBe(true);
    expect(isMonitorDue(monitor({ nextCheckAt: minutesAfter(1).toISOString() }), NOW)).toBe(false);
  });

  it("never runs a disabled monitor", () => {
    expect(isMonitorDue(monitor({ enabled: false, nextCheckAt: minutesAfter(-60).toISOString() }), NOW)).toBe(false);
  });

  it("selects only due monitors, most overdue first", () => {
    const due = selectDueMonitors(
      [
        monitor({ id: "later", nextCheckAt: minutesAfter(30).toISOString() }),
        monitor({ id: "slightly-late", nextCheckAt: minutesAfter(-2).toISOString() }),
        monitor({ id: "disabled", enabled: false, nextCheckAt: minutesAfter(-90).toISOString() }),
        monitor({ id: "very-late", nextCheckAt: minutesAfter(-45).toISOString() }),
      ],
      NOW,
    );
    expect(due.map((m) => m.id)).toEqual(["very-late", "slightly-late"]);
  });

  it("lets one 15-minute worker serve every frequency", () => {
    const every15 = monitor({ id: "15", intervalMinutes: 15 });
    const hourly = monitor({ id: "60", intervalMinutes: 60 });
    const threeHourly = monitor({ id: "180", intervalMinutes: 180 });
    const fleet = [every15, hourly, threeHourly];
    const runsPerMonitor: Record<string, number> = { "15": 0, "60": 0, "180": 0 };

    // Simulate three hours of ticks, one every 15 minutes.
    for (let tick = 0; tick < 12; tick++) {
      const tickTime = minutesAfter(tick * 15);
      for (const due of selectDueMonitors(fleet, tickTime)) {
        runsPerMonitor[due.id]++;
        due.nextCheckAt = computeNextCheckAt(tickTime, due.intervalMinutes).toISOString();
      }
    }
    expect(runsPerMonitor).toEqual({ "15": 12, "60": 3, "180": 1 });
  });
});

describe("monitor runner", () => {
  let directory: string;
  let store: JsonFileMonitorStore;
  let sent: MonitorUpdate[];
  let check: ReturnType<typeof vi.fn<RunnerDependencies["check"]>>;
  let deps: RunnerDependencies;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "weather-monitors-"));
    store = new JsonFileMonitorStore(path.join(directory, "monitors.json"));
    sent = [];
    check = vi.fn<RunnerDependencies["check"]>();
    deps = {
      store,
      check,
      notifier: { name: "test", notify: async (update) => void sent.push(update) },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("notifies once for a new alert and not again while it is unchanged", async () => {
    await store.createMonitor(monitor());
    check.mockResolvedValue(checkResult([tornadoWarning]));

    const first = await runMonitor((await store.getMonitor("m1"))!, NOW, deps);
    expect(first).toMatchObject({ status: "ok", activeRiskCount: 1, highestSeverity: "critical" });
    expect(sent).toHaveLength(1);
    expect(sent[0].changes.map((c) => c.change)).toEqual(["NEW"]);
    expect(sent[0].activeRisks.map((r) => r.title)).toEqual(["Tornado Warning"]);
    expect(sent[0].monitor.emails).toEqual(["ops@example.com"]);

    await runMonitor((await store.getMonitor("m1"))!, minutesAfter(15), deps);
    await runMonitor((await store.getMonitor("m1"))!, minutesAfter(30), deps);
    expect(sent).toHaveLength(1);
  });

  it("records the run and schedules the next check from the monitor's interval", async () => {
    await store.createMonitor(monitor({ intervalMinutes: 180 }));
    check.mockResolvedValue(checkResult([]));

    await runMonitor((await store.getMonitor("m1"))!, NOW, deps);
    const saved = (await store.getMonitor("m1"))!;
    expect(saved.nextCheckAt).toBe("2026-10-06T23:00:00.000Z");
    expect(saved.lastCheckedAt).not.toBeNull();
    expect(saved.lastRun).toMatchObject({ status: "ok", activeRiskCount: 0, highestSeverity: null });
    expect(await store.listRuns("m1")).toHaveLength(1);
    expect(check).toHaveBeenCalledWith(
      { zipCode: "12477", radiusMiles: 100, risks: ["tornado", "flood"], thresholds: {} },
      NOW,
    );
  });

  it("marks a run with missing data as partial", async () => {
    await store.createMonitor(monitor());
    check.mockResolvedValue(checkResult([], ["Weather data was unavailable for 3 of 37 sample locations."], "partial"));
    const run = await runMonitor((await store.getMonitor("m1"))!, NOW, deps);
    expect(run).toMatchObject({ status: "partial", errorSummary: "Weather data was unavailable for 3 of 37 sample locations." });
    expect((await store.getMonitor("m1"))!.lastSuccessfulCheckAt).toBe(run.completedAt);
  });

  it("keeps alert state through an outage so recovery does not re-notify", async () => {
    await store.createMonitor(monitor());
    check.mockResolvedValueOnce(checkResult([tornadoWarning]));
    await runMonitor((await store.getMonitor("m1"))!, NOW, deps);

    check.mockRejectedValueOnce(new WeatherError("NWS_UNAVAILABLE", "The National Weather Service returned 503."));
    const failed = await runMonitor((await store.getMonitor("m1"))!, minutesAfter(15), deps);
    expect(failed).toMatchObject({ status: "failed", errorSummary: "The National Weather Service returned 503." });
    // The attempt is recorded, but the last successful check still points at the earlier run.
    const afterFailure = (await store.getMonitor("m1"))!;
    expect(afterFailure.lastCheckedAt).toBe(failed.completedAt);
    expect(afterFailure.lastSuccessfulCheckAt).not.toBe(failed.completedAt);
    expect(afterFailure.lastSuccessfulCheckAt).toBeTruthy();
    expect((await store.getAlertStates("m1"))[0].status).toBe("active");
    expect((await store.getMonitor("m1"))!.nextCheckAt).toBe(minutesAfter(75).toISOString());

    check.mockResolvedValueOnce(checkResult([tornadoWarning]));
    await runMonitor((await store.getMonitor("m1"))!, minutesAfter(30), deps);
    expect(sent.flatMap((n) => n.changes.map((c) => c.change))).toEqual(["NEW"]);
  });

  it("records an expiry without sending a notification for it", async () => {
    await store.createMonitor(monitor());
    check.mockResolvedValueOnce(checkResult([tornadoWarning])).mockResolvedValueOnce(checkResult([]));
    await runMonitor((await store.getMonitor("m1"))!, NOW, deps);
    const second = await runMonitor((await store.getMonitor("m1"))!, minutesAfter(60), deps);
    expect(second.changes.map((c) => c.change)).toEqual(["EXPIRED"]);
    expect(sent).toHaveLength(1);
  });

  it("survives a notification provider that throws", async () => {
    await store.createMonitor(monitor());
    check.mockResolvedValue(checkResult([tornadoWarning]));
    deps.notifier = { name: "broken", notify: async () => Promise.reject(new Error("Email gateway down")) };
    const run = await runMonitor((await store.getMonitor("m1"))!, NOW, deps);
    expect(run.status).toBe("ok");
  });

  it("sends an update after every run, even a failed one, when the monitor asks for every check", async () => {
    await store.createMonitor(monitor({ emailMode: "every-check" }));
    check.mockResolvedValueOnce(checkResult([])).mockResolvedValueOnce(checkResult([]));
    await runMonitor((await store.getMonitor("m1"))!, NOW, deps);
    await runMonitor((await store.getMonitor("m1"))!, minutesAfter(60), deps);
    expect(sent).toHaveLength(2);
    expect(sent[1].changes).toEqual([]);
    expect(sent[1].activeRisks).toEqual([]);

    check.mockRejectedValueOnce(new WeatherError("NWS_UNAVAILABLE", "The National Weather Service returned 503."));
    await runMonitor((await store.getMonitor("m1"))!, minutesAfter(120), deps);
    expect(sent).toHaveLength(3);
    expect(sent[2].run).toMatchObject({ status: "failed", errorSummary: "The National Weather Service returned 503." });
  });

  it("decides when to notify from the email mode", () => {
    expect(shouldNotify({ emailMode: "every-check" }, [])).toBe(true);
    expect(shouldNotify({ emailMode: "changes-only" }, [])).toBe(false);
    expect(shouldNotify({ emailMode: "changes-only" }, [{ change: "EXPIRED" }])).toBe(false);
    expect(shouldNotify({ emailMode: "changes-only" }, [{ change: "EXPIRED" }, { change: "UPDATED" }])).toBe(true);
  });

  it("processes only the monitors that are due", async () => {
    await store.createMonitor(monitor({ id: "due" }));
    await store.createMonitor(monitor({ id: "not-yet", nextCheckAt: minutesAfter(20).toISOString() }));
    await store.createMonitor(monitor({ id: "paused", enabled: false }));
    check.mockResolvedValue(checkResult([]));

    const report = await processDueMonitors(NOW, deps);
    expect(report).toMatchObject({ skipped: false, dueCount: 1 });
    expect(report.runs.map((run) => run.monitorId)).toEqual(["due"]);
    expect(check).toHaveBeenCalledTimes(1);

    // Nothing is due again until the interval has passed.
    expect((await processDueMonitors(minutesAfter(5), deps)).dueCount).toBe(0);
  });
});

describe("monitor store", () => {
  let directory: string;
  let store: JsonFileMonitorStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "weather-store-"));
    await mkdir(path.join(directory, "nested"));
    store = new JsonFileMonitorStore(path.join(directory, "nested", "monitors.json"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("starts empty and persists monitors across instances", async () => {
    expect(await store.listMonitors()).toEqual([]);
    await store.createMonitor(monitor());
    const reopened = new JsonFileMonitorStore(path.join(directory, "nested", "monitors.json"));
    expect((await reopened.listMonitors()).map((m) => m.id)).toEqual(["m1"]);
  });

  it("updates, disables and deletes a monitor along with its history", async () => {
    await store.createMonitor(monitor());
    expect((await store.updateMonitor("m1", { enabled: false, intervalMinutes: 15 }))?.enabled).toBe(false);
    expect(await store.updateMonitor("missing", { enabled: false })).toBeNull();

    await store.appendRun({
      id: "r1",
      monitorId: "m1",
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      status: "ok",
      activeRiskCount: 0,
      highestSeverity: null,
      errorSummary: null,
      changes: [],
    });
    expect(await store.deleteMonitor("m1")).toBe(true);
    expect(await store.deleteMonitor("m1")).toBe(false);
    expect(await store.listRuns("m1")).toEqual([]);
  });

  it("fills in email fields for monitors saved before email support", async () => {
    const legacy: Partial<WeatherMonitor> = monitor();
    delete legacy.emails;
    delete legacy.emailMode;
    await writeFile(
      path.join(directory, "nested", "monitors.json"),
      JSON.stringify({ version: 1, monitors: [legacy], alertStates: [], runs: [] }),
    );
    expect((await store.getMonitor("m1"))).toMatchObject({ emails: [], emailMode: "every-check" });
  });

  it("does not lose writes made at the same time", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.createMonitor(monitor({ id: `m${index}` }))));
    expect(await store.listMonitors()).toHaveLength(20);
  });
});
