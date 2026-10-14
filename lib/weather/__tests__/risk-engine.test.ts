import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "../constants";
import {
  classifyApparentTemperature,
  classifyRain,
  classifyTemperature,
  classifyWind,
  evaluateRisks,
  summarizeWindow,
  type PointForecast,
  type SampleContext,
} from "../risk-engine";
import { parseIsoDurationMs, parseValidTime, type TimeInterval } from "../time-series";
import type { DetectedRiskType } from "../types";

const T = DEFAULT_THRESHOLDS;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-01-15T12:00:00Z");

const hourly = (values: number[], startHour = 0): TimeInterval[] =>
  values.map((value, index) => ({
    start: NOW + (startHour + index) * HOUR,
    end: NOW + (startHour + index + 1) * HOUR,
    value,
  }));

const forecast = (overrides: Partial<PointForecast>): PointForecast => ({
  temperatureF: [],
  apparentTemperatureF: [],
  windSpeedMph: [],
  windGustMph: [],
  precipitationIn: [],
  ...overrides,
});

const SAMPLE: SampleContext = {
  latitude: 41.93,
  longitude: -74.02,
  distanceMiles: 14,
  locationLabel: "Near Kingston, NY",
  gridKey: "ALY:70,30",
};
const ALL: ReadonlySet<DetectedRiskType> = new Set(["freezing", "high-wind", "heavy-rain"]);

const evaluate = (f: PointForecast, enabled = ALL) =>
  evaluateRisks(SAMPLE, summarizeWindow(f, NOW, T.lookaheadHours), T, enabled, new Date(NOW));

describe("NWS time parsing", () => {
  it("parses ISO-8601 durations", () => {
    expect(parseIsoDurationMs("PT1H")).toBe(HOUR);
    expect(parseIsoDurationMs("PT6H")).toBe(6 * HOUR);
    expect(parseIsoDurationMs("P1D")).toBe(24 * HOUR);
    expect(parseIsoDurationMs("P7DT13H")).toBe((7 * 24 + 13) * HOUR);
    expect(parseIsoDurationMs("PT30M")).toBe(HOUR / 2);
    expect(parseIsoDurationMs("six hours")).toBeNull();
    expect(parseIsoDurationMs("P")).toBeNull();
  });

  it("parses validTime ranges and rejects malformed ones", () => {
    expect(parseValidTime("2026-01-15T12:00:00+00:00/PT6H")).toEqual({ start: NOW, end: NOW + 6 * HOUR });
    expect(parseValidTime("2026-01-15T12:00:00+00:00")).toBeNull();
    expect(parseValidTime("not-a-date/PT1H")).toBeNull();
  });
});

describe("threshold classification", () => {
  it("flags freezing at or below 32°F, not above", () => {
    expect(classifyTemperature(33, T)).toBeNull();
    expect(classifyTemperature(32, T)).toBe("moderate");
    expect(classifyTemperature(15, T)).toBe("high");
    expect(classifyTemperature(-5, T)).toBe("critical");
    expect(classifyTemperature(null, T)).toBeNull();
  });

  it("flags dangerous feels-like temperatures", () => {
    expect(classifyApparentTemperature(11, T)).toBeNull();
    expect(classifyApparentTemperature(10, T)).toBe("high");
    expect(classifyApparentTemperature(-15, T)).toBe("critical");
  });

  it("flags wind on sustained speed OR gusts", () => {
    expect(classifyWind(29, 44, T)).toBeNull();
    expect(classifyWind(30, 10, T)).toBe("moderate");
    expect(classifyWind(5, 45, T)).toBe("moderate");
    expect(classifyWind(40, 20, T)).toBe("high");
    expect(classifyWind(10, 58, T)).toBe("high");
    expect(classifyWind(10, 75, T)).toBe("critical");
    expect(classifyWind(null, null, T)).toBeNull();
    expect(classifyWind(null, 50, T)).toBe("moderate");
  });

  it("flags heavy rain per 6 hours", () => {
    expect(classifyRain(0.99, T)).toBeNull();
    expect(classifyRain(1, T)).toBe("moderate");
    expect(classifyRain(2, T)).toBe("high");
    expect(classifyRain(4, T)).toBe("critical");
  });

  it("respects customized thresholds", () => {
    expect(classifyTemperature(35, { ...T, freezingTemperatureF: 36 })).toBe("moderate");
    expect(classifyWind(20, 0, { ...T, dangerousSustainedWindMph: 20 })).toBe("moderate");
  });
});

