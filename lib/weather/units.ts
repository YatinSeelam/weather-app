export const KM_PER_MILE = 1.609344;
const MM_PER_INCH = 25.4;

export const milesToKm = (miles: number) => miles * KM_PER_MILE;
export const kmToMiles = (km: number) => km / KM_PER_MILE;
export const celsiusToFahrenheit = (celsius: number) => (celsius * 9) / 5 + 32;
export const kmhToMph = (kmh: number) => kmh / KM_PER_MILE;
export const metersPerSecondToMph = (ms: number) => (ms * 3.6) / KM_PER_MILE;
export const knotsToMph = (knots: number) => knots * 1.150779;
export const mmToInches = (mm: number) => mm / MM_PER_INCH;

export type TargetUnit = "degF" | "mph" | "in";

const CONVERTERS: Record<TargetUnit, Record<string, (value: number) => number>> = {
  degF: {
    "wmoUnit:degC": celsiusToFahrenheit,
    "wmoUnit:degF": (v) => v,
  },
  mph: {
    "wmoUnit:km_h-1": kmhToMph,
    "wmoUnit:m_s-1": metersPerSecondToMph,
    "wmoUnit:kn": knotsToMph,
    "wmoUnit:mi_h-1": (v) => v,
  },
  in: {
    "wmoUnit:mm": mmToInches,
    "wmoUnit:[in_i]": (v) => v,
  },
};

/**
 * Returns a converter from an NWS unit-of-measure code to the target unit,
 * or null when the unit is not one we know. Unknown units are dropped rather than guessed.
 */
export function converterFor(uom: string | null | undefined, target: TargetUnit): ((value: number) => number) | null {
  if (!uom) return null;
  return CONVERTERS[target][uom] ?? null;
}
