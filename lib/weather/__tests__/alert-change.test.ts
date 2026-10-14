import { describe, expect, it } from "vitest";
import {
  classifyAlertChange,
  reconcileAlertStates,
  toTrackedRisks,
  type AlertStateRecord,
  type TrackedRisk,
} from "../alert-change";
import type { DetectedWeatherRisk, WeatherAlert } from "../types";

const T0 = new Date("2026-10-06T20:00:00Z");
const T1 = new Date("2026-10-06T20:15:00Z");
const T2 = new Date("2026-10-06T20:30:00Z");

const tracked = (overrides: Partial<TrackedRisk> = {}): TrackedRisk => ({
  key: "urn:oid:tornado-1",
  supersedes: [],
  kind: "official-alert",
  alertType: "Tornado Warning",
  level: "critical",
  title: "Tornado Warning",
  detail: "Ulster, NY",
  expiresAt: "2026-10-06T21:00:00Z",
  fingerprint: "Tornado Warning|critical|Ulster, NY|2026-10-06T21:00:00Z",
  ...overrides,
});

const alert = (overrides: Partial<WeatherAlert> = {}): WeatherAlert => ({
  id: "urn:oid:flood-1",
  source: "NWS",
  category: "official-alert",
  event: "Flood Warning",
  rawEvent: "Flood Warning",
  headline: "Flood Warning issued October 6 at 4:00PM EDT",
  level: "high",
  severity: "Severe",
  areaDescription: "Ulster, NY",
  ends: "2026-10-07T02:00:00Z",
  geometry: null,
  geometrySource: "nws-zones",
  anchor: null,
  distanceMiles: 12,
  riskType: "flood",
  references: [],
  ...overrides,
});

const detected = (overrides: Partial<DetectedWeatherRisk> = {}): DetectedWeatherRisk => ({
  id: "freezing:ALY:1,1",
  category: "detected-risk",
  riskType: "freezing",
  severity: "moderate",
  title: "Freezing temperatures",
  description: "Low of 27°F in the next 12 hours.",
  latitude: 42,
  longitude: -74,
  locationLabel: "Near Kingston, NY",
  distanceMiles: 14,
  detectedAt: T0.toISOString(),
  source: "NWS forecast grid ALY:1,1",
  ...overrides,
});

const state = (overrides: Partial<AlertStateRecord> = {}) => ({
  severity: "high" as const,
  fingerprint: "a",
  status: "active" as const,
  ...overrides,
});

describe("classifyAlertChange", () => {
  it("is NEW when the alert has not been seen before", () => {
    expect(classifyAlertChange(null, { level: "high", fingerprint: "a" })).toBe("NEW");
  });

  it("is UNCHANGED when nothing material changed", () => {
    expect(classifyAlertChange(state(), { level: "high", fingerprint: "a" })).toBe("UNCHANGED");
  });

  it("is ESCALATED when severity increases", () => {
    expect(classifyAlertChange(state({ severity: "moderate" }), { level: "critical", fingerprint: "a" })).toBe(
      "ESCALATED",
    );
  });

  it("is UPDATED when a material field changes without a severity increase", () => {
    expect(classifyAlertChange(state(), { level: "high", fingerprint: "b" })).toBe("UPDATED");
    expect(classifyAlertChange(state(), { level: "moderate", fingerprint: "b" })).toBe("UPDATED");
  });

  it("is EXPIRED when an active alert disappears", () => {
    expect(classifyAlertChange(state(), null)).toBe("EXPIRED");
  });

  it("does not expire something that already expired, and treats its return as NEW", () => {
    expect(classifyAlertChange(state({ status: "expired" }), null)).toBe("UNCHANGED");
    expect(classifyAlertChange(state({ status: "expired" }), { level: "high", fingerprint: "a" })).toBe("NEW");
  });
});

describe("toTrackedRisks", () => {
  it("tracks one unit per official alert and one per detected risk type", () => {
    const risks = toTrackedRisks({
      officialAlerts: [alert(), alert({ id: "urn:oid:flood-2", areaDescription: "Greene, NY" })],
      detectedRisks: [
        detected({ severity: "high", id: "freezing:ALY:1,1" }),
        detected({ id: "freezing:ALY:2,2" }),
        detected({ id: "freezing:ALY:3,3" }),
        detected({ id: "high-wind:ALY:1,1", riskType: "high-wind", title: "High wind" }),
      ],
    });
    expect(risks.map((risk) => risk.key)).toEqual([
      "urn:oid:flood-1",
      "urn:oid:flood-2",
      "detected:freezing",
      "detected:high-wind",
    ]);
    expect(risks[2]).toMatchObject({ level: "high", kind: "detected-risk" });
    expect(risks[2].detail).toContain("3 sampled locations");
  });

  it("keeps the fingerprint stable across routine re-issues", () => {
    const first = toTrackedRisks({ officialAlerts: [alert()], detectedRisks: [] })[0];
    const reissued = toTrackedRisks({
      officialAlerts: [alert({ headline: "Flood Warning issued October 6 at 4:45PM EDT", expires: "2026-10-06T23:00:00Z" })],
      detectedRisks: [],
    })[0];
    expect(reissued.fingerprint).toBe(first.fingerprint);
  });

  it("changes the fingerprint when the affected area or end time changes", () => {
    const base = toTrackedRisks({ officialAlerts: [alert()], detectedRisks: [] })[0].fingerprint;
    const widerArea = toTrackedRisks({
      officialAlerts: [alert({ areaDescription: "Ulster, NY; Dutchess, NY" })],
      detectedRisks: [],
    })[0].fingerprint;
    const extended = toTrackedRisks({ officialAlerts: [alert({ ends: "2026-10-07T08:00:00Z" })], detectedRisks: [] })[0]
      .fingerprint;
    expect(widerArea).not.toBe(base);
    expect(extended).not.toBe(base);
  });

  it("ignores how many sample points a detected risk covers", () => {
    const three = toTrackedRisks({ officialAlerts: [], detectedRisks: [detected(), detected({ id: "b" }), detected({ id: "c" })] });
    const four = toTrackedRisks({
      officialAlerts: [],
      detectedRisks: [detected(), detected({ id: "b" }), detected({ id: "c" }), detected({ id: "d" })],
    });
    expect(four[0].fingerprint).toBe(three[0].fingerprint);
  });
});

