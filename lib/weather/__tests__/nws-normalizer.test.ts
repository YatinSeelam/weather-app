import { describe, expect, it } from "vitest";
import {
  alertLevel,
  classifyNwsEvent,
  isAlertActive,
  normalizeAlertProperties,
  normalizeNwsSeverity,
} from "../nws-normalizer";
import { highestSeverity, maxSeverity, severityRank } from "../severity";
import { alertFeature, NOW } from "./fixtures";

describe("NWS event normalization", () => {
  it.each([
    ["Tornado Warning", "tornado"],
    ["Tornado Watch", "tornado"],
    ["Severe Thunderstorm Warning", "thunderstorm"],
    ["Severe Thunderstorm Watch", "thunderstorm"],
    ["Flood Warning", "flood"],
    ["Flash Flood Warning", "flood"],
    ["Coastal Flood Advisory", "flood"],
    ["Storm Surge Warning", "flood"],
    ["High Wind Warning", "wind"],
    ["Wind Advisory", "wind"],
    ["Lake Wind Advisory", "wind"],
    ["Gale Warning", "wind"],
    ["Hurricane Warning", "wind"],
    ["Tropical Storm Watch", "wind"],
    ["Winter Storm Warning", "winter"],
    ["Winter Weather Advisory", "winter"],
    ["Blizzard Warning", "winter"],
    ["Lake Effect Snow Warning", "winter"],
    ["Ice Storm Warning", "ice"],
    ["Freezing Rain Advisory", "ice"],
    ["Freeze Warning", "freeze"],
    ["Frost Advisory", "freeze"],
    ["Extreme Cold Warning", "freeze"],
    ["Wind Chill Advisory", "freeze"],
    ["Small Craft Advisory", "other"],
    ["Heat Advisory", "other"],
    ["Red Flag Warning", "other"],
    ["Dust Storm Warning", "other"],
    ["Dense Fog Advisory", "other"],
    ["Special Weather Statement", "other"],
  ] as const)("classifies %s as %s", (event, expected) => {
    expect(classifyNwsEvent(event)).toBe(expected);
  });

  it("ignores case", () => {
    expect(classifyNwsEvent("TORNADO WARNING")).toBe("tornado");
  });
});

describe("severity normalization", () => {
  it("maps NWS severities onto the shared scale", () => {
    expect(normalizeNwsSeverity("Extreme")).toBe("critical");
    expect(normalizeNwsSeverity("Severe")).toBe("high");
    expect(normalizeNwsSeverity("Moderate")).toBe("moderate");
    expect(normalizeNwsSeverity("Minor")).toBe("low");
    expect(normalizeNwsSeverity("Unknown")).toBe("info");
    expect(normalizeNwsSeverity(null)).toBe("info");
    expect(normalizeNwsSeverity("something new")).toBe("info");
  });

  it("always treats a Tornado Warning as critical", () => {
    expect(alertLevel("Tornado Warning", "Severe")).toBe("critical");
    expect(alertLevel("Tornado Warning", "Unknown")).toBe("critical");
  });

  it("raises life-threatening events to at least high", () => {
    expect(alertLevel("Flash Flood Warning", "Moderate")).toBe("high");
    expect(alertLevel("Tornado Watch", "Moderate")).toBe("high");
    expect(alertLevel("Severe Thunderstorm Warning", "Minor")).toBe("high");
  });

  it("never lowers what NWS reported", () => {
    expect(alertLevel("Flash Flood Warning", "Extreme")).toBe("critical");
    expect(alertLevel("Frost Advisory", "Minor")).toBe("low");
    expect(alertLevel("Flood Warning", "Severe")).toBe("high");
  });

  it("orders levels consistently", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(maxSeverity("low", "moderate")).toBe("moderate");
    expect(highestSeverity(["low", "critical", "moderate"])).toBe("critical");
    expect(highestSeverity([])).toBeNull();
  });
});

describe("active alert filtering", () => {
  const properties = (overrides: Parameters<typeof alertFeature>[0]) => alertFeature(overrides).properties;

  it("accepts a current, actual alert", () => {
    expect(isAlertActive(properties({}), NOW)).toBe(true);
  });

  it("rejects cancellations and all-clear messages that linger in the feed", () => {
    expect(isAlertActive(properties({ messageType: "Cancel" }), NOW)).toBe(false);
    expect(isAlertActive(properties({ response: "AllClear" }), NOW)).toBe(false);
  });

  it("rejects tests and exercises", () => {
    expect(isAlertActive(properties({ status: "Test" }), NOW)).toBe(false);
  });

  it("rejects alerts whose end time has passed", () => {
    expect(isAlertActive(properties({ ends: "2026-10-06T19:00:00Z" }), NOW)).toBe(false);
    expect(isAlertActive(properties({ ends: null, expires: "2026-10-06T19:59:00Z" }), NOW)).toBe(false);
  });

  it("uses the event end time over the message expiry when both exist", () => {
    // The message expires soon but the event itself runs for hours.
    expect(isAlertActive(properties({ expires: "2026-10-06T19:00:00Z", ends: "2026-10-07T02:00:00Z" }), NOW)).toBe(true);
  });
});

describe("alert normalization", () => {
  it("maps real NWS fields and tolerates missing optional ones", () => {
    const normalized = normalizeAlertProperties(
      alertFeature({
        event: "Tornado Warning",
        severity: "Extreme",
        instruction: null,
        description: "  ",
        references: [{ identifier: "urn:oid:previous" }, { "@id": "https://api.weather.gov/alerts/urn:oid:older" }],
      }),
    );
    expect(normalized).toMatchObject({
      source: "NWS",
      category: "official-alert",
      event: "Tornado Warning",
      rawEvent: "Tornado Warning",
      riskType: "tornado",
      level: "critical",
      severity: "Extreme",
      areaDescription: "Ulster, NY",
      references: ["urn:oid:previous", "https://api.weather.gov/alerts/urn:oid:older"],
    });
    expect(normalized.instruction).toBeUndefined();
    expect(normalized.description).toBeUndefined();
  });

  it("falls back to the event name when there is no headline", () => {
    expect(normalizeAlertProperties(alertFeature({ headline: null })).headline).toBe("Flood Warning");
  });
});
