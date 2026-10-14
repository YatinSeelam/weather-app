import path from "node:path";

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
