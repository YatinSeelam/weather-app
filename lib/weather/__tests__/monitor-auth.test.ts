import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS, verifySessionToken } from "../monitor-auth";

// Route handlers call connection(), which needs a live Next request scope.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));
vi.mock("../geocoder", () => ({
  getCoordinatesForZip: vi.fn(async (zip: string) => ({
    zip,
    city: "Saugerties",
    state: "NY",
    latitude: 42.0738,
    longitude: -73.9797,
  })),
}));
// The first run of a new monitor would hit NWS and Resend; here it only has to be called.
const runMonitor = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../monitor-runner", () => ({ runMonitor }));

const monitorsRoute = await import("@/app/api/weather/monitors/route");
const monitorRoute = await import("@/app/api/weather/monitors/[id]/route");
const sessionRoute = await import("@/app/api/weather/session/route");

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const EMAIL = "private.recipient@example.com";
const BODY = { zipCode: "12477", radiusMiles: 50, risks: ["flood"], intervalMinutes: 60, emails: [EMAIL] };

let ipCounter = 0;
let ip = "";
let dataDir = "";

type Init = { method?: string; body?: unknown; headers?: Record<string, string> };

function request(url: string, { method = "GET", body, headers = {} }: Init = {}) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "x-forwarded-for": ip, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const bearer = (secret = SECRET) => ({ authorization: `Bearer ${secret}` });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const list = (headers?: Record<string, string>) => monitorsRoute.GET(request("/api/weather/monitors", { headers }));
const create = (headers?: Record<string, string>, body: unknown = BODY) =>
  monitorsRoute.POST(request("/api/weather/monitors", { method: "POST", body, headers }));
const patch = (id: string, body: unknown, headers?: Record<string, string>) =>
  monitorRoute.PATCH(request(`/api/weather/monitors/${id}`, { method: "PATCH", body, headers }), params(id));
const remove = (id: string, headers?: Record<string, string>) =>
  monitorRoute.DELETE(request(`/api/weather/monitors/${id}`, { method: "DELETE", headers }), params(id));
const unlock = (secret: string, headers?: Record<string, string>) =>
  sessionRoute.POST(request("/api/weather/session", { method: "POST", body: { secret }, headers }));

async function createdId(headers = bearer()): Promise<string> {
  const response = await create(headers);
  expect(response.status).toBe(201);
  return ((await response.json()) as { monitor: { id: string } }).monitor.id;
}

