export type RateLimitDecision = { allowed: boolean; retryAfterSeconds: number };

/** Sliding-window limiter kept in memory. Enough to stop one client hammering the check endpoint. */
export function createRateLimiter(options: { limit: number; windowMs: number }) {
  const hits = new Map<string, number[]>();

  return {
    check(key: string, now = Date.now()): RateLimitDecision {
      const windowStart = now - options.windowMs;
      const recent = (hits.get(key) ?? []).filter((time) => time > windowStart);

      if (recent.length >= options.limit) {
        hits.set(key, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + options.windowMs - now) / 1000)) };
      }

      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000) {
        for (const [otherKey, times] of hits) {
          if (times.every((time) => time <= windowStart)) hits.delete(otherKey);
        }
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },

    /** Same answer as `check`, without counting this call. */
    peek(key: string, now = Date.now()): RateLimitDecision {
      const recent = (hits.get(key) ?? []).filter((time) => time > now - options.windowMs);
      if (recent.length < options.limit) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + options.windowMs - now) / 1000)) };
    },
  };
}

export function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}
