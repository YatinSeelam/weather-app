"use client";

import type { FormEvent } from "react";
import {
  EMAIL_MODE_LABELS,
  EMAIL_MODE_OPTIONS,
  INTERVAL_OPTIONS,
  RADIUS_OPTIONS,
  RISK_SELECTION_LABELS,
} from "@/lib/weather/constants";
import { formatInterval } from "@/lib/weather/format";
import { RISK_SELECTIONS, type EmailMode, type MonitorInterval, type RiskSelection } from "@/lib/weather/types";
import { MapPinIcon, Spinner } from "./icons";
import { SegmentedControl } from "./segmented-control";
import type { ZipLookup } from "./use-weather";

export type MonitorFormValues = {
  zipCode: string;
  radiusMiles: number;
  intervalMinutes: MonitorInterval;
  risks: RiskSelection[];
  /** Raw text as typed; split into addresses when the monitor is saved. */
  emails: string;
  emailMode: EmailMode;
};

export type FormErrors = { zipCode?: string; risks?: string; emails?: string };

export type SaveFeedback = { tone: "success" | "error"; text: string };

type Props = {
  values: MonitorFormValues;
  onChange: (patch: Partial<MonitorFormValues>) => void;
  zipLookup: ZipLookup;
  errors: FormErrors;
  onCheck: () => void;
  checking: boolean;
  stageLabel: string | null;
  /** The save action appears once a check has run for a location. */
  showSave: boolean;
  onSave: () => void;
  saving: boolean;
  saveFeedback: SaveFeedback | null;
};

const RADIUS_CHOICES = RADIUS_OPTIONS.map((miles) => ({ value: miles, label: `${miles} mi` }));
const INTERVAL_CHOICES = INTERVAL_OPTIONS.map((minutes) => ({ value: minutes, label: formatInterval(minutes) }));
const EMAIL_MODE_CHOICES = EMAIL_MODE_OPTIONS.map((mode) => ({ value: mode, label: EMAIL_MODE_LABELS[mode] }));

export function describeEmailMode(mode: EmailMode, intervalMinutes: MonitorInterval): string {
  return mode === "every-check"
    ? `An email after every check, every ${formatInterval(intervalMinutes).toLowerCase()}, even when nothing changed.`
    : "An email only when a risk is new, escalated or updated.";
}

function ZipHint({ lookup, error }: { lookup: ZipLookup; error?: string }) {
  if (error) return <span className="text-critical-ink">{error}</span>;
  if (lookup.status === "loading") return <span>Looking up ZIP code…</span>;
  if (lookup.status === "error") return <span className="text-critical-ink">{lookup.error}</span>;
  if (lookup.status === "ready" && lookup.location) {
    return (
      <span className="inline-flex items-center gap-1 text-ink">
        <MapPinIcon width={14} height={14} className="text-accent" />
        {lookup.location.city}, {lookup.location.state}
      </span>
    );
  }
  return <span>5-digit U.S. ZIP code</span>;
}

