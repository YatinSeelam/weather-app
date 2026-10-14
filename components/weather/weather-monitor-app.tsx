"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ApiError } from "@/lib/weather/api-client";
import { formatDateTime } from "@/lib/weather/format";
import { errorMessage } from "@/lib/weather/api-client";
import {
  DEFAULT_EMAIL_MODE,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_RADIUS_MILES,
  DEFAULT_ZIP_CODE,
  MAX_MONITOR_EMAILS,
} from "@/lib/weather/constants";
import { looksLikeEmail, splitEmailList } from "@/lib/weather/email-list";
import type { WeatherMonitor } from "@/lib/weather/monitor-store";
import { RISK_SELECTIONS, type MonitorInterval, type WeatherCheckResult } from "@/lib/weather/types";
import {
  buildRiskItems,
  describeSelection,
  type DetectedGroupItem,
  type SelectionRequest,
  type SourceFilter,
  type TypeFilter,
} from "@/lib/weather/view-model";
import { Spinner } from "./icons";
import { MonitorForm, type FormErrors, type MonitorFormValues, type SaveFeedback } from "./monitor-form";
import { SavedMonitors } from "./saved-monitors";
import { CHECK_STAGES, isZipCode, useMonitors, useWeatherCheck, useZipLocation } from "./use-weather";
import type { MapCenter } from "./weather-map";
import { ResultsSkeleton, WeatherResults } from "./weather-results";
import { WeatherSummary } from "./weather-summary";

const WeatherMap = dynamic(() => import("./weather-map").then((module) => module.WeatherMap), {
  ssr: false,
  loading: () => (
    <div className="grid h-[360px] place-items-center rounded-xl border border-line bg-canvas text-sm text-ink-muted sm:h-[460px]">
      Loading map…
    </div>
  ),
});

const DEFAULT_FORM: MonitorFormValues = {
  zipCode: DEFAULT_ZIP_CODE,
  radiusMiles: DEFAULT_RADIUS_MILES,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  risks: [...RISK_SELECTIONS],
  emails: "",
  emailMode: DEFAULT_EMAIL_MODE,
};

const ERROR_TITLES: Partial<Record<ApiError["code"], string>> = {
  INVALID_INPUT: "Check the monitor settings",
  ZIP_NOT_FOUND: "ZIP code not found",
  GEOCODING_FAILED: "ZIP code lookup is unavailable",
  NWS_UNAVAILABLE: "The National Weather Service is temporarily unavailable",
  RATE_LIMITED: "Too many requests",
  TIMEOUT: "The weather check timed out",
  NETWORK: "Connection problem",
};

/** Errors caused by what was typed, as opposed to a data source being down. */
const INPUT_ERRORS: ReadonlySet<ApiError["code"]> = new Set(["INVALID_INPUT", "ZIP_NOT_FOUND"]);

function validate(values: MonitorFormValues): FormErrors {
  const errors: FormErrors = {};
  if (!isZipCode(values.zipCode)) errors.zipCode = "Enter a 5-digit U.S. ZIP code.";
  if (values.risks.length === 0) errors.risks = "Choose at least one weather risk.";
  const emails = splitEmailList(values.emails);
  const bad = emails.find((email) => !looksLikeEmail(email));
  if (bad) errors.emails = `"${bad}" is not a valid email address.`;
  else if (emails.length > MAX_MONITOR_EMAILS) errors.emails = `At most ${MAX_MONITOR_EMAILS} addresses per monitor.`;
  return errors;
}

function isStale(result: WeatherCheckResult, values: MonitorFormValues): boolean {
  return (
    result.center.zipCode !== values.zipCode ||
    result.radiusMiles !== values.radiusMiles ||
    result.risks.length !== values.risks.length ||
    result.risks.some((risk) => !values.risks.includes(risk))
  );
}

function Notice({ tone, children }: { tone: "warning" | "neutral"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "warning" ? "status" : undefined}
      className={`rounded-lg border px-4 py-2.5 text-[13px] leading-5 ${
        tone === "warning" ? "border-moderate/40 bg-moderate-soft text-moderate-ink" : "border-line bg-surface text-ink-muted"
      }`}
    >
      {children}
    </div>
  );
}

