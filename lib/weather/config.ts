import path from "node:path";
import { DEFAULT_MAX_ACTIVE_MONITORS } from "./constants";

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export const nwsBaseUrl = () => trimSlash(process.env.NWS_API_BASE_URL ?? "https://api.weather.gov");

/**
 * NWS asks every client to identify itself, ideally with contact details, so they can reach
 * out instead of blocking. Set NWS_USER_AGENT, e.g. "my-app (ops@example.com)".
 */
export const nwsUserAgent = () =>
  process.env.NWS_USER_AGENT?.trim() || "weather-radius-monitor/0.1 (set NWS_USER_AGENT to add contact details)";

export const zipApiBaseUrl = () => trimSlash(process.env.ZIP_API_BASE_URL ?? "https://api.zippopotam.us");

/** Resend API key. Without it no email is sent and the UI says so. */
export const resendApiKey = () => process.env.RESEND_API_KEY?.trim() || null;

/**
 * Sender for monitor emails, e.g. "Weather Monitor <alerts@yourdomain.com>". The domain must be
 * verified in Resend. The default only delivers to the Resend account owner's own address.
 */
export const emailFrom = () => process.env.EMAIL_FROM?.trim() || "Weather Monitor <onboarding@resend.dev>";

/**
 * Access key for the saved-monitor API (list, create, update, delete). Server-only: never
 * prefix it with NEXT_PUBLIC_. Without it the monitor API refuses every request.
 */
export const monitorApiSecret = () => process.env.MONITOR_API_SECRET?.trim() || null;

/** Most monitors that may be enabled at once, so the app cannot be turned into a mail cannon. */
export function maxActiveMonitors(): number {
  const value = Number(process.env.MAX_ACTIVE_MONITORS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ACTIVE_MONITORS;
}

/**
 * Postgres connection string for saved monitors (Supabase: the pooler URL for the `weather_app`
 * role). Server-only. Without it monitors are kept in a JSON file under WEATHER_DATA_DIR.
 */
export const databaseUrl = () => process.env.DATABASE_URL?.trim() || null;

/**
 * PEM root certificate that signs the database server's certificate (Supabase: "SSL certificate"
 * under Database Settings). Not a secret. Escaped "\n" sequences are accepted for one-line env vars.
 */
export const databaseCaCert = () => process.env.DATABASE_CA_CERT?.trim().replace(/\\n/g, "\n") || undefined;

export const dataDirectory = () => process.env.WEATHER_DATA_DIR ?? path.join(process.cwd(), "data");

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Named providers plus the hosts actually called, reported with every check. */
export function dataProviders() {
  return {
    providers: {
      alerts: "NOAA / National Weather Service",
      forecasts: "NOAA / National Weather Service",
      geocoding: "Zippopotam.us",
      map: process.env.NEXT_PUBLIC_MAP_STYLE_URL ? "Custom MapLibre basemap" : "OpenFreeMap / OpenStreetMap",
    },
    hosts: { nws: hostOf(nwsBaseUrl()), geocoding: hostOf(zipApiBaseUrl()) },
  };
}
