import { beforeEach, describe, expect, it, vi } from "vitest";
import { WeatherError } from "../errors";
import { createRateLimiter } from "../rate-limit";
import { checkRequestSchema, createMonitorSchema, updateMonitorSchema } from "../schemas";
import type { WeatherCheckResult } from "../types";

const checkWeather = vi.hoisted(() => vi.fn());
vi.mock("../weather-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../weather-service")>()),
  checkWeather,
}));

const { POST } = await import("@/app/api/weather/check/route");

const RESULT = {
  center: { zipCode: "12477", city: "Saugerties", state: "NY", latitude: 42.0738, longitude: -73.9797 },
  radiusMiles: 100,
  officialAlerts: [],
  detectedRisks: [],
} as unknown as WeatherCheckResult;

const post = (body: unknown, ip = "203.0.113.1") =>
  POST(
    new Request("http://localhost/api/weather/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("request validation", () => {
  it("accepts a valid check request and removes duplicate risks", () => {
    const parsed = checkRequestSchema.parse({ zipCode: " 12477 ", radiusMiles: 100, risks: ["flood", "flood", "wind"] });
    expect(parsed).toEqual({ zipCode: "12477", radiusMiles: 100, risks: ["flood", "wind"] });
  });

  it("defaults to every risk when none are specified", () => {
    expect(checkRequestSchema.parse({ zipCode: "12477", radiusMiles: 25 }).risks).toHaveLength(8);
  });

  it.each(["1247", "124777", "abcde", "12477-1234", ""])("rejects ZIP code %j", (zipCode) => {
    const parsed = checkRequestSchema.safeParse({ zipCode, radiusMiles: 100 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe("Enter a 5-digit U.S. ZIP code.");
  });

  it("rejects a numeric ZIP code, which would lose leading zeros", () => {
    expect(checkRequestSchema.safeParse({ zipCode: 12477, radiusMiles: 100 }).success).toBe(false);
  });

  it.each([
    [5, true],
    [25, true],
    [200, true],
    [4.9, false],
    [0, false],
    [-10, false],
    [201, false],
    [Number.NaN, false],
    ["100", false],
  ])("radius %j is valid: %j", (radiusMiles, valid) => {
    expect(checkRequestSchema.safeParse({ zipCode: "12477", radiusMiles }).success).toBe(valid);
  });

  it("rejects unknown risks and an empty list", () => {
    expect(checkRequestSchema.safeParse({ zipCode: "12477", radiusMiles: 100, risks: ["meteor"] }).success).toBe(false);
    expect(checkRequestSchema.safeParse({ zipCode: "12477", radiusMiles: 100, risks: [] }).success).toBe(false);
  });

  it("only allows the three supported check frequencies", () => {
    const base = { zipCode: "12477", radiusMiles: 100 };
    for (const intervalMinutes of [15, 60, 180]) {
      expect(createMonitorSchema.safeParse({ ...base, intervalMinutes }).success).toBe(true);
    }
    for (const intervalMinutes of [5, 30, 0, "60", undefined]) {
      expect(createMonitorSchema.safeParse({ ...base, intervalMinutes }).success).toBe(false);
    }
  });

  it("accepts, trims and de-duplicates monitor emails and defaults to emailing every check", () => {
    const created = createMonitorSchema.parse({
      zipCode: "12477",
      radiusMiles: 100,
      intervalMinutes: 15,
      emails: [" Ops@Example.com ", "ops@example.com", "second@example.org"],
    });
    expect(created.emails).toEqual(["ops@example.com", "second@example.org"]);
    expect(created.emailMode).toBe("every-check");

    const bare = createMonitorSchema.parse({ zipCode: "12477", radiusMiles: 100, intervalMinutes: 60 });
    expect(bare.emails).toEqual([]);

    expect(createMonitorSchema.safeParse({ zipCode: "12477", radiusMiles: 100, intervalMinutes: 60, emails: ["nope"] }).success).toBe(false);
    expect(updateMonitorSchema.safeParse({ emailMode: "sometimes" }).success).toBe(false);
    expect(updateMonitorSchema.parse({ emails: [], emailMode: "changes-only" })).toEqual({ emails: [], emailMode: "changes-only" });
  });

  it("requires a monitor update to change something valid", () => {
    expect(updateMonitorSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(updateMonitorSchema.safeParse({ intervalMinutes: 15, radiusMiles: 50 }).success).toBe(true);
    expect(updateMonitorSchema.safeParse({}).success).toBe(false);
    expect(updateMonitorSchema.safeParse({ intervalMinutes: 45 }).success).toBe(false);
  });
});

describe("POST /api/weather/check", () => {
  beforeEach(() => {
    checkWeather.mockReset();
    (globalThis as { __weatherSingletons?: Map<string, unknown> }).__weatherSingletons?.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns the check result for a valid request", async () => {
    checkWeather.mockResolvedValue(RESULT);
    const response = await post({ zipCode: "12477", radiusMiles: 100, risks: ["tornado", "flood"] });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ center: { zipCode: "12477", city: "Saugerties" }, radiusMiles: 100 });
    expect(checkWeather).toHaveBeenCalledWith({ zipCode: "12477", radiusMiles: 100, risks: ["tornado", "flood"] });
  });

  it("responds 400 with field details for an invalid ZIP code", async () => {
    const response = await post({ zipCode: "1247", radiusMiles: 100 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "Enter a 5-digit U.S. ZIP code.",
        fields: [{ field: "zipCode", message: "Enter a 5-digit U.S. ZIP code." }],
      },
    });
    expect(checkWeather).not.toHaveBeenCalled();
  });

  it("responds 400 for an out-of-range radius and for a body that is not JSON", async () => {
    const tooBig = await post({ zipCode: "12477", radiusMiles: 5000 });
    expect(tooBig.status).toBe(400);
    expect((await tooBig.json()).error.fields[0].field).toBe("radiusMiles");

    const notJson = await post("{not json");
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error.code).toBe("INVALID_INPUT");
  });

  it("maps domain errors to their HTTP status", async () => {
    checkWeather.mockRejectedValueOnce(new WeatherError("ZIP_NOT_FOUND", "No U.S. location found for ZIP code 00000."));
    const notFound = await post({ zipCode: "00000", radiusMiles: 100 });
    expect(notFound.status).toBe(404);
    expect((await notFound.json()).error).toEqual({
      code: "ZIP_NOT_FOUND",
      message: "No U.S. location found for ZIP code 00000.",
    });

    checkWeather.mockRejectedValueOnce(new WeatherError("NWS_UNAVAILABLE", "The National Weather Service returned 503."));
    expect((await post({ zipCode: "12477", radiusMiles: 100 })).status).toBe(502);

    checkWeather.mockRejectedValueOnce(new WeatherError("TIMEOUT", "The weather check ran out of time."));
    expect((await post({ zipCode: "12477", radiusMiles: 100 })).status).toBe(504);
  });

  it("says which live source failed so the UI never shows an outage as clear weather", async () => {
    checkWeather.mockRejectedValueOnce(
      new WeatherError("NWS_UNAVAILABLE", "Unable to retrieve live NWS alerts. The National Weather Service returned 503.", {
        source: "alerts",
      }),
    );
    const response = await post({ zipCode: "12477", radiusMiles: 100 });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "NWS_UNAVAILABLE",
        message: "Unable to retrieve live NWS alerts. The National Weather Service returned 503.",
        source: "alerts",
      },
    });
  });

  it("hides the details of unexpected errors", async () => {
    checkWeather.mockRejectedValueOnce(new Error("ECONNRESET at internal-host:5432"));
    const response = await post({ zipCode: "12477", radiusMiles: 100 });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("internal-host");
  });

  it("rate limits a client that checks too often", async () => {
    checkWeather.mockResolvedValue(RESULT);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 22; attempt++) {
      statuses.push((await post({ zipCode: "12477", radiusMiles: 100 }, "198.51.100.7")).status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);

    const limited = await post({ zipCode: "12477", radiusMiles: 100 }, "198.51.100.7");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Other clients are unaffected.
    expect((await post({ zipCode: "12477", radiusMiles: 100 }, "198.51.100.8")).status).toBe(200);
  });
});

describe("rate limiter", () => {
  it("allows requests again once the window has passed", () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", 100).allowed).toBe(true);
    expect(limiter.check("a", 200)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.check("a", 1001).allowed).toBe(true);
  });
});
