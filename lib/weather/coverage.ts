import type { CoverageStatus, WeatherDataSource } from "./types";

const seen = (status: CoverageStatus) => status === "complete" || status === "not-requested";

/**
 * False when part of the live data was missing. An empty result from an incomplete check is
 * "unable to check", never "all clear".
 */
export function isCheckComplete(source: Pick<WeatherDataSource, "coverage">): boolean {
  return seen(source.coverage.alerts) && seen(source.coverage.forecasts);
}
