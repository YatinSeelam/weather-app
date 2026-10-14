type Option<T> = { value: T; label: string };

type Props<T extends string | number> = {
  legend: string;
  name: string;
  options: ReadonlyArray<Option<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Hide the legend visually when the surrounding heading already names the group. */
  hideLegend?: boolean;
};

/** A radio group drawn as a segmented control. Native radios keep arrow-key navigation. */
export function SegmentedControl<T extends string | number>({
  legend,
  name,
  options,
  value,
  onChange,
  hideLegend = false,
}: Props<T>) {
  return (
    <fieldset className="min-w-0">
      <legend className={hideLegend ? "sr-only" : "text-[13px] font-medium text-ink"}>{legend}</legend>
      <div
        className={`grid auto-cols-fr grid-flow-col gap-0.5 rounded-lg border border-line bg-canvas p-0.5 ${hideLegend ? "" : "mt-2"}`}
      >
        {options.map((option) => (
          <label key={option.value} className="cursor-pointer">
            <input
              type="radio"
              name={name}
              className="peer sr-only"
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span className="block whitespace-nowrap rounded-md px-2.5 py-1.5 text-center text-[13px] font-medium text-ink-muted transition-colors peer-checked:bg-surface peer-checked:text-ink peer-checked:shadow-[0_0_0_1px_var(--color-line-strong)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent hover:text-ink">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
