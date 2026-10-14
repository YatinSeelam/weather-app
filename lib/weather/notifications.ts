import type { AlertChange, RiskChange, TrackedRisk } from "./alert-change";
import { singleton } from "./concurrency";
import { resendApiKey } from "./config";
import { ResendEmailProvider } from "./email";
import type { MonitorRun, WeatherMonitor } from "./monitor-store";

/** What a monitor can say about itself after one scheduled run. */
export type MonitorUpdate = {
  monitor: Pick<WeatherMonitor, "id" | "name" | "zipCode" | "radiusMiles" | "intervalMinutes" | "emails" | "emailMode">;
  run: Pick<MonitorRun, "status" | "activeRiskCount" | "highestSeverity" | "errorSummary" | "completedAt">;
  /** What changed since the previous run, never UNCHANGED. */
  changes: RiskChange[];
  /** Everything active right now, so a recipient sees the whole picture and not only the delta. */
  activeRisks: Array<Pick<TrackedRisk, "key" | "kind" | "title" | "detail" | "level">>;
};

/**
 * Provider-neutral delivery interface. The runner hands over one update per run; the provider
 * decides who to tell (for email: `monitor.emails`) and how. Register with `setNotificationProvider`.
 */
export interface WeatherNotificationProvider {
  readonly name: string;
  notify(update: MonitorUpdate): Promise<void>;
}

/** Which kinds of change are worth interrupting someone for. */
export const NOTIFY_ON: ReadonlySet<AlertChange> = new Set<AlertChange>(["NEW", "ESCALATED", "UPDATED"]);

/**
 * "every-check" is the schedule-as-trigger mode: an update after every run, including a failed
 * one (silence would otherwise look like calm weather). "changes-only" waits for something new.
 */
export function shouldNotify(
  monitor: Pick<WeatherMonitor, "emailMode">,
  changes: ReadonlyArray<Pick<RiskChange, "change">>,
): boolean {
  if (monitor.emailMode === "every-check") return true;
  return changes.some((change) => NOTIFY_ON.has(change.change));
}

/** Default provider when no email key is configured: writes to the server log. */
export class LogNotificationProvider implements WeatherNotificationProvider {
  readonly name = "log";

  async notify({ monitor, run, changes }: MonitorUpdate): Promise<void> {
    const changed = changes.map((change) => `${change.change} ${change.level.toUpperCase()} "${change.title}"`);
    console.info(
      `[weather-monitor] ${monitor.name} (${monitor.zipCode}, ${monitor.radiusMiles} mi): ${run.status}, ${run.activeRiskCount} active` +
        (changed.length ? `; ${changed.join(", ")}` : "; no changes") +
        (monitor.emails.length ? ` (would email ${monitor.emails.length})` : ""),
    );
  }
}

const holder = () =>
  singleton<{ provider: WeatherNotificationProvider }>("notification-provider", () => ({
    provider: resendApiKey() ? new ResendEmailProvider() : new LogNotificationProvider(),
  }));

export type NotificationStatus = {
  /** True only when a real delivery channel is registered. The log provider does not count. */
  deliveryConfigured: boolean;
  provider: string;
};

export function notificationStatus(): NotificationStatus {
  const provider = holder().provider;
  return { deliveryConfigured: !(provider instanceof LogNotificationProvider), provider: provider.name };
}

export function getNotificationProvider(): WeatherNotificationProvider {
  return holder().provider;
}

export function setNotificationProvider(provider: WeatherNotificationProvider): void {
  holder().provider = provider;
}
