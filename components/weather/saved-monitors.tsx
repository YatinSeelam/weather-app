"use client";

import { useState, type FormEvent } from "react";
import { errorMessage } from "@/lib/weather/api-client";
import { EMAIL_MODE_LABELS, EMAIL_MODE_OPTIONS, INTERVAL_OPTIONS, MAX_MONITOR_EMAILS } from "@/lib/weather/constants";
import { looksLikeEmail, splitEmailList } from "@/lib/weather/email-list";
import { formatClock, formatDateTime, formatInterval, pluralize } from "@/lib/weather/format";
import type { WeatherMonitor } from "@/lib/weather/monitor-store";
import { SEVERITY_LABELS } from "@/lib/weather/severity";
import type { EmailMode, MonitorInterval } from "@/lib/weather/types";
import { describeEmailMode } from "./monitor-form";
import { SeverityMark } from "./severity-badge";
import type { MonitorsState } from "./use-weather";

type Props = MonitorsState & {
  busyId: string | null;
  actionError: string | null;
  onView: (monitor: WeatherMonitor) => void;
  onToggle: (monitor: WeatherMonitor, enabled: boolean) => void;
  onInterval: (monitor: WeatherMonitor, intervalMinutes: MonitorInterval) => void;
  onEmails: (monitor: WeatherMonitor, emails: string[], emailMode: EmailMode) => void;
  onDelete: (monitor: WeatherMonitor) => void;
  onUnlock: (secret: string) => Promise<void>;
  onLock: () => void;
};

const TEXT_BUTTON =
  "rounded text-[13px] font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

function RunStatus({ monitor }: { monitor: WeatherMonitor }) {
  const run = monitor.lastRun;
  if (!run) return <p className="text-[13px] text-ink-muted">Not checked yet</p>;
  if (run.status === "failed") {
    // A failed check is "unable to check", not "nothing active".
    return (
      <p className="text-[13px] text-critical-ink">
        Unable to check live weather. {run.errorSummary}{" "}
        {monitor.lastSuccessfulCheckAt
          ? `Last successful check: ${formatDateTime(monitor.lastSuccessfulCheckAt)}.`
          : "No successful check yet."}
      </p>
    );
  }
  const fresh = run.changes.filter((change) => change.change === "NEW" || change.change === "ESCALATED").length;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-ink">
      {run.highestSeverity ? (
        <>
          <SeverityMark level={run.highestSeverity} className="size-3" />
          {pluralize(run.activeRiskCount, "active risk")}, highest {SEVERITY_LABELS[run.highestSeverity].toLowerCase()}
        </>
      ) : (
        "No active risks"
      )}
      {fresh > 0 && <span className="text-ink-muted">({fresh} new at last check)</span>}
    </p>
  );
}

const SELECT =
  "h-7 rounded-md border border-line-strong bg-surface px-1.5 text-[13px] font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** Recipients line with an inline editor, so emails can change without recreating the monitor. */
