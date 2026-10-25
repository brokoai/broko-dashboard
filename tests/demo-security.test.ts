import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionToken, deriveKey, readSessionToken, sign, verify } from "../src/lib/backend/demo/crypto";
import {
  decodeState, emptyState, encodeState, encodedSize, LIMITS, materialize, toTuple, type DemoState,
} from "../src/lib/backend/demo/state";

const SECRET = "Qm9r7Xk2LpV8sT4wYb1NcZ6hJdE3uAfG0iOyRtKv5nS"; // dummy test value
const mat = { secret: SECRET, allowDevFallback: false };
const key = deriveKey(mat, "session");
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);

describe("signed demo session", () => {
  it("round-trips a valid session", () => {
    assert.equal(readSessionToken(createSessionToken("demo-admin", key, NOW), key, NOW + 1000), "demo-admin");
  });
  it("rejects expired sessions", () => {
    assert.equal(readSessionToken(createSessionToken("demo-admin", key, NOW), key, NOW + 9 * 3600 * 1000), null);
  });
  it("rejects tampered, unsigned, legacy and wrong-key tokens", () => {
    const t = createSessionToken("demo-member-a", key, NOW);
    const [body, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "demo-admin", exp: 9_999_999_999 })).toString("base64url");
    assert.equal(readSessionToken(`${forged}.${mac}`, key, NOW), null);            // payload swapped
    assert.equal(readSessionToken(`${body}.${mac.slice(0, -2)}xx`, key, NOW), null); // mac altered
    assert.equal(readSessionToken("demo-admin", key, NOW), null);                    // old cookie format
    assert.equal(readSessionToken("", key, NOW), null);
    assert.equal(readSessionToken(undefined, key, NOW), null);
    assert.equal(readSessionToken(t, deriveKey({ ...mat, secret: "A".repeat(10) + SECRET }, "session"), NOW), null); // other secret
    assert.equal(readSessionToken(t, deriveKey(mat, "state"), NOW), null);           // purposes are separated
  });
  it("sign/verify is symmetric and key-bound", () => {
    assert.equal(verify(sign("hello", key), key), "hello");
    assert.equal(verify(sign("hello", key), deriveKey({ ...mat, secret: "x".repeat(40) }, "session")), null);
  });
});

describe("key derivation", () => {
  it("refuses to run without a secret when the dev fallback is not allowed (production-like)", () => {
    assert.throws(() => deriveKey({ allowDevFallback: false }, "session"), /secret is required/);
  });
  it("uses a distinct key per purpose and produces 32 bytes", () => {
    const s = deriveKey(mat, "session"), t = deriveKey(mat, "state");
    assert.equal(s.length, 32);
    assert.notDeepEqual(s, t);
  });
  it("a different secret gives a different key", () => {
    assert.notDeepEqual(deriveKey(mat, "session"), deriveKey({ ...mat, secret: "Z".repeat(8) + SECRET }, "session"));
  });
  it("development fallback works only when explicitly allowed", () => {
    assert.equal(deriveKey({ allowDevFallback: true }, "session").length, 32);
  });
});

describe("browser-local state: validation and bounds", () => {
  it("garbage, wrong shapes and oversize input decode to an empty state", () => {
    for (const raw of [undefined, null, "", "not json", "[]", '{"t":"x","e":5}', "x".repeat(20_000)]) {
      assert.deepEqual(decodeState(raw), emptyState());
    }
  });
  it("drops invalid entries and keeps valid ones", () => {
    const good = toTuple(materialize(emptyState(), NOW).tasks[0]);
    const bad = [...good]; bad[3] = 99; // status out of range
    const evil = [...good]; evil[0] = "<script>"; // id fails the allow-list
    const dup = [...good];
    const s = decodeState(JSON.stringify({ t: [good, bad, evil, dup], e: [[9, "s1", 0, 0, -1, -1], [0, "s1", 1, 0, -1, -1]] }));
    assert.equal(s.t.length, 1);
    assert.equal(s.e.length, 1);
  });
  it("never exceeds the task/event limits even if the cookie claims more", () => {
    const base = toTuple(materialize(emptyState(), NOW).tasks[0]);
    const t = Array.from({ length: 50 }, (_, i) => { const x = [...base]; x[0] = `id${i}`; return x; });
    const e = Array.from({ length: 50 }, () => [0, "s1", 1, 0, -1, -1]);
    const s = decodeState(JSON.stringify({ t, e }));
    assert.ok(s.t.length <= LIMITS.tasks && s.e.length <= LIMITS.events);
  });
  it("worst-case ASCII state fits a signed cookie under 4 KB", () => {
    const base = toTuple(materialize(emptyState(), NOW).tasks[0]);
    const s: DemoState = {
      t: Array.from({ length: LIMITS.tasks }, (_, i) => { const x = [...base] as DemoState["t"][number]; x[0] = `n${String(i).padStart(10, "0")}`; x[1] = "T".repeat(LIMITS.title); x[2] = "D".repeat(LIMITS.description); return x; }),
      e: Array.from({ length: LIMITS.events }, (_, i) => [3, `n${String(i).padStart(10, "0")}`, 1_900_000_000, 2, 2, 3]),
      r: Array.from({ length: LIMITS.aiMessages }, (_, i): [number, number, number] => [i, 2, 1_900_000_000]),
    };
    assert.ok(encodedSize(s) <= LIMITS.maxEncodedBytes, `payload ${encodedSize(s)}B`);
    const cookie = `broko_demo_state=${sign(encodeState(s), deriveKey({ secret: SECRET, allowDevFallback: false }, "state"))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`;
    assert.ok(Buffer.byteLength(cookie) < 4096, `cookie ${Buffer.byteLength(cookie)}B`);
  });
});