describe("reconcileAlertStates (duplicate notification prevention)", () => {
  it("reports an alert as NEW once, then UNCHANGED on every later check", () => {
    const first = reconcileAlertStates("m1", [], [tracked()], T0);
    expect(first.changes.map((c) => c.change)).toEqual(["NEW"]);

    const second = reconcileAlertStates("m1", first.states, [tracked()], T1);
    expect(second.changes.map((c) => c.change)).toEqual(["UNCHANGED"]);

    const third = reconcileAlertStates("m1", second.states, [tracked()], T2);
    expect(third.changes.map((c) => c.change)).toEqual(["UNCHANGED"]);
    expect(third.states[0]).toMatchObject({
      externalAlertId: "urn:oid:tornado-1",
      firstSeenAt: T0.toISOString(),
      lastSeenAt: T2.toISOString(),
      status: "active",
    });
  });

  it("follows NWS update chains instead of treating a re-issued alert as new", () => {
    const first = reconcileAlertStates("m1", [], [tracked()], T0);
    const reissued = tracked({ key: "urn:oid:tornado-2", supersedes: ["urn:oid:tornado-1"] });
    const second = reconcileAlertStates("m1", first.states, [reissued], T1);

    expect(second.changes.map((c) => c.change)).toEqual(["UNCHANGED"]);
    expect(second.states).toHaveLength(1);
    expect(second.states[0]).toMatchObject({
      id: first.states[0].id,
      externalAlertId: "urn:oid:tornado-2",
      firstSeenAt: T0.toISOString(),
    });
  });

  it("reports ESCALATED when a superseding alert is more severe", () => {
    const watch = tracked({ key: "w1", level: "high", fingerprint: "watch" });
    const first = reconcileAlertStates("m1", [], [watch], T0);
    const warning = tracked({ key: "w2", supersedes: ["w1"], level: "critical", fingerprint: "warning" });
    expect(reconcileAlertStates("m1", first.states, [warning], T1).changes[0].change).toBe("ESCALATED");
  });

  it("reports UPDATED when a new area becomes affected", () => {
    const first = reconcileAlertStates("m1", [], [tracked()], T0);
    const wider = tracked({ fingerprint: "Tornado Warning|critical|Ulster, NY; Greene, NY|2026-10-06T21:00:00Z" });
    expect(reconcileAlertStates("m1", first.states, [wider], T1).changes[0].change).toBe("UPDATED");
  });

  it("reports EXPIRED once when an alert ends, then stays quiet", () => {
    const first = reconcileAlertStates("m1", [], [tracked()], T0);
    const second = reconcileAlertStates("m1", first.states, [], T1);
    expect(second.changes).toMatchObject([{ change: "EXPIRED", key: "urn:oid:tornado-1" }]);
    expect(second.states[0].status).toBe("expired");

    const third = reconcileAlertStates("m1", second.states, [], T2);
    expect(third.changes).toEqual([]);
  });

  it("treats an alert that returns after expiring as NEW", () => {
    const first = reconcileAlertStates("m1", [], [tracked()], T0);
    const second = reconcileAlertStates("m1", first.states, [], T1);
    const third = reconcileAlertStates("m1", second.states, [tracked()], T2);
    expect(third.changes.map((c) => c.change)).toEqual(["NEW"]);
    expect(third.states).toHaveLength(1);
  });

  it("drops expired state after the retention period", () => {
    const first = reconcileAlertStates("m1", [], [tracked()], T0);
    const second = reconcileAlertStates("m1", first.states, [], T1);
    const muchLater = new Date(T1.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(reconcileAlertStates("m1", second.states, [], muchLater).states).toEqual([]);
  });

  it("handles several alerts changing independently", () => {
    const a = tracked({ key: "a", fingerprint: "a" });
    const b = tracked({ key: "b", fingerprint: "b", level: "moderate" });
    const first = reconcileAlertStates("m1", [], [a, b], T0);
    const c = tracked({ key: "c", fingerprint: "c" });
    const second = reconcileAlertStates("m1", first.states, [a, { ...b, level: "high" }, c], T1);
    expect(Object.fromEntries(second.changes.map((change) => [change.key, change.change]))).toEqual({
      a: "UNCHANGED",
      b: "ESCALATED",
      c: "NEW",
    });
  });
});
