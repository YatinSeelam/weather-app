import { randomUUID } from "node:crypto";
import { highestSeverity, severityRank } from "./severity";
import type { DetectedRiskType, DetectedWeatherRisk, SeverityLevel, WeatherAlert, WeatherCheckResult } from "./types";

export type AlertChange = "NEW" | "UPDATED" | "ESCALATED" | "UNCHANGED" | "EXPIRED";

/** One thing a monitor can notify about, reduced to what matters for change detection. */
export type TrackedRisk = {
  /** NWS alert identifier, or "detected:<risk type>" for system-detected risks. */
  key: string;
  /** Earlier identifiers this replaces. NWS issues every update under a new identifier. */
  supersedes: string[];
  kind: "official-alert" | "detected-risk";
  alertType: string;
  level: SeverityLevel;
  title: string;
  detail: string;
  expiresAt: string | null;
  /** Changes only when something a person would want to hear about changes. */
  fingerprint: string;
};

/** Persisted per monitor; mirrors a `weather_monitor_alert_state` row. */
export type AlertStateRecord = {
  id: string;
  monitorId: string;
  externalAlertId: string;
  alertType: string;
  severity: SeverityLevel;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string | null;
  status: "active" | "expired";
  fingerprint: string;
  payload: Pick<TrackedRisk, "kind" | "title" | "detail">;
};

export type RiskChange = {
  change: AlertChange;
  key: string;
  kind: TrackedRisk["kind"];
  title: string;
  detail: string;
  level: SeverityLevel;
};

const EXPIRED_STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DETECTED_TITLES: Record<DetectedRiskType, string> = {
  freezing: "Freezing temperatures",
  "high-wind": "High wind",
  "heavy-rain": "Heavy rain",
};

function trackAlert(alert: WeatherAlert): TrackedRisk {
  const until = alert.ends ?? alert.expires ?? null;
  return {
    key: alert.id,
    supersedes: alert.references,
    kind: "official-alert",
    alertType: alert.event,
    level: alert.level,
    title: alert.event,
    detail: alert.areaDescription ?? alert.headline,
    expiresAt: until,
    // Deliberately excludes the headline and issue time, which change on every routine
    // re-issue. Area, end time and severity are the material fields.
    fingerprint: [alert.event, alert.level, alert.areaDescription ?? "", alert.ends ?? ""].join("|"),
  };
}

function trackDetectedGroup(riskType: DetectedRiskType, risks: DetectedWeatherRisk[]): TrackedRisk {
  const level = highestSeverity(risks.map((risk) => risk.severity)) ?? "low";
  const worst = risks[0];
  return {
    key: `detected:${riskType}`,
    supersedes: [],
    kind: "detected-risk",
    alertType: riskType,
    level,
    title: DETECTED_TITLES[riskType],
    detail: `${risks.length} sampled location${risks.length === 1 ? "" : "s"}. ${worst.locationLabel ?? "Worst reading"}: ${worst.description}`,
    expiresAt: null,
    // The number of affected sample points drifts from run to run and is not worth a notification.
    fingerprint: `${riskType}|${level}`,
  };
}

/**
 * Collapses a check result into the units notifications are tracked by: one per official
 * alert, and one per detected risk type (not one per sampled location).
 */
export function toTrackedRisks(result: Pick<WeatherCheckResult, "officialAlerts" | "detectedRisks">): TrackedRisk[] {
  const groups = new Map<DetectedRiskType, DetectedWeatherRisk[]>();
  for (const risk of result.detectedRisks) {
    groups.set(risk.riskType, [...(groups.get(risk.riskType) ?? []), risk]);
  }
  return [
    ...result.officialAlerts.map(trackAlert),
    ...[...groups.entries()].map(([riskType, risks]) => trackDetectedGroup(riskType, risks)),
  ];
}

/**
 * Decides whether a risk is worth telling someone about again.
 * - NEW: not seen before (or seen, expired, and back).
 * - ESCALATED: severity went up.
 * - UPDATED: area, end time or severity materially changed.
 * - UNCHANGED: same alert as last check, so stay quiet.
 * - EXPIRED: was active last check and is gone now.
 */
export function classifyAlertChange(
  previous: Pick<AlertStateRecord, "severity" | "fingerprint" | "status"> | null,
  current: Pick<TrackedRisk, "level" | "fingerprint"> | null,
): AlertChange {
  const wasActive = previous !== null && previous.status === "active";
  if (!current) return wasActive ? "EXPIRED" : "UNCHANGED";
  if (!wasActive) return "NEW";
  if (severityRank(current.level) > severityRank(previous.severity)) return "ESCALATED";
  if (current.fingerprint !== previous.fingerprint) return "UPDATED";
  return "UNCHANGED";
}

/**
 * Compares the previous state of a monitor with what is active now and returns the new
 * state plus every change (including UNCHANGED, so callers decide what to act on).
 */
export function reconcileAlertStates(
  monitorId: string,
  previousStates: AlertStateRecord[],
  current: TrackedRisk[],
  now: Date,
): { states: AlertStateRecord[]; changes: RiskChange[] } {
  const nowIso = now.toISOString();
  const active = new Map(previousStates.filter((s) => s.status === "active").map((s) => [s.externalAlertId, s]));
  const matched = new Set<string>();
  const states: AlertStateRecord[] = [];
  const changes: RiskChange[] = [];

  for (const risk of current) {
    const previous =
      active.get(risk.key) ?? risk.supersedes.map((id) => active.get(id)).find((state) => state !== undefined) ?? null;
    if (previous) matched.add(previous.externalAlertId);

    changes.push({
      change: classifyAlertChange(previous, risk),
      key: risk.key,
      kind: risk.kind,
      title: risk.title,
      detail: risk.detail,
      level: risk.level,
    });
    states.push({
      id: previous?.id ?? randomUUID(),
      monitorId,
      externalAlertId: risk.key,
      alertType: risk.alertType,
      severity: risk.level,
      firstSeenAt: previous?.firstSeenAt ?? nowIso,
      lastSeenAt: nowIso,
      expiresAt: risk.expiresAt,
      status: "active",
      fingerprint: risk.fingerprint,
      payload: { kind: risk.kind, title: risk.title, detail: risk.detail },
    });
  }

  const currentKeys = new Set(current.map((risk) => risk.key));
  for (const state of previousStates) {
    if (currentKeys.has(state.externalAlertId)) continue;
    if (state.status === "active" && !matched.has(state.externalAlertId)) {
      changes.push({
        change: classifyAlertChange(state, null),
        key: state.externalAlertId,
        kind: state.payload.kind,
        title: state.payload.title,
        detail: state.payload.detail,
        level: state.severity,
      });
      states.push({ ...state, status: "expired", lastSeenAt: nowIso });
    } else if (state.status === "expired" && now.getTime() - Date.parse(state.lastSeenAt) < EXPIRED_STATE_RETENTION_MS) {
      states.push(state);
    }
  }

  return { states, changes };
}