export function MonitorForm({
  values,
  onChange,
  zipLookup,
  errors,
  onCheck,
  checking,
  stageLabel,
  showSave,
  onSave,
  saving,
  saveFeedback,
}: Props) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onCheck();
  };

  const toggleRisk = (risk: RiskSelection, checked: boolean) => {
    const next = checked ? [...values.risks, risk] : values.risks.filter((r) => r !== risk);
    onChange({ risks: RISK_SELECTIONS.filter((r) => next.includes(r)) });
  };

  const zipInvalid = Boolean(errors.zipCode) || zipLookup.status === "error";

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Monitor settings"
      className="rounded-xl border border-line bg-surface p-5"
    >
      <div className="space-y-5">
        <div>
          <label htmlFor="zip-code" className="text-[13px] font-medium text-ink">
            Location
          </label>
          <input
            id="zip-code"
            name="zipCode"
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            placeholder="ZIP code"
            maxLength={5}
            value={values.zipCode}
            onChange={(event) => onChange({ zipCode: event.target.value.replace(/\D/g, "").slice(0, 5) })}
            aria-invalid={zipInvalid}
            aria-describedby="zip-code-hint"
            className="mt-2 block h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-[15px] tabular-nums text-ink placeholder:text-ink-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent aria-invalid:border-critical"
          />
          <p id="zip-code-hint" aria-live="polite" className="mt-1.5 min-h-5 text-[13px] text-ink-muted">
            <ZipHint lookup={zipLookup} error={errors.zipCode} />
          </p>
        </div>

        <SegmentedControl
          legend="Radius"
          name="radius"
          options={RADIUS_CHOICES}
          value={values.radiusMiles}
          onChange={(radiusMiles) => onChange({ radiusMiles })}
        />

        <SegmentedControl
          legend="Check every"
          name="interval"
          options={INTERVAL_CHOICES}
          value={values.intervalMinutes}
          onChange={(intervalMinutes) => onChange({ intervalMinutes })}
        />

        <fieldset aria-describedby={errors.risks ? "risks-error" : undefined}>
          <legend className="text-[13px] font-medium text-ink">Watch for</legend>
          <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            {RISK_SELECTIONS.map((risk) => (
              <label key={risk} className="flex cursor-pointer items-center gap-2.5 py-1 text-sm text-ink">
                <input
                  type="checkbox"
                  name="risks"
                  value={risk}
                  checked={values.risks.includes(risk)}
                  onChange={(event) => toggleRisk(risk, event.target.checked)}
                  className="size-4 shrink-0 accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                {RISK_SELECTION_LABELS[risk]}
              </label>
            ))}
          </div>
          {errors.risks && (
            <p id="risks-error" className="mt-1.5 text-[13px] text-critical-ink">
              {errors.risks}
            </p>
          )}
        </fieldset>

        <div>
          <label htmlFor="monitor-emails" className="text-[13px] font-medium text-ink">
            Email updates to
          </label>
          <textarea
            id="monitor-emails"
            name="emails"
            rows={2}
            autoComplete="email"
            placeholder="you@example.com, teammate@example.com"
            value={values.emails}
            onChange={(event) => onChange({ emails: event.target.value })}
            aria-invalid={Boolean(errors.emails)}
            aria-describedby="monitor-emails-hint"
            className="mt-2 block w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-[15px] text-ink placeholder:text-ink-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent aria-invalid:border-critical"
          />
          <p id="monitor-emails-hint" className="mt-1.5 min-h-5 text-[13px] text-ink-muted">
            {errors.emails ? (
              <span className="text-critical-ink">{errors.emails}</span>
            ) : (
              "Optional. Separate several addresses with commas. Applies to the saved monitor only."
            )}
          </p>
          <div className="mt-3">
            <SegmentedControl
              legend="Send email"
              name="email-mode"
              options={EMAIL_MODE_CHOICES}
              value={values.emailMode}
              onChange={(emailMode) => onChange({ emailMode })}
            />
            <p className="mt-1.5 text-[13px] leading-5 text-ink-muted">
              {describeEmailMode(values.emailMode, values.intervalMinutes)}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-2">
        <button
          type="submit"
          disabled={checking}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-white transition-colors hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-progress disabled:bg-ink/70"
        >
          {checking && <Spinner />}
          {checking ? "Checking weather" : "Check weather"}
        </button>

        {showSave && (
          <button
            type="button"
            onClick={onSave}
            disabled={saving || checking}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-ink-faint"
          >
            {saving && <Spinner />}
            {saving ? "Saving monitor" : "Save monitor"}
          </button>
        )}

        <p role="status" aria-live="polite" className="min-h-5 text-[13px] text-ink-muted">
          {checking && stageLabel}
          {!checking && saveFeedback && (
            <span className={saveFeedback.tone === "error" ? "text-critical-ink" : "text-ink"}>{saveFeedback.text}</span>
          )}
        </p>
      </div>
    </form>
  );
}
