import type { ModelRateLimiter } from "./model-router";

/**
 * Durable, shared model-call budget on a Redis-compatible REST endpoint (Upstash, Vercel Marketplace Redis).
 * Counters live in the store, so every serverless instance and every restart sees the same numbers.
 *
 * Two independent ceilings, both enforced BEFORE any model request:
 *  - per user:  `perUser.max` calls per `perUser.windowSec`
 *  - global:    `global.max` calls per `global.windowSec` (the spending guard: worst case = global.max x one small call)
 *
 * FAIL CLOSED: a network error, a non-2xx reply, a malformed reply or a timeout makes `take` THROW; the chat router treats a
 * throwing limiter as "no budget", so the model is skipped and chat stays deterministic. The store is never bypassed.
 */

export interface Ceiling { max: number; windowSec: number }

export interface RedisLimiterOptions {
  url: string;
  token: string;
  perUser?: Ceiling;
  global?: Ceiling;
  /** Namespaces keys so previews and production never share counters. */
  prefix?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const DEFAULT_PER_USER: Ceiling = { max: 20, windowSec: 600 };
export const DEFAULT_GLOBAL: Ceiling = { max: 200, windowSec: 86_400 };

type Cmd = (string | number)[];

export function createRedisRateLimiter(opts: RedisLimiterOptions): ModelRateLimiter {
  const perUser = opts.perUser ?? DEFAULT_PER_USER;
  const global = opts.global ?? DEFAULT_GLOBAL;
  const prefix = opts.prefix ?? "broko:chat";
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const base = opts.url.replace(/\/+$/, "");

  /** One round trip, commands run in order. Returns each command's result. */
  async function pipeline(cmds: Cmd[]): Promise<unknown[]> {
    let res: Response;
    try {
      res = await doFetch(`${base}/pipeline`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        body: JSON.stringify(cmds),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
        cache: "no-store",
      });
    } catch {
      throw new Error("rate limiter store unreachable"); // the underlying error is dropped: it may echo the URL or token
    }
    if (!res.ok) throw new Error(`rate limiter store replied ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body) || body.length !== cmds.length) throw new Error("rate limiter store returned an unexpected reply");
    return body.map((r) => {
      if (typeof r !== "object" || r === null) throw new Error("rate limiter store returned an unexpected reply");
      const { result, error } = r as { result?: unknown; error?: unknown };
      if (error !== undefined) throw new Error("rate limiter store reported an error");
      return result;
    });
  }

  /** Increments a fixed-window counter (window starts at the first call) and returns the new count. */
  async function bump(key: string, c: Ceiling): Promise<number> {
    const [count] = await pipeline([["INCR", key], ["EXPIRE", key, c.windowSec, "NX"]]);
    if (typeof count !== "number" || !Number.isFinite(count)) throw new Error("rate limiter store returned a non-numeric count");
    return count;
  }

  return {
    durable: true,
    async take(userKey) {
      const day = Math.floor(now() / (global.windowSec * 1000));
      // The user counter is checked first so a user who is already over budget never consumes global budget.
      const user = await bump(`${prefix}:u:${userKey}`, perUser);
      if (user > perUser.max) return false;
      const total = await bump(`${prefix}:g:${day}`, global);
      return total <= global.max;
    },
  };
}

/** Builds the limiter from environment variables, or null when no store is configured (the router then stays fail-closed). */
export function redisLimiterFromEnv(env: NodeJS.ProcessEnv): ModelRateLimiter | null {
  const url = env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim();
  if (!url || !token || !/^https:\/\//i.test(url)) return null;
  const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : d);
  return createRedisRateLimiter({
    url,
    token,
    prefix: `broko:chat:${env.VERCEL_ENV ?? env.NODE_ENV ?? "unknown"}`,
    perUser: { max: int(env.BROKO_AI_CHAT_USER_MAX, DEFAULT_PER_USER.max), windowSec: DEFAULT_PER_USER.windowSec },
    global: { max: int(env.BROKO_AI_CHAT_GLOBAL_MAX, DEFAULT_GLOBAL.max), windowSec: DEFAULT_GLOBAL.windowSec },
  });
}