describe("forecast window", () => {
  it("only considers values inside the look-ahead window", () => {
    // Freezing arrives 20 hours from now: outside a 12 hour window.
    const temps = hourly([40, 39, 38], 0).concat(hourly([25], 20));
    const conditions = summarizeWindow(forecast({ temperatureF: temps }), NOW, 12);
    expect(conditions.minTemperatureF?.value).toBe(38);
    expect(summarizeWindow(forecast({ temperatureF: temps }), NOW, 24).minTemperatureF?.value).toBe(25);
  });

  it("includes the period that is already under way", () => {
    const started = [{ start: NOW - 30 * 60 * 1000, end: NOW + 30 * 60 * 1000, value: 20 }];
    expect(summarizeWindow(forecast({ temperatureF: started }), NOW, 6).minTemperatureF?.value).toBe(20);
  });

  it("keeps rain totals in the buckets NWS published and scales only longer periods", () => {
    const sixHour = [{ start: NOW, end: NOW + 6 * HOUR, value: 1.5 }];
    expect(summarizeWindow(forecast({ precipitationIn: sixHour }), NOW, 12).maxPrecipitation).toMatchObject({
      value: 1.5,
      periodHours: 6,
      inchesPer6h: 1.5,
    });

    const twelveHour = [{ start: NOW, end: NOW + 12 * HOUR, value: 1.5 }];
    expect(summarizeWindow(forecast({ precipitationIn: twelveHour }), NOW, 12).maxPrecipitation).toMatchObject({
      value: 1.5,
      periodHours: 12,
      inchesPer6h: 0.75,
    });

    const oneHour = [{ start: NOW, end: NOW + HOUR, value: 1.2 }];
    expect(summarizeWindow(forecast({ precipitationIn: oneHour }), NOW, 12).maxPrecipitation?.inchesPer6h).toBe(1.2);
  });
});

describe("risk evaluation", () => {
  it("returns nothing in mild weather", () => {
    expect(
      evaluate(forecast({ temperatureF: hourly([55, 54]), windSpeedMph: hourly([8]), windGustMph: hourly([15]) })),
    ).toEqual([]);
  });

  it("reports freezing temperatures with the observed value and threshold", () => {
    const [risk] = evaluate(forecast({ temperatureF: hourly([34, 27, 30]), apparentTemperatureF: hourly([30, 19, 24]) }));
    expect(risk).toMatchObject({
      id: "freezing:ALY:70,30",
      category: "detected-risk",
      riskType: "freezing",
      severity: "moderate",
      title: "Freezing temperatures",
      observedValue: 27,
      threshold: 32,
      unit: "°F",
      distanceMiles: 14,
      locationLabel: "Near Kingston, NY",
    });
    expect(risk.description).toBe("Low of 27°F, feels like 19°F in the next 12 hours.");
    expect(risk.validUntil).toBe(new Date(NOW + 2 * HOUR).toISOString());
  });

  it("lets a dangerous feels-like temperature raise the severity", () => {
    const [risk] = evaluate(forecast({ temperatureF: hourly([30]), apparentTemperatureF: hourly([8]) }));
    expect(risk.severity).toBe("high");
  });

  it("reports high wind when only gusts cross the line", () => {
    const [risk] = evaluate(forecast({ windSpeedMph: hourly([22]), windGustMph: hourly([38, 52]) }));
    expect(risk).toMatchObject({ riskType: "high-wind", severity: "moderate", observedValue: 52, threshold: 45, unit: "mph" });
    expect(risk.description).toBe("Gusts up to 52 mph, sustained wind up to 22 mph in the next 12 hours.");
  });

  it("reports high wind when only sustained wind crosses the line", () => {
    const [risk] = evaluate(forecast({ windSpeedMph: hourly([33]), windGustMph: hourly([40]) }));
    expect(risk).toMatchObject({ riskType: "high-wind", observedValue: 33, threshold: 30 });
  });

  it("reports heavy rain with the forecast period it applies to", () => {
    const [risk] = evaluate(forecast({ precipitationIn: [{ start: NOW, end: NOW + 6 * HOUR, value: 2.26 }] }));
    expect(risk).toMatchObject({ riskType: "heavy-rain", severity: "high", observedValue: 2.26, unit: "in" });
    expect(risk.description).toBe("2.26 in of rain forecast over 6 hours.");
  });

  it("only evaluates the risk types that are switched on", () => {
    const stormy = forecast({
      temperatureF: hourly([20]),
      windGustMph: hourly([60]),
      precipitationIn: [{ start: NOW, end: NOW + 6 * HOUR, value: 3 }],
    });
    expect(evaluate(stormy).map((risk) => risk.riskType)).toEqual(["freezing", "high-wind", "heavy-rain"]);
    expect(evaluate(stormy, new Set(["high-wind"])).map((risk) => risk.riskType)).toEqual(["high-wind"]);
    expect(evaluate(stormy, new Set())).toEqual([]);
  });
});
