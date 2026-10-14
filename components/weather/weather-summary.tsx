import type { ReactNode } from "react";
import { isCheckComplete } from "@/lib/weather/coverage";
import { formatClock, pluralize } from "@/lib/weather/format";
import { SEVERITY_LABELS } from "@/lib/weather/severity";
import type { WeatherCheckResult } from "@/lib/weather/types";
import { SeverityMark } from "./severity-badge";

type Props = {
  result: WeatherCheckResult | null;
  loading: boolean;
};

function Cell({ label, loading, children, detail }: { label: string; loading: boolean; children: ReactNode; detail?: string }) {
  return (
    <div className="bg-surface px-5 py-4">
      <dt className="text-[13px] text-ink-muted">{label}</dt>
      <dd className="mt-1 flex min-h-8 items-center gap-2 text-2xl font-semibold tracking-tight text-ink tabular-nums">
        {loading ? <span className="h-6 w-14 animate-pulse rounded bg-line motion-reduce:animate-none" /> : children}
      </dd>
      <dd className="mt-0.5 min-h-4 truncate text-xs text-ink-muted">{loading ? "" : detail}</dd>
    </div>
  );
}

const EMPTY = <span className="text-ink-faint">–</span>;

export function WeatherSummary({ result, loading }: Props) {
  const summary = result?.summary;
  const sampling = result?.sampling;
  // With data missing, "none" would overstate what the check actually saw.
  const incomplete = result ? !isCheckComplete(result.source) : false;

  return (
    <dl
      aria-label="Summary of the latest weather check"
      aria-busy={loading}
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4"
    >
      <Cell
        label="Active risks"
        loading={loading}
        detail={
          summary
            ? `${pluralize(summary.officialAlertCount, "official alert")}, ${summary.detectedRiskTypeCount} detected`
            : undefined
        }
      >
        {summary ? summary.totalActiveRisks : EMPTY}
      </Cell>

      <Cell
        label="Highest severity"
        loading={loading}
        detail={
          incomplete ? "Check incomplete" : summary && !summary.highestSeverity ? "Nothing active" : undefined
        }
      >
        {summary?.highestSeverity ? (
          <>
            <SeverityMark level={summary.highestSeverity} />
            {SEVERITY_LABELS[summary.highestSeverity]}
          </>
        ) : summary ? (
          incomplete ? (
            "Unknown"
          ) : (
            "None"
          )
        ) : (
          EMPTY
        )}
      </Cell>

      <Cell
        label="Locations affected"
        loading={loading}
        detail={summary ? "Alert areas and sample points" : undefined}
      >
        {summary ? summary.affectedLocations : EMPTY}
      </Cell>

      <Cell
        label="Last checked"
        loading={loading}
        detail={
          sampling && sampling.requestedPoints > 0
            ? `${sampling.successfulPoints} of ${sampling.requestedPoints} locations sampled`
            : undefined
        }
      >
        {result ? formatClock(result.checkedAt) : EMPTY}
      </Cell>
    </dl>
  );
}
