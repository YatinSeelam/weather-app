import type { SeverityLevel } from "@/lib/weather/types";

/** MapLibre paints on a canvas and cannot read CSS variables; these mirror app/globals.css. */
export const MAP_COLORS = {
  accent: "#1d4fa8",
  severity: {
    critical: "#d0321f",
    high: "#e07412",
    moderate: "#dba307",
    low: "#3b7fc9",
    info: "#8a93a0",
  } satisfies Record<SeverityLevel, string>,
} as const;

/** Any MapLibre style URL. The default is OpenFreeMap's key-free OpenStreetMap basemap. */
export const MAP_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/positron";

/** Continental U.S., shown until a ZIP code resolves. */
export const DEFAULT_VIEW = { center: [-96, 38.5] as [number, number], zoom: 3 };
