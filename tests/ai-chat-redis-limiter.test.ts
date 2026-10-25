import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChatRouter, createRedisRateLimiter, redisLimiterFromEnv } from "../src/lib/ai-brain/chat";
import { resolveChatRouter } from "../src/lib/chat-model";

const TOKEN = "tok_" + "x".repeat(24);
const KEY = "sk-ant-" + "y".repeat(24);

/** In-memory stand-in for a Redis REST /pipeline endpoint: INCR and EXPIRE NX only. Shared between limiter instances = one store. */
function fakeStore(opts: { status?: number; body?: unknown; throwNetwork?: boolean } = {}) {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  const calls: { url: string; auth: string | null; cmds: (string | number)[][] }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const cmds = JSON.parse(String(init?.body)) as (string | number)[][];
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), cmds });
    if (opts.throwNetwork) throw new Error(`connect ECONNREFUSED with ${TOKEN}`);
    if (opts.body !== undefined || opts.status) return new Response(JSON.stringify(opts.body ?? []), { status: opts.status ?? 200 });
    const out = cmds.map(([op, key, sec]) => {
      const k = String(key);
      if (op === "INCR") { counts.set(k, (counts.get(k) ?? 0) + 1); return { result: counts.get(k) }; }
      if (op === "EXPIRE") { if (!ttls.has(k)) ttls.set(k, Number(sec)); return { result: 1 }; }
      return { error: "unsupported" };
    });
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, counts, ttls, calls };
}

const make = (store: ReturnType<typeof fakeStore>, extra = {}) =>
  createRedisRateLimiter({ url: "https://store.example.test/", token: TOKEN, fetchImpl: store.fetchImpl, now: () => 1_700_000_000_000, ...extra });

describe("redis rate limiter: ceilings", () => {
  it("is marked durable and allows calls up to the per-user ceiling, then refuses", async () => {
    const lim = make(fakeStore(), { perUser: { max: 3, windowSec: 600 } });
    assert.equal(lim.durable, true);
    const r = [await lim.take("a"), await lim.take("a"), await lim.take("a"), await lim.take("a")];
    assert.deepEqual(r, [true, true, true, false]);
  });

  it("budgets are per user: one user over budget does not block another", async () => {
    const lim = make(fakeStore(), { perUser: { max: 1, windowSec: 600 } });
    assert.equal(await lim.take("a"), true);
    assert.equal(await lim.take("a"), false);
    assert.equal(await lim.take("b"), true);
  });

  it("the global ceiling caps total model calls across all users", async () => {
    const lim = make(fakeStore(), { perUser: { max: 10, windowSec: 600 }, global: { max: 2, windowSec: 86_400 } });
    assert.deepEqual([await lim.take("a"), await lim.take("b"), await lim.take("c"), await lim.take("a")], [true, true, false, false]);
  });

  it("a user already over their own budget never consumes global budget", async () => {
    const store = fakeStore();
    const lim = make(store, { perUser: { max: 1, windowSec: 600 }, global: { max: 100, windowSec: 86_400 } });
    await lim.take("a");
    for (let i = 0; i < 5; i++) await lim.take("a");
    const globalKey = [...store.counts.keys()].find((k) => k.includes(":g:"))!;
    assert.equal(store.counts.get(globalKey), 1);
  });

  it("two limiter instances over one store share the same counters (what makes it durable across serverless instances)", async () => {
    const store = fakeStore();
    const a = make(store, { perUser: { max: 2, windowSec: 600 } });
    const b = make(store, { perUser: { max: 2, windowSec: 600 } });
    assert.deepEqual([await a.take("u"), await b.take("u"), await a.take("u"), await b.take("u")], [true, true, false, false]);
  });

  it("sets an expiry on every counter so budgets reset", async () => {
    const store = fakeStore();
    await make(store, { perUser: { max: 5, windowSec: 600 }, global: { max: 5, windowSec: 86_400 } }).take("u");
    assert.deepEqual([...store.ttls.values()].sort((x, y) => x - y), [600, 86_400]);
  });

  it("sends the token only as a bearer header, to the pipeline endpoint of the configured https store", async () => {
    const store = fakeStore();
    await make(store).take("u");
    assert.equal(store.calls[0].url, "https://store.example.test/pipeline");
    assert.equal(store.calls[0].auth, `Bearer ${TOKEN}`);
    assert.doesNotMatch(JSON.stringify(store.calls[0].cmds), new RegExp(TOKEN));
  });
});

