import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createChatRouter, createMemoryRateLimiter, createRedisRateLimiter, redisLimiterFromEnv } from "../src/lib/ai-brain/chat";
import { attemptUnlock, codeConfigured, codeMatches, createUnlockToken, isUnlocked, UNLOCK_TTL_SECONDS, unlockKey, unlockThrottle, type UnlockDeps } from "../src/lib/ai-unlock";
import { createSessionToken, deriveKey } from "../src/lib/backend/demo/crypto";
import { handleChat } from "../src/lib/chat-service";
import { admin, alice, fakeRepo } from "./ai-chat-helpers";

const CODE = "demo-code-" + "k7Q2x9";           // 16 chars, test value only
const SECRET = "s".repeat(10) + "abcdefghijklmnop" + "0123456789"; // >= 32 chars, >= 12 distinct
const KEY = deriveKey({ secret: SECRET, allowDevFallback: false }, "ai-unlock");
const T0 = 1_700_000_000_000;
const REDIS_TOKEN = "tok_" + "z".repeat(24);

const throttle = (max = 5) => createMemoryRateLimiter({ maxCalls: max, windowMs: 900_000, now: () => T0 });
const deps = (over: Partial<UnlockDeps> = {}): UnlockDeps => ({ expected: CODE, key: KEY, throttle: throttle(), clientKey: "ip:1.2.3.4", userId: "u-alice", now: () => T0, ...over });

describe("unlock code check", () => {
  it("accepts the exact code and nothing else", () => {
    assert.equal(codeMatches(CODE, CODE), true);
    for (const bad of ["", " ", CODE + "x", CODE.slice(0, -1), CODE.toUpperCase(), "wrong"]) assert.equal(codeMatches(bad, CODE), false, bad);
  });
  it("an over-long input is rejected without comparison", () => assert.equal(codeMatches(CODE.padEnd(500, "x"), CODE), false));
  it("a missing or short configured code means the gate cannot be opened at all", () => {
    for (const weak of [undefined, "", "short", "12345678901"]) {
      assert.equal(codeConfigured(weak), false);
      assert.equal(codeMatches(weak ?? "", weak ?? ""), false);
    }
    assert.equal(codeConfigured(CODE), true);
  });
});

describe("unlock session token", () => {
  it("a fresh token unlocks its own user", () => assert.equal(isUnlocked(createUnlockToken("u-alice", KEY, T0), KEY, "u-alice", T0 + 1000), true));
  it("is bound to the user: another user's token does not unlock", () => assert.equal(isUnlocked(createUnlockToken("u-alice", KEY, T0), KEY, "u-admin", T0 + 1000), false));
  it("expires after its time limit", () => {
    const t = createUnlockToken("u-alice", KEY, T0);
    assert.equal(isUnlocked(t, KEY, "u-alice", T0 + (UNLOCK_TTL_SECONDS - 5) * 1000), true);
    assert.equal(isUnlocked(t, KEY, "u-alice", T0 + (UNLOCK_TTL_SECONDS + 5) * 1000), false);
  });
  it("rejects missing, garbage, tampered and wrongly-signed tokens", () => {
    const t = createUnlockToken("u-alice", KEY, T0);
    const [body, sig] = t.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ p: "ai-unlock", u: "u-alice", exp: Math.floor(T0 / 1000) + 10 ** 9 })).toString("base64url");
    for (const bad of [undefined, null, "", "x", "a.b.c", `${body}.${"A".repeat(sig.length)}`, `${forgedBody}.${sig}`, t + "0"]) assert.equal(isUnlocked(bad, KEY, "u-alice", T0), false, String(bad));
    assert.equal(isUnlocked(t, deriveKey({ secret: "different-" + SECRET, allowDevFallback: false }, "ai-unlock"), "u-alice", T0), false);
  });
  it("a demo session cookie cannot be replayed as an unlock (separate key purpose)", () => {
    const sessionKey = deriveKey({ secret: SECRET, allowDevFallback: false }, "session");
    assert.equal(isUnlocked(createSessionToken("u-alice", sessionKey, T0), KEY, "u-alice", T0), false);
  });
  it("no signing key means nothing is unlocked", () => assert.equal(isUnlocked(createUnlockToken("u-alice", KEY, T0), null, "u-alice", T0), false));
  it("production without the demo session secret has no key; development has the local fallback", () => {
    assert.equal(unlockKey({ NODE_ENV: "production", VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv), null);
    assert.ok(unlockKey({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv));
  });
});

