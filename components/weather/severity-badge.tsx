import { SEVERITY_LABELS } from "@/lib/weather/severity";
import type { SeverityLevel } from "@/lib/weather/types";
import { GaugeIcon, ShieldIcon } from "./icons";

const MARK_COLOR: Record<SeverityLevel, string> = {
  critical: "text-critical",
  high: "text-high",
  moderate: "text-moderate",
  low: "text-low",
  info: "text-info",
};

const BADGE_STYLE: Record<SeverityLevel, string> = {
  critical: "bg-critical-soft text-critical-ink",
  high: "bg-high-soft text-high-ink",
  moderate: "bg-moderate-soft text-moderate-ink",
  low: "bg-low-soft text-low-ink",
  info: "bg-info-soft text-info-ink",
};

/** Each level has its own shape as well as its own color, so severity never relies on color alone. */
function MarkShape({ level }: { level: SeverityLevel }) {
  switch (level) {
    case "critical":
      return <path d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1L5.1 1Z" fill="currentColor" />;
    case "high":
      return <path d="M8 1.5 15 14H1L8 1.5Z" fill="currentColor" />;
    case "moderate":
      return <path d="M8 1 15 8l-7 7-7-7 7-7Z" fill="currentColor" />;
    case "low":
      return <circle cx="8" cy="8" r="6.5" fill="currentColor" />;
    default:
      return <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />;
  }
}

export function SeverityMark({ level, className = "" }: { level: SeverityLevel; className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden
      className={`shrink-0 ${MARK_COLOR[level]} ${className}`}
    >
      <MarkShape level={level} />
    </svg>
  );
}

export function SeverityBadge({ level }: { level: SeverityLevel }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-semibold ${BADGE_STYLE[level]}`}
    >
      <span className="sr-only">Severity: </span>
      {SEVERITY_LABELS[level]}
    </span>
  );
}

export function SourceBadge({ kind }: { kind: "official" | "detected" }) {
  const Icon = kind === "official" ? ShieldIcon : GaugeIcon;
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-xs font-medium text-ink-muted">
      <Icon width={12} height={12} />
      {kind === "official" ? "Official NWS alert" : "Detected risk"}
    </span>
  );
}
