"use client";

import { useState, type ReactNode } from "react";
import {
  formatAlertDistance,
  formatMiles,
  formatPointDistance,
  formatUntil,
  pluralize,
  unwrapNwsText,
} from "@/lib/weather/format";
import type { DetectedWeatherRisk, SeverityLevel } from "@/lib/weather/types";
import type { AlertItem, DetectedGroupItem } from "@/lib/weather/view-model";
import { SeverityBadge, SeverityMark, SourceBadge } from "./severity-badge";

const LINK_BUTTON =
  "rounded text-[13px] font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const VISIBLE_LOCATIONS = 3;

function CardShell({
  level,
  title,
  kind,
  selected,
  children,
}: {
  level: SeverityLevel;
  title: string;
  kind: "official" | "detected";
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <article
      aria-current={selected ? "true" : undefined}
      className={`flex gap-3 px-5 py-4 transition-colors ${selected ? "bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)]" : ""}`}
    >
      <SeverityMark level={level} className="mt-1" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <h3 className="text-[15px] font-semibold leading-6 text-ink">{title}</h3>
          <SeverityBadge level={level} />
          <SourceBadge kind={kind} />
        </div>
        {children}
      </div>
    </article>
  );
}

function Facts({ items }: { items: Array<string | null> }) {
  const present = items.filter((item): item is string => Boolean(item));
  if (present.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-x-3 text-[13px] text-ink-muted tabular-nums">
      {present.map((item, index) => (
        <li key={item} className={index > 0 ? "border-l border-line-strong pl-3" : ""}>
          {item}
        </li>
      ))}
    </ul>
  );
}

export function AlertCard({
  item,
  selected,
  onViewOnMap,
}: {
  item: AlertItem;
  selected: boolean;
  onViewOnMap: (id: string) => void;
}) {
  const { alert } = item;
  const description = alert.description ? unwrapNwsText(alert.description) : null;
  const instruction = alert.instruction ? unwrapNwsText(alert.instruction) : null;
  const excerpt = instruction ?? description;

  return (
    <CardShell level={alert.level} title={alert.event} kind="official" selected={selected}>
      {alert.areaDescription && <p className="mt-1 line-clamp-2 text-sm text-ink">{alert.areaDescription}</p>}
      <Facts
        items={[
          alert.senderName ?? "National Weather Service",
          formatAlertDistance(alert.distanceMiles),
          formatUntil(alert.ends ?? alert.expires),
        ]}
      />

      {excerpt && <p className="mt-2 line-clamp-2 max-w-[70ch] text-[13px] leading-5 text-ink-muted">{excerpt}</p>}

      <div className="mt-3 flex flex-wrap items-start gap-x-5 gap-y-2">
        <button type="button" className={LINK_BUTTON} onClick={() => onViewOnMap(alert.id)}>
          View on map
          <span className="sr-only">: {alert.event}</span>
        </button>

        {(description || instruction) && (
          <details className="min-w-0 flex-1 basis-64 text-[13px]">
            <summary className="w-fit cursor-pointer rounded font-semibold text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              Full alert text
            </summary>
            <div className="mt-2 max-w-[70ch] space-y-3 whitespace-pre-line leading-5 text-ink-muted">
              <p className="font-medium text-ink">{alert.headline}</p>
              {description && <p>{description}</p>}
              {instruction && <p>{instruction}</p>}
              <p className="text-xs">
                {alert.geometrySource === "nws-zones"
                  ? "This alert covers whole NWS forecast zones; the map shows those zones, not a storm-specific outline."
                  : "The map shows the outline issued with this alert."}
              </p>
            </div>
          </details>
        )}
      </div>
    </CardShell>
  );
}

function LocationRow({
  risk,
  selected,
  onSelect,
}: {
  risk: DetectedWeatherRisk;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const reading = risk.observedValue !== undefined && risk.unit ? `${risk.observedValue}${risk.unit === "°F" ? "" : " "}${risk.unit}` : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(risk.id)}
        aria-pressed={selected}
        className={`flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent ${selected ? "bg-surface shadow-[0_0_0_1px_var(--color-line-strong)]" : ""}`}
      >
        <SeverityMark level={risk.severity} className="size-3" />
        <span className="min-w-0 flex-1 truncate text-ink">{risk.locationLabel ?? "Sampled location"}</span>
        {reading && <span className="font-semibold tabular-nums text-ink">{reading}</span>}
        <span className="w-16 text-right tabular-nums text-ink-muted">{formatMiles(risk.distanceMiles)}</span>
      </button>
    </li>
  );
}

export function DetectedGroupCard({
  item,
  selectedId,
  sampledCount,
  onViewOnMap,
  onSelectLocation,
}: {
  item: DetectedGroupItem;
  selectedId: string | null;
  sampledCount: number;
  onViewOnMap: (item: DetectedGroupItem) => void;
  onSelectLocation: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const worst = item.risks[0];
  const selected = item.risks.some((risk) => risk.id === selectedId);
  const selectedIndex = item.risks.findIndex((risk) => risk.id === selectedId);
  // A location picked on the map is always shown, even past the collapsed limit.
  const showAll = expanded || selectedIndex >= VISIBLE_LOCATIONS;
  const visible = showAll ? item.risks : item.risks.slice(0, VISIBLE_LOCATIONS);
  const hiddenCount = item.risks.length - visible.length;

  return (
    <CardShell level={item.level} title={item.title} kind="detected" selected={selected}>
      <p className="mt-1 text-sm text-ink">{worst.description}</p>
      <Facts
        items={[
          worst.locationLabel ?? null,
          formatPointDistance(worst.distanceMiles),
          sampledCount > 0
            ? `${item.risks.length} of ${pluralize(sampledCount, "sampled location")}`
            : pluralize(item.risks.length, "location"),
        ]}
      />

      {item.risks.length > 1 && (
        <ul className="mt-2 max-w-xl space-y-0.5" aria-label={`Locations with ${item.title.toLowerCase()}`}>
          {visible.map((risk) => (
            <LocationRow key={risk.id} risk={risk} selected={risk.id === selectedId} onSelect={onSelectLocation} />
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        <button type="button" className={LINK_BUTTON} onClick={() => onViewOnMap(item)}>
          View on map
          <span className="sr-only">: {item.title}</span>
        </button>
        {(hiddenCount > 0 || expanded) && (
          <button
            type="button"
            className={`${LINK_BUTTON} text-ink-muted`}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show fewer locations" : `Show ${hiddenCount} more ${hiddenCount === 1 ? "location" : "locations"}`}
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        Detected by this app from NWS forecast data. Not an official NWS warning.
      </p>
    </CardShell>
  );
}
