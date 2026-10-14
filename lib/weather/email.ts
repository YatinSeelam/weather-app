import { emailFrom, resendApiKey } from "./config";
import { formatInterval } from "./format";
import type { MonitorUpdate, WeatherNotificationProvider } from "./notifications";
import { SEVERITY_LABELS } from "./severity";

/**
 * Email delivery through Resend's REST API (https://resend.com/docs/api-reference/emails/send-email).
 * A plain fetch keeps the dependency list unchanged; the API is a single POST.
 */

const RESEND_SEND_URL = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 15_000;

export type EmailMessage = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const CHANGE_WORDS = {
  NEW: "New",
  ESCALATED: "Escalated",
  UPDATED: "Updated",
  EXPIRED: "Ended",
  UNCHANGED: "Unchanged",
} as const;

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  // Emails leave the server's locale behind, so always say which zone this is.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: process.env.EMAIL_TIME_ZONE || "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** One sentence a subject line can carry. */
export function summarizeUpdate({ run }: Pick<MonitorUpdate, "run">): string {
  if (run.status === "failed") return "Unable to check live weather";
  if (run.activeRiskCount === 0 || !run.highestSeverity) return "No active weather risks";
  const count = `${run.activeRiskCount} active risk${run.activeRiskCount === 1 ? "" : "s"}`;
  return `${count}, highest ${SEVERITY_LABELS[run.highestSeverity].toLowerCase()}`;
}

/** Builds the message once; the provider only addresses and sends it. */
export function renderMonitorEmail(update: MonitorUpdate, from = emailFrom()): EmailMessage {
  const { monitor, run, changes, activeRisks } = update;
  const summary = summarizeUpdate(update);
  const where = `ZIP ${monitor.zipCode}, ${monitor.radiusMiles} mi radius`;
  const when = `Checked ${formatWhen(run.completedAt)}, every ${formatInterval(monitor.intervalMinutes).toLowerCase()}`;
  const notable = changes.filter((change) => change.change !== "UNCHANGED");

  const line = (level: string, title: string, detail: string) => `${title} (${level}): ${detail}`;
  const changeLines = notable.map((change) =>
    line(`${CHANGE_WORDS[change.change]}, ${SEVERITY_LABELS[change.level].toLowerCase()}`, change.title, change.detail),
  );
  const activeLines = activeRisks.map((risk) => line(SEVERITY_LABELS[risk.level].toLowerCase(), risk.title, risk.detail));

  const problem =
    run.status === "failed"
      ? `The check could not be completed: ${(run.errorSummary ?? "unknown error").replace(/\.$/, "")}. This is not an all-clear.`
      : run.status === "partial" && run.errorSummary
        ? `Some data was missing: ${run.errorSummary}`
        : null;

  const bullets = (lines: string[], empty: string) => (lines.length ? lines.map((l) => `- ${l}`).join("\n") : empty);
  const text = [
    `${monitor.name}`,
    `${where}. ${when}.`,
    "",
    summary + ".",
    problem ?? "",
    "",
    "Changed since the last check:",
    bullets(changeLines, "Nothing changed."),
    "",
    "Active now:",
    bullets(activeLines, "None."),
    "",
    "Official alerts are issued by the National Weather Service. Detected risks are calculated by this app from NWS forecast data and are not official warnings.",
    `You receive this because your address is on the "${monitor.name}" monitor. Edit the monitor to stop.`,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  const list = (lines: string[], empty: string) =>
    lines.length
      ? `<ul style="margin:4px 0 0;padding-left:18px">${lines.map((l) => `<li style="margin:2px 0">${escapeHtml(l)}</li>`).join("")}</ul>`
      : `<p style="margin:4px 0 0;color:#666">${escapeHtml(empty)}</p>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6;font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e3e3;border-radius:10px;padding:20px">
<h1 style="margin:0;font-size:18px">${escapeHtml(monitor.name)}</h1>
<p style="margin:4px 0 0;color:#666">${escapeHtml(where)}. ${escapeHtml(when)}.</p>
<p style="margin:16px 0 0;font-size:16px;font-weight:600">${escapeHtml(summary)}.</p>
${problem ? `<p style="margin:8px 0 0;color:#a3261f">${escapeHtml(problem)}</p>` : ""}
<h2 style="margin:20px 0 0;font-size:14px">Changed since the last check</h2>
${list(changeLines, "Nothing changed.")}
<h2 style="margin:20px 0 0;font-size:14px">Active now</h2>
${list(activeLines, "None.")}
<p style="margin:24px 0 0;font-size:12px;color:#666">Official alerts are issued by the National Weather Service. Detected risks are calculated by this app from NWS forecast data and are not official warnings.</p>
<p style="margin:8px 0 0;font-size:12px;color:#666">You receive this because your address is on the &ldquo;${escapeHtml(monitor.name)}&rdquo; monitor. Edit the monitor to stop.</p>
</div></body></html>`;

  return {
    from,
    to: monitor.emails,
    subject: `${monitor.name}: ${summary}`,
    text,
    html,
  };
}

type Sender = (message: EmailMessage) => Promise<void>;

export async function sendWithResend(message: EmailMessage, apiKey = resendApiKey()): Promise<void> {
  if (!apiKey) throw new Error("RESEND_API_KEY is not set.");
  const response = await fetch(RESEND_SEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(`Resend returned ${response.status}: ${body?.message ?? response.statusText}`);
  }
}

export class ResendEmailProvider implements WeatherNotificationProvider {
  readonly name = "resend";

  constructor(private readonly send: Sender = sendWithResend) {}

  async notify(update: MonitorUpdate): Promise<void> {
    if (update.monitor.emails.length === 0) return;
    await this.send(renderMonitorEmail(update));
  }
}