describe("unlock attempts", () => {
  it("the right code yields a token that unlocks that user", async () => {
    const r = await attemptUnlock(deps(), CODE);
    assert.ok(r.ok);
    if (r.ok) assert.equal(isUnlocked(r.token, KEY, "u-alice", T0 + 1), true);
  });
  it("surrounding whitespace is ignored; a wrong code is refused with a coarse reason", async () => {
    assert.equal((await attemptUnlock(deps(), `  ${CODE}  `)).ok, true);
    assert.deepEqual(await attemptUnlock(deps(), "nope"), { ok: false, reason: "invalid" });
    assert.deepEqual(await attemptUnlock(deps(), 12345), { ok: false, reason: "invalid" });
    assert.deepEqual(await attemptUnlock(deps(), undefined), { ok: false, reason: "invalid" });
  });
  it("is unavailable, and consumes no attempts, when the code, key or throttle is missing", async () => {
    let takes = 0;
    const counting = { durable: false, take: async () => { takes++; return true; } };
    for (const over of [{ expected: undefined }, { expected: "short" }, { key: null }, { throttle: null }] as Partial<UnlockDeps>[]) {
      assert.deepEqual(await attemptUnlock(deps({ throttle: counting, ...over }), CODE), { ok: false, reason: "unavailable" });
    }
    assert.equal(takes, 0);
  });
  it("brute force: after the allowed attempts even the CORRECT code is refused", async () => {
    const d = deps({ throttle: throttle(5) });
    for (let i = 0; i < 5; i++) assert.deepEqual(await attemptUnlock(d, `guess-${i}`), { ok: false, reason: "invalid" });
    assert.deepEqual(await attemptUnlock(d, CODE), { ok: false, reason: "throttled" });
  });
  it("every attempt counts, right or wrong, and the count is taken before the comparison", async () => {
    const order: string[] = [];
    const lim = { durable: false, take: async () => { order.push("take"); return true; } };
    await attemptUnlock(deps({ throttle: lim }), CODE);
    await attemptUnlock(deps({ throttle: lim }), "bad");
    assert.deepEqual(order, ["take", "take"]);
  });
  it("attempts are counted per client: one client being throttled does not lock out another", async () => {
    const t = throttle(1);
    await attemptUnlock(deps({ throttle: t, clientKey: "ip:a" }), "bad");
    assert.deepEqual(await attemptUnlock(deps({ throttle: t, clientKey: "ip:a" }), CODE), { ok: false, reason: "throttled" });
    assert.equal((await attemptUnlock(deps({ throttle: t, clientKey: "ip:b" }), CODE)).ok, true);
  });
  it("a failing throttle refuses the unlock (fail closed), even with the right code", async () => {
    const broken = { durable: true, take: async (): Promise<boolean> => { throw new Error("store down"); } };
    assert.deepEqual(await attemptUnlock(deps({ throttle: broken }), CODE), { ok: false, reason: "unavailable" });
  });
});

