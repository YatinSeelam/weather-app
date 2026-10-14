import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { singleton } from "./concurrency";
import { monitorApiSecret } from "./config";
import { MONITOR_AUTH_FAILURE_LIMIT } from "./constants";
import { WeatherError } from "./errors";
import { clientKey, createRateLimiter } from "./rate-limit";

/**
 * Access control for the saved-monitor API. Saved monitors hold recipient email addresses and
 * creating one sends email, so every monitor route requires the shared MONITOR_API_SECRET:
 *
 * - Scripts send `Authorization: Bearer $MONITOR_API_SECRET`.
 * - The browser trades the secret once for an HttpOnly, SameSite=Strict session cookie. The cookie
 *   holds an expiry signed with the secret, never the secret itself, and page JavaScript cannot
 *   read it. Rotating the secret signs everyone out.
 *
 * Without a configured secret the monitor API refuses everything (fail closed).
 */

export const SESSION_COOKIE = "weather_monitor_session";
/** Sent only to the API, never to page requests. */
const SESSION_COOKIE_PATH = "/api/weather";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const failures = () => singleton("monitor-auth-failures", () => createRateLimiter(MONITOR_AUTH_FAILURE_LIMIT));

/** Constant-time comparison. Hashing first means the expected value's length does not leak either. */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

const sign = (secret: string, expiresAt: number) =>
  createHmac("sha256", secret).update(`weather-monitor-session:${expiresAt}`).digest("base64url");

export function createSessionToken(secret: string, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  return `${expiresAt}.${sign(secret, expiresAt)}`;
}

export function verifySessionToken(token: string, secret: string, now = Date.now()): "valid" | "expired" | "invalid" {
  const [expires, signature, ...rest] = token.split(".");
  const expiresAt = Number(expires);
  if (rest.length > 0 || !signature || !Number.isInteger(expiresAt)) return "invalid";
  if (!safeEqual(signature, sign(secret, expiresAt))) return "invalid";
  return expiresAt * 1000 > now ? "valid" : "expired";
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/**
 * Browsers mark every request with where it came from. Anything not from this origin must not
 * ride on the session cookie (SameSite=Strict already blocks it; this is the second lock).
 */
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

type Verdict = "ok" | "missing" | "wrong" | "expired" | "cross-site";

function evaluate(request: Request, secret: string): Verdict {
  const header = request.headers.get("authorization");
  if (header !== null) return safeEqual(header, `Bearer ${secret}`) ? "ok" : "wrong";

  const token = readCookie(request, SESSION_COOKIE);
  if (token === null) return "missing";
  const session = verifySessionToken(token, secret);
  if (session !== "valid") return session === "expired" ? "expired" : "wrong";
  if (!SAFE_METHODS.has(request.method) && isCrossSite(request)) return "cross-site";
  return "ok";
}

const UNAUTHORIZED_MESSAGES: Record<Exclude<Verdict, "ok">, string> = {
  missing: "Saved monitors are locked. Unlock them with the access key.",
  wrong: "That access key is not valid.",
  expired: "Your access to saved monitors expired. Unlock them again.",
  "cross-site": "Saved monitors can only be changed from this app.",
};

/** Turns away clients that have guessed wrong too often, before looking at what they sent. */
export function assertNotLockedOut(request: Request): void {
  const decision = failures().peek(clientKey(request));
  if (!decision.allowed) {
    throw new WeatherError("RATE_LIMITED", "Too many attempts with a wrong access key. Try again later.", {
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }
}

/** Counts a wrong access key against the client. */
export function recordFailedAttempt(request: Request): void {
  failures().check(clientKey(request));
}

/** Throws 401 unless the request carries the monitor access key or a valid session. */
export function authorizeMonitorRequest(request: Request): void {
  const secret = monitorApiSecret();
  if (!secret) {
    throw new WeatherError("UNAUTHORIZED", "Saved monitors are turned off: MONITOR_API_SECRET is not set on the server.");
  }
  assertNotLockedOut(request);
  const verdict = evaluate(request, secret);
  if (verdict === "ok") return;
  // Only a wrong credential is a guess. Missing or merely expired ones are not counted, so an
  // open tab whose session lapsed cannot lock its owner out.
  if (verdict === "wrong") recordFailedAttempt(request);
  throw new WeatherError("UNAUTHORIZED", UNAUTHORIZED_MESSAGES[verdict]);
}

/**
 * Whether this browser holds a valid session. Looks only at the cookie: this endpoint is
 * unthrottled, so it must never check a bearer token (that would be a free guessing oracle).
 */
export function sessionStatus(request: Request): { configured: boolean; unlocked: boolean } {
  const secret = monitorApiSecret();
  if (!secret) return { configured: false, unlocked: false };
  const token = readCookie(request, SESSION_COOKIE);
  return { configured: true, unlocked: token !== null && verifySessionToken(token, secret) === "valid" };
}

/** Whether `candidate` is the access key. Constant time. */
export function isMonitorSecret(candidate: string): boolean {
  const secret = monitorApiSecret();
  return secret !== null && safeEqual(candidate, secret);
}

function isHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded ? forwarded === "https" : new URL(request.url).protocol === "https:";
}

export function sessionCookie(request: Request, token: string): string {
  const secure = isHttps(request) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=${SESSION_COOKIE_PATH}; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Strict${secure}`;
}

export function clearedSessionCookie(request: Request): string {
  const secure = isHttps(request) ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=${SESSION_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure}`;
}