describe("redis rate limiter: fails closed", () => {
  const cases: [string, ReturnType<typeof fakeStore>][] = [
    ["network error", fakeStore({ throwNetwork: true })],
    ["HTTP 500", fakeStore({ status: 500, body: [] })],
    ["HTTP 401", fakeStore({ status: 401, body: { error: "bad token" } })],
    ["a malformed reply", fakeStore({ body: { nope: true } })],
    ["a store-reported error", fakeStore({ body: [{ error: "ERR" }, { result: 1 }] })],
    ["a non-numeric count", fakeStore({ body: [{ result: "many" }, { result: 1 }] })],
  ];
  for (const [name, store] of cases) {
    it(`throws on ${name}, and never leaks the token in the error`, async () => {
      await assert.rejects(make(store).take("u"), (e: Error) => !e.message.includes(TOKEN) && !e.message.includes(KEY));
    });
  }

  it("the chat router treats a failing store as 'no budget': no model request is made", async () => {
    let modelCalls = 0;
    const router = createChatRouter({ transport: async () => { modelCalls++; return '{"route":"unsupported"}'; }, limiter: make(fakeStore({ status: 503, body: [] })) });
    assert.equal(await router.route("u", "Am I falling behind on anything?"), null);
    assert.equal(modelCalls, 0);
  });

  it("the chat router makes no model request once the global ceiling is hit", async () => {
    let modelCalls = 0;
    const limiter = make(fakeStore(), { global: { max: 1, windowSec: 86_400 } });
    const router = createChatRouter({ transport: async () => { modelCalls++; return '{"route":"data","parts":["overdue"]}'; }, limiter, cooldownMs: 0 });
    await router.route("a", "Am I falling behind on anything?");
    assert.equal(await router.route("b", "Am I falling behind on anything?"), null);
    assert.equal(modelCalls, 1);
  });
});

describe("redisLimiterFromEnv and production enablement", () => {
  const STORE = { UPSTASH_REDIS_REST_URL: "https://store.example.test", UPSTASH_REDIS_REST_TOKEN: TOKEN };

  it("is null without a store, with a missing token, or with a non-https url", () => {
    assert.equal(redisLimiterFromEnv({} as unknown as NodeJS.ProcessEnv), null);
    assert.equal(redisLimiterFromEnv({ UPSTASH_REDIS_REST_URL: "https://s.test" } as unknown as NodeJS.ProcessEnv), null);
    assert.equal(redisLimiterFromEnv({ ...STORE, UPSTASH_REDIS_REST_URL: "http://s.test" } as unknown as NodeJS.ProcessEnv), null);
  });

  it("accepts the Vercel Marketplace KV_REST_API_* names too", () => {
    const l = redisLimiterFromEnv({ KV_REST_API_URL: "https://s.test", KV_REST_API_TOKEN: TOKEN } as unknown as NodeJS.ProcessEnv);
    assert.equal(l?.durable, true);
  });

  it("production with the key and flag but NO store stays fail-closed", () => {
    const env = { BROKO_AI_CHAT: "llm", ANTHROPIC_API_KEY: KEY, NODE_ENV: "production" } as NodeJS.ProcessEnv;
    assert.deepEqual(resolveChatRouter(env, redisLimiterFromEnv(env) ?? undefined).status, { enabled: false, reason: "production_needs_durable_limiter" });
  });

  it("production with the key, flag and a configured store enables the model with the durable limiter", () => {
    const env = { BROKO_AI_CHAT: "llm", ANTHROPIC_API_KEY: KEY, NODE_ENV: "production", ...STORE } as NodeJS.ProcessEnv;
    const r = resolveChatRouter(env, redisLimiterFromEnv(env) ?? undefined);
    assert.deepEqual(r.status, { enabled: true, limiter: "durable" });
    assert.ok(r.router);
  });

  it("a configured store without the flag or key still leaves the model off", () => {
    const base = { NODE_ENV: "production", ...STORE } as NodeJS.ProcessEnv;
    assert.equal(resolveChatRouter(base, redisLimiterFromEnv(base) ?? undefined).router, null);
    const noKey = { ...base, BROKO_AI_CHAT: "llm" } as NodeJS.ProcessEnv;
    assert.deepEqual(resolveChatRouter(noKey, redisLimiterFromEnv(noKey) ?? undefined).status, { enabled: false, reason: "no_key" });
  });
});
