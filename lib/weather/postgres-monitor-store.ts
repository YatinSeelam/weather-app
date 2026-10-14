import postgres, { type JSONValue, type Sql, type TransactionSql } from "postgres";
import type { AlertStateRecord, RiskChange } from "./alert-change";
import { databaseCaCert } from "./config";
import { activeMonitorLimitError } from "./errors";
import type { CapacityOptions, MonitorRun, MonitorStore, WeatherMonitor } from "./monitor-store";
import type { EmailMode, MonitorInterval, RiskSelection, SeverityLevel, WeatherThresholds } from "./types";

/**
 * Saved monitors in Postgres (Supabase), for hosting where the local disk does not persist.
 * Schema: supabase/migrations/*_weather_monitor_store.sql. Same behavior as the JSON store:
 * the active-monitor cap is checked under an advisory lock, so concurrent requests cannot race it.
 */

const MAX_RUNS_PER_MONITOR = 50;
const CAPACITY_LOCK = "weather.monitors.active-cap";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPostgresClient(url: string, ca = databaseCaCert()): Sql {
  return postgres(url, {
    // Supabase's transaction pooler does not support prepared statements.
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    // Always verify the server certificate and hostname. Supabase signs with its own root CA
    // (DATABASE_CA_CERT); without it, connecting fails rather than trusting an unverified server.
    ssl: ca ? { ca, rejectUnauthorized: true } : "verify-full",
    onnotice: () => undefined,
  });
}

type Db = Sql | TransactionSql;

type MonitorRow = {
  id: string;
  user_id: string | null;
  name: string;
  zip_code: string;
  city: string;
  state: string;
  center_lat: number;
  center_lng: number;
  radius_miles: number;
  interval_minutes: number;
  enabled: boolean;
  risk_types: string[];
  thresholds: Partial<WeatherThresholds>;
  emails: string[];
  email_mode: string;
  created_at: Date;
  updated_at: Date;
  last_checked_at: Date | null;
  last_successful_check_at: Date | null;
  next_check_at: Date;
  last_run: MonitorRun | null;
};

type AlertStateRow = {
  monitor_id: string;
  id: string;
  external_alert_id: string;
  alert_type: string;
  severity: string;
  first_seen_at: Date;
  last_seen_at: Date;
  expires_at: Date | null;
  status: AlertStateRecord["status"];
  fingerprint: string;
  payload: AlertStateRecord["payload"];
};

type RunRow = {
  id: string;
  monitor_id: string;
  started_at: Date;
  completed_at: Date;
  status: MonitorRun["status"];
  active_risk_count: number;
  highest_severity: string | null;
  error_summary: string | null;
  changes: RiskChange[];
};

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

function toMonitor(row: MonitorRow): WeatherMonitor {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    zipCode: row.zip_code,
    city: row.city,
    state: row.state,
    centerLat: row.center_lat,
    centerLng: row.center_lng,
    radiusMiles: row.radius_miles,
    intervalMinutes: row.interval_minutes as MonitorInterval,
    enabled: row.enabled,
    riskTypes: row.risk_types as RiskSelection[],
    thresholds: row.thresholds,
    emails: row.emails,
    emailMode: row.email_mode as EmailMode,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastCheckedAt: isoOrNull(row.last_checked_at),
    lastSuccessfulCheckAt: isoOrNull(row.last_successful_check_at),
    nextCheckAt: iso(row.next_check_at),
    lastRun: row.last_run,
  };
}

function toAlertState(row: AlertStateRow): AlertStateRecord {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    externalAlertId: row.external_alert_id,
    alertType: row.alert_type,
    severity: row.severity as SeverityLevel,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    expiresAt: isoOrNull(row.expires_at),
    status: row.status,
    fingerprint: row.fingerprint,
    payload: row.payload,
  };
}

function toRun(row: RunRow): MonitorRun {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    status: row.status,
    activeRiskCount: row.active_risk_count,
    highestSeverity: row.highest_severity as SeverityLevel | null,
    errorSummary: row.error_summary,
    changes: row.changes,
  };
}

const json = (db: Db, value: unknown) => db.json(value as JSONValue);

/** Writes the whole monitor: insert, or replace every column of the existing row. */
async function saveMonitor(db: Db, m: WeatherMonitor): Promise<void> {
  await db`
    insert into weather.monitors (
      id, user_id, name, zip_code, city, state, center_lat, center_lng, radius_miles, interval_minutes,
      enabled, risk_types, thresholds, emails, email_mode, created_at, updated_at, last_checked_at,
      last_successful_check_at, next_check_at, last_run
    ) values (
      ${m.id}, ${m.userId}, ${m.name}, ${m.zipCode}, ${m.city}, ${m.state}, ${m.centerLat}, ${m.centerLng},
      ${m.radiusMiles}, ${m.intervalMinutes}, ${m.enabled}, ${db.array(m.riskTypes)}, ${json(db, m.thresholds)},
      ${db.array(m.emails)}, ${m.emailMode}, ${m.createdAt}, ${m.updatedAt}, ${m.lastCheckedAt},
      ${m.lastSuccessfulCheckAt ?? null}, ${m.nextCheckAt}, ${m.lastRun ? json(db, m.lastRun) : null}
    )
    on conflict (id) do update set
      user_id = excluded.user_id, name = excluded.name, zip_code = excluded.zip_code, city = excluded.city,
      state = excluded.state, center_lat = excluded.center_lat, center_lng = excluded.center_lng,
      radius_miles = excluded.radius_miles, interval_minutes = excluded.interval_minutes,
      enabled = excluded.enabled, risk_types = excluded.risk_types, thresholds = excluded.thresholds,
      emails = excluded.emails, email_mode = excluded.email_mode, updated_at = excluded.updated_at,
      last_checked_at = excluded.last_checked_at, last_successful_check_at = excluded.last_successful_check_at,
      next_check_at = excluded.next_check_at, last_run = excluded.last_run
  `;
}

