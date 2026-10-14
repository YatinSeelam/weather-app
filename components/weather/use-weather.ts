"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/weather/api-client";
import type { WeatherMonitor } from "@/lib/weather/monitor-store";
import type { CheckRequest, CreateMonitorRequest, UpdateMonitorRequest } from "@/lib/weather/schemas";
import type { NotificationStatus } from "@/lib/weather/notifications";
import type { WeatherCheckResult, WeatherDataPortion, ZipCoordinates } from "@/lib/weather/types";

const ZIP_PATTERN = /^\d{5}$/;
export const isZipCode = (value: string) => ZIP_PATTERN.test(value);

// ---------------------------------------------------------------------------
// ZIP preview: resolves the ZIP as soon as it is complete so the map can show the radius.
// ---------------------------------------------------------------------------

export type ZipLookup = {
  status: "idle" | "loading" | "ready" | "error";
  location: ZipCoordinates | null;
  /** The most recent successful lookup, kept so the map does not jump away while typing. */
  lastLocation: ZipCoordinates | null;
  error: string | null;
};

type LookupResult = { zip: string; location: ZipCoordinates | null; error: string | null };

export function useZipLocation(zip: string): ZipLookup {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [lastLocation, setLastLocation] = useState<ZipCoordinates | null>(null);
  const valid = isZipCode(zip);

  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.geocode(zip, controller.signal).then(
        (location) => {
          setResult({ zip, location, error: null });
          setLastLocation(location);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setResult({ zip, location: null, error: errorMessage(error) });
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [zip, valid]);

  const current = valid && result?.zip === zip ? result : null;
  return {
    status: !valid ? "idle" : !current ? "loading" : current.location ? "ready" : "error",
    location: current?.location ?? null,
    lastLocation,
    error: current?.error ?? null,
  };
}

// ---------------------------------------------------------------------------
// Weather check
// ---------------------------------------------------------------------------

export const CHECK_STAGES = [
  "Resolving ZIP code…",
  "Checking active weather alerts…",
  "Evaluating conditions across the radius…",
] as const;

export type CheckState =
  | { status: "idle" }
  | { status: "loading"; stage: number }
  | { status: "success"; result: WeatherCheckResult }
  | { status: "error"; code: ApiError["code"]; message: string; source: WeatherDataPortion | null };

/** The most recent check that completed, kept so a later failure can say when data was last good. */
export type LastSuccess = { checkedAt: string; zipCode: string; radiusMiles: number };

export function useWeatherCheck() {
  const [state, setState] = useState<CheckState>({ status: "idle" });
  const [lastSuccess, setLastSuccess] = useState<LastSuccess | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const run = useCallback(async (request: CheckRequest) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState({ status: "loading", stage: 0 });
    // The check is one request; the stages advance on a timer to show what the server is working through.
    const advance = (stage: number) => () =>
      setState((previous) => (previous.status === "loading" ? { status: "loading", stage } : previous));
    const timers = [setTimeout(advance(1), 500), setTimeout(advance(2), 1800)];

    try {
      const result = await api.check(request, controller.signal);
      if (controller.signal.aborted) return;
      setState({ status: "success", result });
      setLastSuccess({
        checkedAt: result.checkedAt,
        zipCode: result.center.zipCode,
        radiusMiles: result.radiusMiles,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        code: error instanceof ApiError ? error.code : "INTERNAL",
        message: errorMessage(error),
        source: error instanceof ApiError ? error.source : null,
      });
    } finally {
      timers.forEach(clearTimeout);
    }
  }, []);

  return { state, run, lastSuccess };
}

// ---------------------------------------------------------------------------
// Saved monitors
// ---------------------------------------------------------------------------

const MONITOR_REFRESH_MS = 60_000;

export type MonitorsState = {
  /** "locked": the server wants the access key. "unconfigured": the server has no access key set. */
  status: "loading" | "ready" | "error" | "locked" | "unconfigured";
  monitors: WeatherMonitor[];
  error: string | null;
  /** Null until the server has answered. */
  notifications: NotificationStatus | null;
};

const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401;
const LOCKED_OUT = { monitors: [], error: null, notifications: null };

export function useMonitors() {
  const [state, setState] = useState<MonitorsState>({
    status: "loading",
    monitors: [],
    error: null,
    notifications: null,
  });
  const lockedRef = useRef(false);

  useEffect(() => {
    lockedRef.current = state.status === "locked" || state.status === "unconfigured";
  }, [state.status]);

  /** After a 401: drop whatever was shown and find out whether to ask for the access key. */
  const lockOut = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "locked", ...LOCKED_OUT });
    try {
      const access = await api.monitorAccess(signal);
      if (!access.configured) setState({ status: "unconfigured", ...LOCKED_OUT });
    } catch {
      // Stay locked; the unlock form reports any real problem.
    }
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const { monitors, notifications } = await api.listMonitors(signal);
        setState({ status: "ready", monitors, error: null, notifications });
      } catch (error) {
        if (signal?.aborted) return;
        if (isUnauthorized(error)) return lockOut(signal);
        setState((previous) => ({ ...previous, status: "error", error: errorMessage(error) }));
      }
    },
    [lockOut],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    // Keeps "last checked" current while the scheduler works in the background. Paused while
    // locked so an open tab does not keep knocking.
    const timer = setInterval(() => {
      if (!lockedRef.current) void refresh(controller.signal);
    }, MONITOR_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  /** Runs a monitor request; a 401 (session expired, key rotated) locks the panel again. */
  const guarded = useCallback(
    async <T>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (error) {
        if (isUnauthorized(error)) void lockOut();
        throw error;
      }
    },
    [lockOut],
  );

  const replace = (monitor: WeatherMonitor) =>
    setState((previous) => ({
      ...previous,
      status: "ready",
      error: null,
      monitors: previous.monitors.some((m) => m.id === monitor.id)
        ? previous.monitors.map((m) => (m.id === monitor.id ? monitor : m))
        : [monitor, ...previous.monitors],
    }));

  const create = useCallback(
    (request: CreateMonitorRequest) =>
      guarded(async () => {
        const monitor = await api.createMonitor(request);
        replace(monitor);
        return monitor;
      }),
    [guarded],
  );

  const update = useCallback(
    (id: string, patch: UpdateMonitorRequest) =>
      guarded(async () => {
        const monitor = await api.updateMonitor(id, patch);
        replace(monitor);
        return monitor;
      }),
    [guarded],
  );

  const remove = useCallback(
    (id: string) =>
      guarded(async () => {
        await api.deleteMonitor(id);
        setState((previous) => ({ ...previous, monitors: previous.monitors.filter((m) => m.id !== id) }));
      }),
    [guarded],
  );

  const unlock = useCallback(
    async (secret: string) => {
      await api.unlockMonitors(secret);
      setState({ status: "loading", ...LOCKED_OUT });
      await refresh();
    },
    [refresh],
  );

  const lock = useCallback(async () => {
    await api.lockMonitors();
    setState({ status: "locked", ...LOCKED_OUT });
  }, []);

  return { ...state, create, update, remove, refresh, unlock, lock };
}
