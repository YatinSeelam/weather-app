import type { WeatherDataPortion } from "./types";

export type WeatherErrorCode =
  | "INVALID_INPUT"
  | "ZIP_NOT_FOUND"
  | "GEOCODING_FAILED"
  | "NWS_UNAVAILABLE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INTERNAL";

const HTTP_STATUS: Record<WeatherErrorCode, number> = {
  INVALID_INPUT: 400,
  ZIP_NOT_FOUND: 404,
  GEOCODING_FAILED: 502,
  NWS_UNAVAILABLE: 502,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  NETWORK: 502,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  INTERNAL: 500,
};

export class WeatherError extends Error {
  readonly code: WeatherErrorCode;
  readonly retryAfterSeconds?: number;
  /** Set when a live data source failed, so callers can say which one. */
  readonly source?: WeatherDataPortion;

  constructor(
    code: WeatherErrorCode,
    message: string,
    options?: { retryAfterSeconds?: number; cause?: unknown; source?: WeatherDataPortion },
  ) {
    super(message, { cause: options?.cause });
    this.name = "WeatherError";
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.source = options?.source;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

export function isWeatherError(error: unknown): error is WeatherError {
  return error instanceof WeatherError;
}
