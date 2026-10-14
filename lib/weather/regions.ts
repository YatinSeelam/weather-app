import type { BBox } from "geojson";
import { bboxesOverlap } from "./geography";

/**
 * Rough bounding boxes [west, south, east, north] for the areas NWS zone codes (UGC) start with:
 * two-letter states/territories plus marine areas. They are only a cheap pre-filter that lets us
 * skip alerts on the other side of the country before fetching zone boundaries — the precise
 * test always uses the real zone geometry. Boxes are deliberately generous.
 */
const AREA_BOUNDS: Record<string, BBox> = {
  AL: [-88.5, 30.1, -84.9, 35.0],
  AK: [-180, 51, -129, 71.5],
  AZ: [-114.9, 31.3, -109.0, 37.0],
  AR: [-94.7, 33.0, -89.6, 36.5],
  CA: [-124.5, 32.5, -114.1, 42.0],
  CO: [-109.1, 36.9, -102.0, 41.0],
  CT: [-73.8, 40.9, -71.7, 42.1],
  DE: [-75.8, 38.4, -75.0, 39.9],
  DC: [-77.2, 38.7, -76.9, 39.0],
  FL: [-87.7, 24.4, -79.9, 31.0],
  GA: [-85.7, 30.3, -80.7, 35.0],
  HI: [-178.5, 18.9, -154.8, 28.5],
  ID: [-117.3, 41.9, -111.0, 49.0],
  IL: [-91.6, 36.9, -87.0, 42.5],
  IN: [-88.1, 37.7, -84.7, 41.8],
  IA: [-96.7, 40.3, -90.1, 43.5],
  KS: [-102.1, 36.9, -94.5, 40.0],
  KY: [-89.6, 36.4, -81.9, 39.2],
  LA: [-94.1, 28.9, -88.8, 33.0],
  ME: [-71.1, 43.0, -66.9, 47.5],
  MD: [-79.5, 37.9, -75.0, 39.7],
  MA: [-73.5, 41.2, -69.9, 42.9],
  MI: [-90.5, 41.7, -82.4, 48.3],
  MN: [-97.3, 43.5, -89.5, 49.4],
  MS: [-91.7, 30.1, -88.1, 35.0],
  MO: [-95.8, 36.0, -89.1, 40.6],
  MT: [-116.1, 44.3, -104.0, 49.0],
  NE: [-104.1, 40.0, -95.3, 43.0],
  NV: [-120.0, 35.0, -114.0, 42.0],
  NH: [-72.6, 42.7, -70.6, 45.3],
  NJ: [-75.6, 38.9, -73.9, 41.4],
  NM: [-109.1, 31.3, -103.0, 37.0],
  NY: [-79.8, 40.5, -71.8, 45.0],
  NC: [-84.3, 33.8, -75.4, 36.6],
  ND: [-104.1, 45.9, -96.5, 49.0],
  OH: [-84.8, 38.4, -80.5, 42.0],
  OK: [-103.0, 33.6, -94.4, 37.0],
  OR: [-124.6, 41.9, -116.4, 46.3],
  PA: [-80.5, 39.7, -74.7, 42.3],
  RI: [-71.9, 41.1, -71.1, 42.0],
  SC: [-83.4, 32.0, -78.5, 35.2],
  SD: [-104.1, 42.5, -96.4, 45.9],
  TN: [-90.3, 35.0, -81.6, 36.7],
  TX: [-106.7, 25.8, -93.5, 36.5],
  UT: [-114.1, 37.0, -109.0, 42.0],
  VT: [-73.4, 42.7, -71.5, 45.0],
  VA: [-83.7, 36.5, -75.2, 39.5],
  WA: [-124.8, 45.5, -116.9, 49.0],
  WV: [-82.7, 37.2, -77.7, 40.6],
  WI: [-92.9, 42.5, -86.8, 47.1],
  WY: [-111.1, 41.0, -104.0, 45.0],
  PR: [-67.9, 17.6, -65.2, 18.6],
  VI: [-65.1, 17.6, -64.5, 18.5],
  GU: [144.5, 13.1, 145.1, 13.8],
  AS: [-171.2, -14.6, -169.3, -14.1],
  MP: [144.8, 14.0, 146.2, 20.6],

  // Marine areas
  AN: [-78, 33, -64, 45.5], // Western North Atlantic, Maine to North Carolina
  AM: [-82, 16, -60, 35], // Atlantic south of North Carolina, Caribbean
  GM: [-98, 23, -80, 31], // Gulf
  PZ: [-131, 30, -116, 49], // Pacific coast
  PK: [-180, 48, -129, 73], // Alaska waters
  PH: [-180, 15, -150, 30], // Hawaii waters
  LS: [-92.5, 46, -84, 49.5], // Lake Superior
  LM: [-88.5, 41.5, -84.5, 46.2], // Lake Michigan
  LH: [-85, 43, -79.5, 46.5], // Lake Huron
  LC: [-83.2, 42.2, -82.3, 42.8], // Lake St. Clair
  LE: [-84, 41, -78.5, 43], // Lake Erie
  LO: [-80, 43, -76, 44.5], // Lake Ontario
  SL: [-77, 44, -74, 45.2], // St. Lawrence River
  PM: [130, 0, 180, 25], // Western Pacific
  PS: [-175, -18, -165, -10], // American Samoa waters
};

const PADDING_DEGREES = 0.5;

/**
 * Whether a zone with this UGC code (e.g. "NYZ063", "FLC087", "ANZ335") could be anywhere near
 * the search box. Unknown prefixes return true so they are checked precisely instead of dropped.
 */
export function ugcMayIntersect(ugc: string, searchBbox: BBox): boolean {
  const bounds = AREA_BOUNDS[ugc.slice(0, 2).toUpperCase()];
  if (!bounds) return true;
  const padded: BBox = [
    bounds[0] - PADDING_DEGREES,
    bounds[1] - PADDING_DEGREES,
    bounds[2] + PADDING_DEGREES,
    bounds[3] + PADDING_DEGREES,
  ];
  return bboxesOverlap(padded, searchBbox);
}