export function WeatherMonitorApp() {
  const [values, setValues] = useState<MonitorFormValues>(DEFAULT_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [selection, setSelection] = useState<SelectionRequest | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback | null>(null);
  const [busyMonitorId, setBusyMonitorId] = useState<string | null>(null);
  const [monitorError, setMonitorError] = useState<string | null>(null);

  const zipLookup = useZipLocation(values.zipCode);
  const { state: check, run: runCheck, lastSuccess } = useWeatherCheck();
  const monitors = useMonitors();

  const selectionSeq = useRef(0);
  const mapSectionRef = useRef<HTMLDivElement>(null);

  const result = check.status === "success" ? check.result : null;
  const checking = check.status === "loading";
  const items = useMemo(() => (result ? buildRiskItems(result) : []), [result]);
  const mapSelection = useMemo(
    () => (result && selection ? describeSelection(result, selection) : null),
    [result, selection],
  );

  const mapCenter = useMemo<MapCenter | null>(() => {
    const location = zipLookup.location ?? zipLookup.lastLocation;
    if (location) {
      return {
        latitude: location.latitude,
        longitude: location.longitude,
        label: `${location.zip}, ${location.city}, ${location.state}`,
      };
    }
    if (result) {
      const { center } = result;
      return {
        latitude: center.latitude,
        longitude: center.longitude,
        label: `${center.zipCode}, ${center.city}, ${center.state}`,
      };
    }
    return null;
  }, [zipLookup.location, zipLookup.lastLocation, result]);

  const startCheck = useCallback(
    (next: MonitorFormValues) => {
      const problems = validate(next);
      setErrors(problems);
      if (Object.keys(problems).length > 0) return;
      setSelection(null);
      setSourceFilter("all");
      setTypeFilter("all");
      setSaveFeedback(null);
      void runCheck({ zipCode: next.zipCode, radiusMiles: next.radiusMiles, risks: next.risks });
    },
    [runCheck],
  );

  const handleChange = (patch: Partial<MonitorFormValues>) => {
    setValues((previous) => ({ ...previous, ...patch }));
    setErrors((previous) => ({
      zipCode: patch.zipCode !== undefined ? undefined : previous.zipCode,
      risks: patch.risks !== undefined ? undefined : previous.risks,
      emails: patch.emails !== undefined ? undefined : previous.emails,
    }));
    setSaveFeedback(null);
  };

  const select = (id: string, origin: SelectionRequest["origin"], frameGroup = false) => {
    selectionSeq.current += 1;
    setSelection({ id, origin, frameGroup, seq: selectionSeq.current });
  };

  const handleMapSelect = useCallback((id: string) => {
    // Make sure the matching row is not hidden by a filter.
    setSourceFilter("all");
    setTypeFilter("all");
    selectionSeq.current += 1;
    setSelection({ id, origin: "map", seq: selectionSeq.current });
  }, []);

  const viewOnMap = (id: string, frameGroup = false) => {
    select(id, "list", frameGroup);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    mapSectionRef.current?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  };

  const handleSave = async () => {
    const problems = validate(values);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setSaving(true);
    setSaveFeedback(null);
    try {
      const monitor = await monitors.create({
        zipCode: values.zipCode,
        radiusMiles: values.radiusMiles,
        risks: values.risks,
        intervalMinutes: values.intervalMinutes,
        emails: splitEmailList(values.emails),
        emailMode: values.emailMode,
      });
      const who = monitor.emails.length > 0 ? ` Updates go to ${monitor.emails.join(", ")}.` : "";
      setSaveFeedback({ tone: "success", text: `Monitor saved. ${monitor.name} is now checked automatically.${who}` });
    } catch (error) {
      setSaveFeedback({ tone: "error", text: `Monitor not saved. ${errorMessage(error)}` });
    } finally {
      setSaving(false);
    }
  };

  const withMonitor = async (monitor: WeatherMonitor, action: () => Promise<unknown>) => {
    setBusyMonitorId(monitor.id);
    setMonitorError(null);
    try {
      await action();
    } catch (error) {
      setMonitorError(errorMessage(error));
    } finally {
      setBusyMonitorId(null);
    }
  };

  const handleViewMonitor = (monitor: WeatherMonitor) => {
    const next: MonitorFormValues = {
      zipCode: monitor.zipCode,
      radiusMiles: monitor.radiusMiles,
      intervalMinutes: monitor.intervalMinutes,
      risks: RISK_SELECTIONS.filter((risk) => monitor.riskTypes.includes(risk)),
      emails: monitor.emails.join(", "),
      emailMode: monitor.emailMode,
    };
    setValues(next);
    startCheck(next);
  };

  const stale = result !== null && !checking && isStale(result, values);

  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 pb-16 pt-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="text-[28px] font-semibold leading-9 tracking-tight text-ink">Weather Monitoring</h1>
        <p className="mt-1 text-[15px] text-ink-muted">
          Monitor severe weather conditions and alerts within a selected radius.
        </p>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="space-y-6">
          <MonitorForm
            values={values}
            onChange={handleChange}
            zipLookup={zipLookup}
            errors={errors}
            onCheck={() => startCheck(values)}
            checking={checking}
            stageLabel={check.status === "loading" ? CHECK_STAGES[check.stage] : null}
            showSave={result !== null}
            onSave={handleSave}
            saving={saving}
            saveFeedback={saveFeedback}
          />
          <SavedMonitors
            status={monitors.status}
            monitors={monitors.monitors}
            error={monitors.error}
            notifications={monitors.notifications}
            busyId={busyMonitorId}
            actionError={monitorError}
            onView={handleViewMonitor}
            onToggle={(monitor, enabled) => withMonitor(monitor, () => monitors.update(monitor.id, { enabled }))}
            onInterval={(monitor, intervalMinutes: MonitorInterval) =>
              withMonitor(monitor, () => monitors.update(monitor.id, { intervalMinutes }))
            }
            onEmails={(monitor, emails, emailMode) =>
              withMonitor(monitor, () => monitors.update(monitor.id, { emails, emailMode }))
            }
            onDelete={(monitor) => withMonitor(monitor, () => monitors.remove(monitor.id))}
          />
        </aside>

        <main className="min-w-0 space-y-4">
          <WeatherSummary result={result} loading={checking} />

          {stale && (
            <Notice tone="neutral">
              Settings changed since this check. Results below are for {result.center.zipCode} within{" "}
              {result.radiusMiles} miles. Check weather to update them.
            </Notice>
          )}
          {result?.warnings.map((warning) => (
            <Notice key={warning} tone="warning">
              {warning}
            </Notice>
          ))}
          {result?.notes.map((note) => (
            <Notice key={note} tone="neutral">
              {note}
            </Notice>
          ))}

          <div ref={mapSectionRef} className="relative scroll-mt-4">
            <WeatherMap
              center={mapCenter}
              radiusMiles={values.radiusMiles}
              alerts={result?.officialAlerts ?? EMPTY_ALERTS}
              risks={result?.detectedRisks ?? EMPTY_RISKS}
              selection={mapSelection}
              onSelect={handleMapSelect}
              viewKey={result?.checkedAt ?? ""}
            />
            {check.status === "loading" && (
              <p className="absolute left-3 top-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink shadow-sm">
                <Spinner className="text-accent" />
                {CHECK_STAGES[check.stage]}
              </p>
            )}
          </div>

          {result && !checking && (
            <dl className="flex flex-wrap gap-x-6 gap-y-1 px-1 text-xs text-ink-muted">
              <div className="flex gap-1.5">
                <dt>Data source</dt>
                <dd className="font-medium text-ink">{result.source.providers.alerts}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt>Last updated</dt>
                <dd className="font-medium text-ink tabular-nums">
                  {formatDateTime(result.source.fetchedAt ?? result.checkedAt)}
                </dd>
              </div>
            </dl>
          )}

          {check.status === "idle" && (
            <div className="rounded-xl border border-dashed border-line-strong px-6 py-8 text-center">
              <p className="text-sm font-semibold text-ink">Nothing checked yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-ink-muted">
                Choose a ZIP code and radius, then check weather to see official alerts and detected risks inside the
                circle.
              </p>
            </div>
          )}

          {check.status === "loading" && <ResultsSkeleton />}

          {check.status === "error" && (
            <div role="alert" className="rounded-xl border border-critical/30 bg-critical-soft px-5 py-4">
              <p className="text-sm font-semibold text-critical-ink">
                {check.source
                  ? "Live weather data is temporarily unavailable"
                  : (ERROR_TITLES[check.code] ?? "The weather check failed")}
              </p>
              <p className="mt-1 text-sm text-ink">{check.message}</p>
              {!INPUT_ERRORS.has(check.code) && (
                <p className="mt-1 text-sm text-ink">
                  This is not an all-clear. The check could not be completed, so no result is shown.
                </p>
              )}
              {!INPUT_ERRORS.has(check.code) && lastSuccess && (
                <p className="mt-1 text-[13px] text-ink-muted tabular-nums">
                  Last successful check: {formatDateTime(lastSuccess.checkedAt)} ({lastSuccess.zipCode},{" "}
                  {lastSuccess.radiusMiles} mi)
                </p>
              )}
              <button
                type="button"
                onClick={() => startCheck(values)}
                className="mt-3 h-8 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-semibold text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Check weather again
              </button>
            </div>
          )}

          {result && !checking && (
            <WeatherResults
              result={result}
              items={items}
              selectedId={selection?.id ?? null}
              scrollRequest={selection?.origin === "map" ? { id: selection.id, seq: selection.seq } : null}
              sourceFilter={sourceFilter}
              typeFilter={typeFilter}
              onSourceFilter={setSourceFilter}
              onTypeFilter={setTypeFilter}
              onViewAlert={(id) => viewOnMap(id)}
              onViewGroup={(item: DetectedGroupItem) => viewOnMap(item.risks[0].id, true)}
              onSelectLocation={(id) => viewOnMap(id)}
            />
          )}
        </main>
      </div>

      <footer className="mt-10 border-t border-line pt-4 text-xs leading-5 text-ink-muted">
        <p>Weather data and alerts from NOAA / National Weather Service.</p>
        <p>
          Official alerts are issued by the NWS. Detected risks are calculated by this app from NWS forecast grid data
          and are not official warnings. ZIP code locations from Zippopotam.us. Map data © OpenStreetMap contributors,
          served by OpenFreeMap.
        </p>
      </footer>
    </div>
  );
}

const EMPTY_ALERTS: WeatherCheckResult["officialAlerts"] = [];
const EMPTY_RISKS: WeatherCheckResult["detectedRisks"] = [];
