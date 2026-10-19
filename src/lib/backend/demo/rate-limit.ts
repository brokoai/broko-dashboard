interface Entry { count: number; resetAt: number }

/**
 * Best-effort in-memory limiter for failed attempts. On serverless hosting each instance
 * keeps its own counters, so this slows guessing but is not a hard global guarantee.
 */
export function createRateLimiter({ max, windowMs, maxKeys = 2000 }: { max: number; windowMs: number; maxKeys?: number }) {
  const entries = new Map<string, Entry>();

  const purge = (now: number) => {
    for (const [k, e] of entries) if (e.resetAt <= now) entries.delete(k);
    while (entries.size > maxKeys) entries.delete(entries.keys().next().value as string);
  };

  return {
    /** Is this key currently blocked? */
    check(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
      const e = entries.get(key);
      if (!e || e.resetAt <= now || e.count < max) return { allowed: true, retryAfterSec: 0 };
      return { allowed: false, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) };
    },
    /** Record a failed attempt. */
    fail(key: string, now = Date.now()): void {
      const e = entries.get(key);
      if (!e || e.resetAt <= now) entries.set(key, { count: 1, resetAt: now + windowMs });
      else e.count += 1;
      if (entries.size > maxKeys) purge(now);
    },
    clear(key: string): void {
      entries.delete(key);
    },
  };
}
