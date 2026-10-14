import type { ZodError } from "zod";
import { isWeatherError, WeatherError, type WeatherErrorCode } from "./errors";
import type { WeatherDataPortion } from "./types";
import { fieldIssues, type FieldIssue } from "./schemas";

/** Every API error has this shape. */
export type ApiErrorBody = {
  error: {
    code: WeatherErrorCode;
    message: string;
    fields?: FieldIssue[];
    /** Which live data source failed, when the error is an outage. */
    source?: WeatherDataPortion;
  };
};

const NO_STORE = { "Cache-Control": "no-store" };

export function jsonResponse<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function errorResponse(error: unknown): Response {
  if (isWeatherError(error)) {
    const body: ApiErrorBody = {
      error: { code: error.code, message: error.message, ...(error.source ? { source: error.source } : {}) },
    };
    const headers: Record<string, string> = { ...NO_STORE };
    if (error.retryAfterSeconds) headers["Retry-After"] = String(error.retryAfterSeconds);
    return Response.json(body, { status: error.status, headers });
  }
  console.error("[weather] unexpected error", error);
  const body: ApiErrorBody = { error: { code: "INTERNAL", message: "Something went wrong on our side. Try again." } };
  return Response.json(body, { status: 500, headers: NO_STORE });
}

export function validationErrorResponse(error: ZodError): Response {
  const fields = fieldIssues(error);
  const body: ApiErrorBody = {
    error: { code: "INVALID_INPUT", message: fields[0]?.message ?? "The request is not valid.", fields },
  };
  return Response.json(body, { status: 400, headers: NO_STORE });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new WeatherError("INVALID_INPUT", "The request body must be valid JSON.");
  }
}