beforeEach(async () => {
  // Fresh rate limiters, store and data directory per test; a new client address per test too.
  delete (globalThis as { __weatherSingletons?: unknown }).__weatherSingletons;
  dataDir = await mkdtemp(path.join(tmpdir(), "monitor-auth-"));
  vi.stubEnv("WEATHER_DATA_DIR", dataDir);
  vi.stubEnv("MONITOR_API_SECRET", SECRET);
  vi.stubEnv("MAX_ACTIVE_MONITORS", "100");
  ipCounter += 1;
  ip = `198.51.100.${ipCounter}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

describe("monitor API without credentials", () => {
  it("answers 401 to every method and never reveals saved monitors", async () => {
    const id = await createdId();

    const responses = [await list(), await create(), await patch(id, { enabled: false }), await remove(id)];
    for (const response of responses) {
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).not.toContain(EMAIL);
      expect(JSON.parse(text).error.code).toBe("UNAUTHORIZED");
    }

    // Nothing changed: still one monitor, still enabled.
    const body = await (await list(bearer())).json();
    expect(body.monitors).toHaveLength(1);
    expect(body.monitors[0].enabled).toBe(true);
  });

  it("rejects a wrong bearer token", async () => {
    expect((await list(bearer("not-the-secret"))).status).toBe(401);
    expect((await create(bearer(`${SECRET}x`))).status).toBe(401);
    expect((await list({ authorization: SECRET })).status).toBe(401);
  });

  it("fails closed when MONITOR_API_SECRET is not set", async () => {
    vi.stubEnv("MONITOR_API_SECRET", "");
    for (const response of [await list(bearer("")), await create(bearer()), await remove("x", bearer())]) {
      expect(response.status).toBe(401);
    }
    expect((await unlock(SECRET)).status).toBe(401);
    expect(runMonitor).not.toHaveBeenCalled();
    expect(await readdir(dataDir)).toEqual([]);
    expect(await (await sessionRoute.GET(request("/api/weather/session"))).json()).toEqual({
      configured: false,
      unlocked: false,
    });
  });
});

describe("monitor API with the bearer token", () => {
  it("lists, creates, updates and deletes", async () => {
    const id = await createdId();
    expect(runMonitor).toHaveBeenCalledTimes(1);

    const listed = await (await list(bearer())).json();
    expect(listed.monitors[0].emails).toEqual([EMAIL]);

    expect((await patch(id, { enabled: false }, bearer())).status).toBe(200);
    expect((await remove(id, bearer())).status).toBe(204);
    expect((await (await list(bearer())).json()).monitors).toEqual([]);
  });
});

describe("browser session", () => {
  it("trades the key for an HttpOnly cookie that never contains the key", async () => {
    const wrong = await unlock("guess");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const response = await unlock(SECRET, { "sec-fetch-site": "same-origin" });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/weather");
    expect(cookie).not.toContain(SECRET);

    const session = { cookie: cookie.split(";")[0] };
    expect((await list(session)).status).toBe(200);
    expect(await (await sessionRoute.GET(request("/api/weather/session", { headers: session }))).json()).toEqual({
      configured: true,
      unlocked: true,
    });
  });

  it("marks the cookie Secure over https", async () => {
    const response = await unlock(SECRET, { "x-forwarded-proto": "https" });
    expect(response.headers.get("set-cookie")).toContain("; Secure");
  });

  it("refuses cookie-authenticated changes coming from another site", async () => {
    const id = await createdId();
    const cookie = `${SESSION_COOKIE}=${createSessionToken(SECRET)}`;

    expect((await remove(id, { cookie, "sec-fetch-site": "cross-site" })).status).toBe(401);
    expect((await remove(id, { cookie, "sec-fetch-site": "same-site" })).status).toBe(401);
    expect((await unlock(SECRET, { "sec-fetch-site": "cross-site" })).status).toBe(401);
    expect((await remove(id, { cookie, "sec-fetch-site": "same-origin" })).status).toBe(204);
  });

  it("rejects forged, tampered and expired cookies", async () => {
    const valid = createSessionToken(SECRET);
    const [expires, signature] = valid.split(".");
    const expired = createSessionToken(SECRET, Date.now() - (SESSION_TTL_SECONDS + 60) * 1000);

    for (const token of [
      createSessionToken("some-other-secret"),
      `${Number(expires) + 3600}.${signature}`,
      `${expires}.${signature}x`,
      "garbage",
      expired,
    ]) {
      expect((await list({ cookie: `${SESSION_COOKIE}=${token}` })).status).toBe(401);
    }
    expect(verifySessionToken(expired, SECRET)).toBe("expired");
    expect(verifySessionToken(valid, SECRET)).toBe("valid");
  });

  it("signs everyone out when the secret is rotated", async () => {
    const cookie = `${SESSION_COOKIE}=${createSessionToken(SECRET)}`;
    vi.stubEnv("MONITOR_API_SECRET", "rotated-secret-0123456789abcdef");
    expect((await list({ cookie })).status).toBe(401);
  });

  it("clears the cookie on lock", async () => {
    const response = await sessionRoute.DELETE(request("/api/weather/session", { method: "DELETE" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`));
  });
});

describe("brute-force protection", () => {
  it("locks a client out after 10 wrong keys, even if the 11th is right", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await list(bearer(`wrong-${attempt}`))).status).toBe(401);
    }
    const locked = await list(bearer());
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await unlock(SECRET)).status).toBe(429);

    // Another client is unaffected.
    ip = "192.0.2.200";
    expect((await list(bearer())).status).toBe(200);
  });

  it("does not count missing or expired credentials as guesses", async () => {
    const expired = `${SESSION_COOKIE}=${createSessionToken(SECRET, Date.now() - (SESSION_TTL_SECONDS + 60) * 1000)}`;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      expect((await list()).status).toBe(401);
      expect((await list({ cookie: expired })).status).toBe(401);
    }
    expect((await list(bearer())).status).toBe(200);
  });
});

describe("abuse limits on monitor creation", () => {
  it("rate limits POST per client", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) await createdId();
    const limited = await create(bearer());
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(runMonitor).toHaveBeenCalledTimes(10);

    ip = "192.0.2.201";
    expect((await create(bearer())).status).toBe(201);
  });

  it("caps active monitors, including when re-enabling one", async () => {
    vi.stubEnv("MAX_ACTIVE_MONITORS", "2");
    const first = await createdId();
    await createdId();

    const full = await create(bearer());
    expect(full.status).toBe(409);
    expect((await full.json()).error.code).toBe("MONITOR_LIMIT");
    expect(runMonitor).toHaveBeenCalledTimes(2);

    // Pausing one frees a slot...
    expect((await patch(first, { enabled: false }, bearer())).status).toBe(200);
    await createdId();
    // ...and turning it back on now would exceed the cap.
    const reenable = await patch(first, { enabled: true }, bearer());
    expect(reenable.status).toBe(409);
    expect((await (await list(bearer())).json()).monitors.filter((m: { enabled: boolean }) => m.enabled)).toHaveLength(
      2,
    );
  });

  it("does not let concurrent requests squeeze past the cap", async () => {
    vi.stubEnv("MAX_ACTIVE_MONITORS", "3");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => {
        ip = `192.0.2.${10 + index}`;
        return create(bearer());
      }),
    );
    expect(results.filter((response) => response.status === 201)).toHaveLength(3);
    expect(results.filter((response) => response.status === 409)).toHaveLength(5);
  });
});