function EmailRecipients({
  monitor,
  busy,
  onEmails,
}: {
  monitor: WeatherMonitor;
  busy: boolean;
  onEmails: Props["onEmails"];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = `monitor-emails-${monitor.id}`;
  const modeId = `monitor-email-mode-${monitor.id}`;

  const startEditing = () => {
    setDraft(monitor.emails.join(", "));
    setError(null);
    setEditing(true);
  };

  const save = () => {
    const emails = splitEmailList(draft);
    const bad = emails.find((email) => !looksLikeEmail(email));
    if (bad) return setError(`"${bad}" is not a valid email address.`);
    if (emails.length > MAX_MONITOR_EMAILS) return setError(`At most ${MAX_MONITOR_EMAILS} addresses per monitor.`);
    setEditing(false);
    onEmails(monitor, emails, monitor.emailMode);
  };

  if (editing) {
    return (
      <div className="mt-2">
        <label htmlFor={inputId} className="text-[13px] text-ink-muted">
          Email updates to
        </label>
        <textarea
          id={inputId}
          rows={2}
          value={draft}
          autoFocus
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          aria-invalid={Boolean(error)}
          placeholder="you@example.com, teammate@example.com"
          className="mt-1 block w-full resize-y rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent aria-invalid:border-critical"
        />
        {error && <p className="mt-1 text-[13px] text-critical-ink">{error}</p>}
        <div className="mt-1.5 flex gap-4">
          <button type="button" className={`${TEXT_BUTTON} text-accent`} disabled={busy} onClick={save}>
            Save emails
          </button>
          <button type="button" className={`${TEXT_BUTTON} text-ink-muted`} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-1">
      <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink-muted">
        <span className="min-w-0 break-all">
          {monitor.emails.length > 0 ? `Emails ${monitor.emails.join(", ")}` : "No email recipients"}
        </span>
        <button type="button" className={`${TEXT_BUTTON} text-accent`} disabled={busy} onClick={startEditing}>
          {monitor.emails.length > 0 ? "Edit" : "Add emails"}
          <span className="sr-only"> for {monitor.name}</span>
        </button>
      </p>
      {monitor.emails.length > 0 && (
        <label htmlFor={modeId} className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink-muted">
          Send
          <select
            id={modeId}
            value={monitor.emailMode}
            disabled={busy}
            onChange={(event) => onEmails(monitor, monitor.emails, event.target.value as EmailMode)}
            className={SELECT}
          >
            {EMAIL_MODE_OPTIONS.map((mode) => (
              <option key={mode} value={mode}>
                {EMAIL_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
          <span className="sr-only">{describeEmailMode(monitor.emailMode, monitor.intervalMinutes)}</span>
        </label>
      )}
    </div>
  );
}

/** The access key goes straight to the server, which answers with an HttpOnly session cookie. */
function UnlockForm({ onUnlock }: { onUnlock: Props["onUnlock"] }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = secret.trim();
    if (!key) return setError("Enter the access key.");
    setBusy(true);
    setError(null);
    try {
      await onUnlock(key);
      setSecret("");
    } catch (unlockError) {
      setError(errorMessage(unlockError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="px-5 pb-5 pt-2">
      <p className="text-[13px] leading-5 text-ink-muted">
        Saved monitors and their email recipients are private. Enter the access key to view and manage them.
      </p>
      <label htmlFor="monitor-access-key" className="mt-3 block text-[13px] font-medium text-ink">
        Access key
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="monitor-access-key"
          type="password"
          autoComplete="current-password"
          value={secret}
          onChange={(event) => {
            setSecret(event.target.value);
            setError(null);
          }}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "monitor-access-key-error" : undefined}
          className="block h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent aria-invalid:border-critical"
        />
        <button
          type="submit"
          disabled={busy}
          className="h-9 shrink-0 rounded-lg bg-ink px-3.5 text-sm font-semibold text-white transition-colors hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-progress disabled:bg-ink/70"
        >
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </div>
      {error && (
        <p id="monitor-access-key-error" role="alert" className="mt-1.5 text-[13px] text-critical-ink">
          {error}
        </p>
      )}
    </form>
  );
}

function MonitorRow({
  monitor,
  busy,
  onView,
  onToggle,
  onInterval,
  onEmails,
  onDelete,
}: {
  monitor: WeatherMonitor;
  busy: boolean;
} & Pick<Props, "onView" | "onToggle" | "onInterval" | "onEmails" | "onDelete">) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const selectId = `monitor-interval-${monitor.id}`;

  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{monitor.name}</p>
          <p className="text-[13px] text-ink-muted tabular-nums">ZIP {monitor.zipCode}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={monitor.enabled}
          aria-label={`Monitoring for ${monitor.name}`}
          disabled={busy}
          onClick={() => onToggle(monitor, !monitor.enabled)}
          className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 aria-checked:bg-ink"
        >
          <span
            aria-hidden
            className={`absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${monitor.enabled ? "translate-x-4" : ""}`}
          />
        </button>
      </div>

      <div className="mt-2 space-y-1">
        <RunStatus monitor={monitor} />
        <p className="text-[13px] text-ink-muted tabular-nums">
          {monitor.lastCheckedAt
            ? `${monitor.lastRun?.status === "failed" ? "Tried" : "Checked"} ${formatClock(monitor.lastCheckedAt)}`
            : "Waiting for first check"}
          {monitor.enabled ? `, next ${formatDateTime(monitor.nextCheckAt)}` : ", paused"}
        </p>
      </div>

      <EmailRecipients monitor={monitor} busy={busy} onEmails={onEmails} />

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor={selectId} className="flex items-center gap-1.5 text-[13px] text-ink-muted">
          Every
          <select
            id={selectId}
            value={monitor.intervalMinutes}
            disabled={busy}
            onChange={(event) => onInterval(monitor, Number(event.target.value) as MonitorInterval)}
            className={SELECT}
          >
            {INTERVAL_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {formatInterval(minutes)}
              </option>
            ))}
          </select>
        </label>

        <span className="ml-auto flex items-center gap-4">
          {confirmingDelete ? (
            <>
              <button
                type="button"
                className={`${TEXT_BUTTON} text-critical-ink`}
                disabled={busy}
                onClick={() => onDelete(monitor)}
              >
                Delete monitor
              </button>
              <button type="button" className={`${TEXT_BUTTON} text-ink-muted`} onClick={() => setConfirmingDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className={`${TEXT_BUTTON} text-accent`} disabled={busy} onClick={() => onView(monitor)}>
                View<span className="sr-only"> {monitor.name}</span>
              </button>
              <button
                type="button"
                className={`${TEXT_BUTTON} text-ink-muted`}
                disabled={busy}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete<span className="sr-only"> {monitor.name}</span>
              </button>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

export function SavedMonitors({
  status,
  monitors,
  error,
  notifications,
  busyId,
  actionError,
  onUnlock,
  onLock,
  ...actions
}: Props) {
  return (
    <section aria-labelledby="saved-monitors-heading" className="rounded-xl border border-line bg-surface">
      <div className="flex items-baseline justify-between px-5 pt-4">
        <h2 id="saved-monitors-heading" className="text-sm font-semibold text-ink">
          Saved monitors
        </h2>
        <span className="flex items-baseline gap-3">
          {monitors.length > 0 && <span className="text-[13px] text-ink-muted tabular-nums">{monitors.length}</span>}
          {(status === "ready" || status === "error") && (
            <button type="button" className={`${TEXT_BUTTON} text-ink-muted`} onClick={onLock}>
              Lock
            </button>
          )}
        </span>
      </div>

      {actionError && (
        <p role="alert" className="px-5 pt-2 text-[13px] text-critical-ink">
          {actionError}
        </p>
      )}

      {status === "locked" && <UnlockForm onUnlock={onUnlock} />}

      {status === "unconfigured" && (
        <p className="px-5 pb-5 pt-2 text-[13px] leading-5 text-ink-muted">
          Saved monitors are turned off on this server. Set MONITOR_API_SECRET to enable them.
        </p>
      )}

      {status === "loading" && <p className="px-5 pb-5 pt-2 text-[13px] text-ink-muted">Loading saved monitors…</p>}

      {status === "error" && monitors.length === 0 && (
        <p role="alert" className="px-5 pb-5 pt-2 text-[13px] text-critical-ink">
          Saved monitors could not be loaded. {error}
        </p>
      )}

      {status === "ready" && monitors.length === 0 && (
        <p className="px-5 pb-5 pt-2 text-[13px] leading-5 text-ink-muted">
          Check a location, then save it to have it checked automatically on a schedule.
        </p>
      )}

      {monitors.length > 0 && (
        <ul className="mt-2 divide-y divide-line border-t border-line">
          {monitors.map((monitor) => (
            <MonitorRow key={monitor.id} monitor={monitor} busy={busyId === monitor.id} {...actions} />
          ))}
        </ul>
      )}

      {monitors.length > 0 && notifications && !notifications.deliveryConfigured && (
        <p className="border-t border-line px-5 py-3 text-xs leading-5 text-ink-muted">
          Monitors are checked on schedule and changes are recorded, but email sending is not configured on the
          server (set RESEND_API_KEY and EMAIL_FROM), so no emails go out yet.
        </p>
      )}
    </section>
  );
}