/** Holds the cap lock until the transaction ends, then counts. */
async function assertRoomForActiveMonitor(tx: TransactionSql, maxActive: number | undefined): Promise<void> {
  if (maxActive === undefined) return;
  await tx`select pg_advisory_xact_lock(hashtext(${CAPACITY_LOCK}))`;
  const [{ count }] = await tx<{ count: number }[]>`select count(*)::int as count from weather.monitors where enabled`;
  if (count >= maxActive) throw activeMonitorLimitError(maxActive);
}

export class PostgresMonitorStore implements MonitorStore {
  readonly kind = "postgres";

  constructor(private readonly sql: Sql) {}

  async listMonitors() {
    const rows = await this.sql<MonitorRow[]>`select * from weather.monitors order by created_at desc`;
    return rows.map(toMonitor);
  }

  async getMonitor(id: string) {
    if (!UUID.test(id)) return null;
    const [row] = await this.sql<MonitorRow[]>`select * from weather.monitors where id = ${id}`;
    return row ? toMonitor(row) : null;
  }

  async createMonitor(monitor: WeatherMonitor, options: CapacityOptions = {}) {
    await this.sql.begin(async (tx) => {
      if (monitor.enabled) await assertRoomForActiveMonitor(tx, options.maxActive);
      await saveMonitor(tx, monitor);
    });
    return monitor;
  }

  async updateMonitor(id: string, patch: Partial<Omit<WeatherMonitor, "id">>, options: CapacityOptions = {}) {
    if (!UUID.test(id)) return null;
    // Row lock: a PATCH and a scheduled run touching the same monitor apply one after the other.
    return this.sql.begin(async (tx) => {
      const [row] = await tx<MonitorRow[]>`select * from weather.monitors where id = ${id} for update`;
      if (!row) return null;
      const existing = toMonitor(row);
      if (patch.enabled === true && !existing.enabled) await assertRoomForActiveMonitor(tx, options.maxActive);
      const next: WeatherMonitor = { ...existing, ...patch };
      await saveMonitor(tx, next);
      return next;
    });
  }

  async deleteMonitor(id: string) {
    if (!UUID.test(id)) return false;
    // Alert states and runs go with it (on delete cascade).
    const result = await this.sql`delete from weather.monitors where id = ${id}`;
    return result.count > 0;
  }

  async getAlertStates(monitorId: string) {
    const rows = await this.sql<AlertStateRow[]>`select * from weather.alert_states where monitor_id = ${monitorId}`;
    return rows.map(toAlertState);
  }

  async replaceAlertStates(monitorId: string, states: AlertStateRecord[]) {
    await this.sql.begin(async (tx) => {
      await tx`delete from weather.alert_states where monitor_id = ${monitorId}`;
      for (const s of states) {
        await tx`
          insert into weather.alert_states (
            monitor_id, id, external_alert_id, alert_type, severity, first_seen_at, last_seen_at, expires_at,
            status, fingerprint, payload
          ) values (
            ${monitorId}, ${s.id}, ${s.externalAlertId}, ${s.alertType}, ${s.severity}, ${s.firstSeenAt},
            ${s.lastSeenAt}, ${s.expiresAt}, ${s.status}, ${s.fingerprint}, ${json(tx, s.payload)}
          )
        `;
      }
    });
  }

  async appendRun(run: MonitorRun) {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into weather.monitor_runs (
          id, monitor_id, started_at, completed_at, status, active_risk_count, highest_severity, error_summary, changes
        ) values (
          ${run.id}, ${run.monitorId}, ${run.startedAt}, ${run.completedAt}, ${run.status}, ${run.activeRiskCount},
          ${run.highestSeverity}, ${run.errorSummary}, ${json(tx, run.changes)}
        )
      `;
      await tx`
        delete from weather.monitor_runs
        where monitor_id = ${run.monitorId}
          and id not in (
            select id from weather.monitor_runs where monitor_id = ${run.monitorId}
            order by completed_at desc limit ${MAX_RUNS_PER_MONITOR}
          )
      `;
    });
  }

  async listRuns(monitorId: string, limit = 20) {
    const rows = await this.sql<RunRow[]>`
      select * from weather.monitor_runs where monitor_id = ${monitorId} order by completed_at desc limit ${limit}
    `;
    return rows.map(toRun);
  }
}
