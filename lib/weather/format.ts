import type { MonitorInterval } from "./types";

/**
 * Display formatting. Times are stored and transported as UTC ISO strings and shown in the
 * viewer's own time zone, with the zone abbreviation so "6:15 PM" is never ambiguous.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "2:41 PM" */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

/** "6:15 PM EDT" today, "Wed 9:00 AM EDT" this week, "Oct 14, 9:00 AM EDT" beyond that. */
export function formatDateTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  if (isSameDay(date, now)) return new Intl.DateTimeFormat(undefined, time).format(date);
  if (Math.abs(date.getTime() - now.getTime()) < 6 * DAY_MS) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", ...time }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...time }).format(date);
}

export function formatUntil(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const text = formatDateTime(iso, now);
  return text ? `Until ${text}` : null;
}

/** "3 mi", "28 mi"; anything under a mile is "<1 mi". */
export function formatMiles(miles: number): string {
  return miles < 1 ? "<1 mi" : `${Math.round(miles)} mi`;
}

/** Distance from the center to an alert area. Null when the distance is unknown. */
export function formatAlertDistance(miles: number | null | undefined): string | null {
  if (miles === null || miles === undefined) return null;
  return miles === 0 ? "Covers the ZIP center" : `${formatMiles(miles)} from center`;
}

export function formatPointDistance(miles: number): string {
  return miles < 1 ? "At the ZIP center" : `${formatMiles(miles)} away`;
}

export function formatInterval(minutes: MonitorInterval | number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * NWS text is hard-wrapped at ~70 characters. Join wrapped lines back into paragraphs and
 * keep the real paragraph breaks.
 */
export function unwrapNwsText(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
