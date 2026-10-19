import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientKey } from "../src/lib/backend/demo/client-key";

const hdr = (h: Record<string, string>) => (name: string) => h[name] ?? null;

describe("rate-limit client key (header spoofing)", () => {
  it("ignores forwarded headers entirely when no trusted proxy is configured (one shared bucket)", () => {
    const a = clientKey(hdr({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }), {});
    const b = clientKey(hdr({ "x-forwarded-for": "9.9.9.9", "x-real-ip": "8.8.8.8" }), {});
    assert.equal(a, b);
    assert.equal(a, "untrusted");
  });

  it("on Vercel uses the platform-set header and ignores a client-supplied x-forwarded-for", () => {
    const env = { VERCEL: "1" };
    const real = { "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "6.6.6.6, 203.0.113.7" };
    assert.equal(clientKey(hdr(real), env), "203.0.113.7");
    // an attacker rotating x-forwarded-for does not change the key
    assert.equal(clientKey(hdr({ ...real, "x-forwarded-for": "7.7.7.7" }), env), "203.0.113.7");
  });

  it("behind an opted-in trusted proxy uses x-real-ip, else the RIGHTMOST x-forwarded-for entry", () => {
    const env = { BROKO_TRUST_PROXY: "true" };
    assert.equal(clientKey(hdr({ "x-real-ip": "198.51.100.4" }), env), "198.51.100.4");
    assert.equal(clientKey(hdr({ "x-forwarded-for": "6.6.6.6, 5.5.5.5, 198.51.100.9" }), env), "198.51.100.9"); // not the spoofable first entry
  });

  it("rejects malformed or oversized values (falls back to the shared bucket, bounded length)", () => {
    const env = { VERCEL: "1" };
    for (const bad of ["", "not an ip!", "x".repeat(500), "<script>", "1.1.1.1\\nSet-Cookie: a=b"]) {
      const k = clientKey(hdr({ "x-vercel-forwarded-for": bad }), env);
      assert.ok(k === "untrusted" || /^[0-9a-f:.]{2,64}$/.test(k), `${bad.slice(0, 12)} -> ${k}`);
      assert.ok(k.length <= 64);
    }
    assert.equal(clientKey(hdr({}), env), "untrusted");
  });

  it("accepts IPv6", () => {
    assert.equal(clientKey(hdr({ "x-vercel-forwarded-for": "2001:db8::1" }), { VERCEL: "1" }), "2001:db8::1");
  });
});
