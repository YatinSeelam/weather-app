/** One forecast value and the period it applies to (epoch milliseconds). */
export type TimeInterval = {
  start: number;
  end: number;
  value: number;
};

const DURATION_PATTERN = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** Parses the ISO-8601 durations NWS uses, e.g. "PT1H", "PT6H", "P1D", "P7DT13H". */
export function parseIsoDurationMs(duration: string): number | null {
  const match = DURATION_PATTERN.exec(duration);
  if (!match || duration === "P" || duration.endsWith("T")) return null;
  const [, weeks, days, hours, minutes, seconds] = match.map((part) => (part ? Number(part) : 0));
  return ((((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** Parses an NWS validTime such as "2026-10-06T12:00:00+00:00/PT6H". */
export function parseValidTime(validTime: string): { start: number; end: number } | null {
  const [startText, durationText] = validTime.split("/");
  if (!startText || !durationText) return null;
  const start = Date.parse(startText);
  const duration = parseIsoDurationMs(durationText);
  if (Number.isNaN(start) || duration === null || duration <= 0) return null;
  return { start, end: start + duration };
}

export function intervalsOverlapping(series: TimeInterval[], from: number, to: number): TimeInterval[] {
  return series.filter((interval) => interval.start < to && interval.end > from);
}
