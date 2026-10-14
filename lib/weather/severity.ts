import { SEVERITY_LEVELS, type SeverityLevel } from "./types";

export function severityRank(level: SeverityLevel): number {
  return SEVERITY_LEVELS.indexOf(level);
}

export function maxSeverity(a: SeverityLevel, b: SeverityLevel): SeverityLevel {
  return severityRank(a) >= severityRank(b) ? a : b;
}

export function highestSeverity(levels: Iterable<SeverityLevel>): SeverityLevel | null {
  let highest: SeverityLevel | null = null;
  for (const level of levels) {
    highest = highest === null ? level : maxSeverity(highest, level);
  }
  return highest;
}

export const SEVERITY_LABELS: Record<SeverityLevel, string> = {
  critical: "Critical",
  high: "High",
  moderate: "Moderate",
  low: "Low",
  info: "Info",
};
