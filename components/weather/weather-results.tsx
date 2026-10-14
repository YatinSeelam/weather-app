"use client";

import { useEffect, useRef } from "react";
import { isCheckComplete } from "@/lib/weather/coverage";
import { formatDateTime } from "@/lib/weather/format";
import type { WeatherCheckResult } from "@/lib/weather/types";
import {
  filterItems,
  itemContaining,
  TYPE_FILTER_LABELS,
  typeFilterOf,
  type DetectedGroupItem,
  type RiskItem,
  type SourceFilter,
  type TypeFilter,
} from "@/lib/weather/view-model";
import { SegmentedControl } from "./segmented-control";
import { AlertCard, DetectedGroupCard } from "./weather-alert-card";

type Props = {
  result: WeatherCheckResult;
  items: RiskItem[];
  selectedId: string | null;
  /** Set when a selection came from the map, so the matching row scrolls into view. */
  scrollRequest: { id: string; seq: number } | null;
  sourceFilter: SourceFilter;
  typeFilter: TypeFilter;
  onSourceFilter: (filter: SourceFilter) => void;
  onTypeFilter: (filter: TypeFilter) => void;
  onViewAlert: (id: string) => void;
  onViewGroup: (item: DetectedGroupItem) => void;
  onSelectLocation: (id: string) => void;
};

/** Shown instead of the all-clear when part of the live data could not be retrieved. */
function IncompleteCheck({ result }: { result: WeatherCheckResult }) {
  return (
    <div role="status" className="rounded-xl border border-moderate/40 bg-moderate-soft px-6 py-8 text-center">
      <h3 className="text-base font-semibold text-ink">No risks found, but the check was incomplete</h3>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-ink">
        Some live weather data could not be retrieved (details above), so this is not an all-clear for{" "}
        {result.center.zipCode}. Check weather again in a few minutes.
      </p>
      <p className="mt-3 text-[13px] text-ink-muted tabular-nums">Last checked: {formatDateTime(result.checkedAt)}</p>
    </div>
  );
}

function NoRisks({ result }: { result: WeatherCheckResult }) {
  if (!isCheckComplete(result.source)) return <IncompleteCheck result={result} />;
  return (
    <div className="rounded-xl border border-line bg-surface px-6 py-10 text-center">
      <h3 className="text-base font-semibold text-ink">No active weather risks detected</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-ink-muted">
        No severe weather alerts or configured risk thresholds are currently active within {result.radiusMiles} miles
        of {result.center.zipCode}.
      </p>
      <p className="mt-3 text-[13px] text-ink-muted tabular-nums">Last checked: {formatDateTime(result.checkedAt)}</p>
    </div>
  );
}

export function WeatherResults({
  result,
  items,
  selectedId,
  scrollRequest,
  sourceFilter,
  typeFilter,
  onSourceFilter,
  onTypeFilter,
  onViewAlert,
  onViewGroup,
  onSelectLocation,
}: Props) {
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const visible = filterItems(items, sourceFilter, typeFilter);
  const selectedItem = itemContaining(items, selectedId);

  const officialCount = items.filter((item) => item.kind === "alert").length;
  const detectedCount = items.length - officialCount;
  const typesPresent = (Object.keys(TYPE_FILTER_LABELS) as TypeFilter[]).filter(
    (type) => type !== "all" && items.some((item) => typeFilterOf(item) === type),
  );

  const scrollId = scrollRequest ? (itemContaining(items, scrollRequest.id)?.id ?? null) : null;
  const scrollSeq = scrollRequest?.seq ?? 0;
  useEffect(() => {
    if (!scrollId) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rowRefs.current.get(scrollId)?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }, [scrollId, scrollSeq]);

  const heading = `Weather risks within ${result.radiusMiles} miles`;

  if (items.length === 0) {
    return (
      <section aria-label={heading}>
        <NoRisks result={result} />
      </section>
    );
  }

  return (
    <section aria-labelledby="results-heading">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <h2 id="results-heading" className="text-base font-semibold text-ink">
          {heading}
        </h2>
        <SegmentedControl
          legend="Show"
          hideLegend
          name="source-filter"
          value={sourceFilter}
          onChange={onSourceFilter}
          options={[
            { value: "all", label: `All ${items.length}` },
            { value: "official", label: `Official alerts ${officialCount}` },
            { value: "detected", label: `Detected risks ${detectedCount}` },
          ]}
        />
      </div>

      {typesPresent.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
          {(["all", ...typesPresent] as TypeFilter[]).map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={typeFilter === type}
              onClick={() => onTypeFilter(type)}
              className="rounded-full border border-line bg-surface px-3 py-1 text-[13px] font-medium text-ink-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-white"
            >
              {TYPE_FILTER_LABELS[type]}
            </button>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="mt-3 rounded-xl border border-line bg-surface px-5 py-6 text-sm text-ink-muted">
          Nothing matches these filters. Choose “All” to see every active risk.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {visible.map((item) => (
            <li
              key={item.id}
              ref={(node) => {
                if (node) rowRefs.current.set(item.id, node);
                else rowRefs.current.delete(item.id);
              }}
            >
              {item.kind === "alert" ? (
                <AlertCard item={item} selected={selectedItem?.id === item.id} onViewOnMap={onViewAlert} />
              ) : (
                <DetectedGroupCard
                  item={item}
                  selectedId={selectedId}
                  sampledCount={result.sampling.successfulPoints}
                  onViewOnMap={onViewGroup}
                  onSelectLocation={onSelectLocation}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ResultsSkeleton() {
  return (
    <div aria-hidden className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex gap-3 px-5 py-4">
          <span className="mt-1 size-4 animate-pulse rounded-full bg-line motion-reduce:animate-none" />
          <div className="flex-1 space-y-2">
            <span className="block h-4 w-48 animate-pulse rounded bg-line motion-reduce:animate-none" />
            <span className="block h-3 w-72 max-w-full animate-pulse rounded bg-line motion-reduce:animate-none" />
            <span className="block h-3 w-40 animate-pulse rounded bg-line motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}