describe("unlock throttle store", () => {
  const storeEnv = { UPSTASH_REDIS_REST_URL: "https://store.example.test", UPSTASH_REDIS_REST_TOKEN: REDIS_TOKEN };
  it("production without a store has no throttle, so unlocking is refused", async () => {
    const t = unlockThrottle({ NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv);
    assert.equal(t, null);
    assert.deepEqual(await attemptUnlock(deps({ throttle: t }), CODE), { ok: false, reason: "unavailable" });
  });
  it("development without a store uses a local counter; with a store it uses the shared one", () => {
    assert.equal(unlockThrottle({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv)?.durable, false);
    assert.equal(unlockThrottle({ NODE_ENV: "production", ...storeEnv } as unknown as NodeJS.ProcessEnv)?.durable, true);
  });
  it("a Redis failure (503) refuses the unlock; a Redis outage never grants one", async () => {
    const down = createRedisRateLimiter({ url: "https://store.example.test", token: REDIS_TOKEN, fetchImpl: (async () => new Response("{}", { status: 503 })) as typeof fetch });
    assert.deepEqual(await attemptUnlock(deps({ throttle: down }), CODE), { ok: false, reason: "unavailable" });
  });
  it("the unlock throttle uses its own counters, separate from the model budget", () => {
    const l = redisLimiterFromEnv(storeEnv as unknown as NodeJS.ProcessEnv, { name: "unlock", perUser: { max: 5, windowSec: 900 } });
    assert.equal(l?.durable, true);
  });
});

describe("the gate in front of paid routing", () => {
  const FREE_FORM = "Am I falling behind on anything?";
  const modelSays = (parts: string[]) => {
    const calls: number[] = [];
    const router = createChatRouter({ transport: async () => { calls.push(1); return JSON.stringify({ route: "data", parts }); }, limiter: { durable: false, take: async () => true } });
    return { router, calls };
  };
  const run = (user: typeof admin, router?: ReturnType<typeof modelSays>["router"]) =>
    handleChat({ user, backendKind: "demo", repoFor: async () => fakeRepo().repo, router }, FREE_FORM);

  it("locked (no router handed over): no model request, deterministic answer", async () => {
    const { calls } = modelSays(["overdue"]);
    const r = await run(alice, undefined);
    assert.equal(calls.length, 0);
    assert.ok(r.ok);
  });
  it("unlocked (router handed over): the model is asked once", async () => {
    const { router, calls } = modelSays(["overdue"]);
    const r = await run(alice, router);
    assert.equal(calls.length, 1);
    assert.ok(r.ok);
  });
  it("a MEMBER stays refused the AI Inbox even when unlocked and the model picks it", async () => {
    const { router } = modelSays(["ai_inbox"]);
    const r = await run(alice, router);
    assert.ok(r.ok);
    if (r.ok) {
      assert.match(JSON.stringify(r.reply), /Only administrators/);
      assert.doesNotMatch(JSON.stringify(r.reply), /awaiting review/);
    }
  });
  it("an admin who is unlocked gets the AI Inbox counts reader used (not a refusal for role)", async () => {
    const { router } = modelSays(["ai_inbox"]);
    const r = await run(admin, router);
    assert.ok(r.ok);
    if (r.ok) assert.doesNotMatch(JSON.stringify(r.reply), /Only administrators/);
  });

  it("the server action hands the router over only after re-validating the unlock cookie on that request", () => {
    const src = readFileSync("src/app/(app)/chat/actions.ts", "utf8");
    assert.match(src, /const router = \(await aiUnlocked\(user\.id\)\) \? chatRouter\(\) : null;/);
    assert.match(src, /isUnlocked\(token, unlockKey\(process\.env\), userId\)/);
    assert.equal((src.match(/chatRouter\(\)/g) ?? []).length >= 3, true);
  });
  it("the cookie is httpOnly, strict same-site and short-lived", () => {
    const src = readFileSync("src/app/(app)/chat/actions.ts", "utf8");
    assert.match(src, /httpOnly: true, sameSite: "strict"/);
    assert.match(src, /maxAge: UNLOCK_TTL_SECONDS/);
  });
  it("the client component never references the code or any server secret", () => {
    const ui = readFileSync("src/components/broko-chat.tsx", "utf8");
    assert.doesNotMatch(ui, /BROKO_AI_DEMO_CODE|BROKO_DEMO_SESSION_SECRET|ANTHROPIC|UPSTASH|KV_REST|process\.env/);
  });
});
