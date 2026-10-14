import type { WeatherErrorCode } from "./errors";
import type { ApiErrorBody } from "./http-response";
import type { WeatherMonitor } from "./monitor-store";
import type { NotificationStatus } from "./notifications";
import type { CheckRequest, CreateMonitorRequest, FieldIssue, UpdateMonitorRequest } from "./schemas";
import type { WeatherCheckResult, WeatherDataPortion, ZipCoordinates } from "./types";

/** Browser-side wrapper around this app's own API. All weather data is fetched server-side. */

export class ApiError extends Error {
  constructor(
    readonly code: WeatherErrorCode | "ABORTED",
    message: string,
    readonly status: number | null = null,
    readonly fields: FieldIssue[] = [],
    readonly source: WeatherDataPortion | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const CHECK_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;

async function request<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: rest.body ? { "Content-Type": "application/json" } : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    if (signal?.aborted) throw new ApiError("ABORTED", "Request cancelled.");
    if (timeout.aborted) {
      throw new ApiError("TIMEOUT", "The request took too long. Check your connection and try again.");
    }
    throw new ApiError("NETWORK", "Could not reach the server. Check your connection and try again.");
  }

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      error?.code ?? "INTERNAL",
      error?.message ?? `The server returned an unexpected response (${response.status}).`,
      response.status,
      error?.fields ?? [],
      error?.source ?? null,
    );
  }
  return body as T;
}

export const api = {
  geocode(zip: string, signal?: AbortSignal) {
    return request<ZipCoordinates>(`/api/weather/geocode?zip=${encodeURIComponent(zip)}`, { signal });
  },

  check(body: CheckRequest, signal?: AbortSignal) {
    return request<WeatherCheckResult>("/api/weather/check", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      timeoutMs: CHECK_TIMEOUT_MS,
    });
  },

  listMonitors(signal?: AbortSignal) {
    return request<{ monitors: WeatherMonitor[]; notifications: NotificationStatus }>("/api/weather/monitors", {
      signal,
    });
  },

  async createMonitor(body: CreateMonitorRequest) {
    const response = await request<{ monitor: WeatherMonitor }>("/api/weather/monitors", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    return response.monitor;
  },

  async updateMonitor(id: string, patch: UpdateMonitorRequest) {
    const response = await request<{ monitor: WeatherMonitor }>(`/api/weather/monitors/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return response.monitor;
  },

  deleteMonitor(id: string) {
    return request<void>(`/api/weather/monitors/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}
