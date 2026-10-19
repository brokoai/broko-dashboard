import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDemoConfig, strongEnoughSecret, supabasePresent } from "../src/lib/env";

const CODE = "correct-horse-battery";                               // 21 chars (dummy test value)
const SECRET = "Qm9r7Xk2LpV8sT4wYb1NcZ6hJdE3uAfG0iOyRtKv5nS";       // dummy test value, >= 32 chars, varied
const prod = { NODE_ENV: "production", VERCEL_ENV: "production" };
const prodFull = { ...prod, BROKO_DEMO_MODE: "true", BROKO_ALLOW_PRODUCTION_DEMO: "true", BROKO_DEMO_ACCESS_CODE: CODE, BROKO_DEMO_SESSION_SECRET: SECRET };

describe("demo mode switch", () => {
  it("is off by default", () => {
    assert.equal(resolveDemoConfig({}).enabled, false);
    assert.equal(resolveDemoConfig({ NODE_ENV: "development" }).enabled, false);
  });

  it("is on in local development with only BROKO_DEMO_MODE=true (no code, no secret)", () => {
    const c = resolveDemoConfig({ NODE_ENV: "development", BROKO_DEMO_MODE: "true" });
    assert.equal(c.enabled, true);
    assert.equal(c.accessCode, undefined);
    assert.equal(c.sessionSecret, undefined);
  });

  it("stays OFF in production with only BROKO_DEMO_MODE=true", () => {
    assert.equal(resolveDemoConfig({ ...prod, BROKO_DEMO_MODE: "true", BROKO_DEMO_ACCESS_CODE: CODE, BROKO_DEMO_SESSION_SECRET: SECRET }).enabled, false);
  });

  it("stays OFF in production with only BROKO_ALLOW_PRODUCTION_DEMO=true", () => {
    assert.equal(resolveDemoConfig({ ...prod, BROKO_ALLOW_PRODUCTION_DEMO: "true", BROKO_DEMO_ACCESS_CODE: CODE, BROKO_DEMO_SESSION_SECRET: SECRET }).enabled, false);
  });

  it("production demo needs both flags, an access code (>= 12) AND a strong session secret (>= 32)", () => {
    const ok = resolveDemoConfig(prodFull);
    assert.equal(ok.enabled, true);
    assert.equal(ok.accessCode, CODE);
    assert.equal(ok.sessionSecret, SECRET);

    const without = (k: keyof typeof prodFull, v?: string) => resolveDemoConfig({ ...prodFull, [k]: v });
    assert.equal(without("BROKO_DEMO_ACCESS_CODE").reason, "production-needs-access-code");
    assert.equal(without("BROKO_DEMO_ACCESS_CODE", "short-code").enabled, false);    // 10 chars
    assert.equal(without("BROKO_DEMO_ACCESS_CODE", "   ").enabled, false);
    assert.equal(without("BROKO_DEMO_SESSION_SECRET").reason, "production-needs-session-secret");
    assert.equal(without("BROKO_DEMO_SESSION_SECRET", "too-short").enabled, false);
    assert.equal(without("BROKO_DEMO_SESSION_SECRET", "a".repeat(64)).enabled, false); // long but no entropy
    assert.equal(without("BROKO_DEMO_MODE").enabled, false);
    assert.equal(without("BROKO_ALLOW_PRODUCTION_DEMO").enabled, false);
  });

  it("the access code alone is never enough in production (it is not key material)", () => {
    assert.equal(resolveDemoConfig({ ...prodFull, BROKO_DEMO_SESSION_SECRET: undefined }).enabled, false);
  });

  it("detects production by any signal, not just NODE_ENV", () => {
    for (const env of [{ VERCEL_ENV: "production" }, { BROKO_ENV: "production" }, { AWS_LAMBDA_FUNCTION_NAME: "x" }]) {
      assert.equal(resolveDemoConfig({ ...env, BROKO_DEMO_MODE: "true" }).enabled, false);
    }
  });
});

describe("Supabase presence makes demo IMPOSSIBLE", () => {
  const flags = { BROKO_DEMO_MODE: "true", BROKO_ALLOW_PRODUCTION_DEMO: "true", BROKO_DEMO_ACCESS_CODE: CODE, BROKO_DEMO_SESSION_SECRET: SECRET };

  it("for any Supabase-looking variable, in production and in development", () => {
    for (const sb of [
      { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" },
      { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" },      // partial config still fails closed
      { NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" },
      { SUPABASE_SERVICE_ROLE_KEY: "k" },
      { SUPABASE_URL: "https://x.supabase.co" },                  // non-public names
      { SUPABASE_ANON_KEY: "k" },
      { SUPABASE_JWT_SECRET: "k" },
      { supabase_url: "x" },                                       // case-insensitive
      { POSTGRES_URL: "postgres://x" },                            // Supabase<->Vercel integration
      { POSTGRES_PRISMA_URL: "postgres://x" },
      { POSTGRES_URL_NON_POOLING: "postgres://x" },
      { NEXT_PUBLIC_SUPABASE_URL: "   " },                         // whitespace-only still counts
    ]) {
      assert.equal(supabasePresent(sb), true, JSON.stringify(Object.keys(sb)));
      assert.equal(resolveDemoConfig({ ...flags, ...prod, ...sb }).enabled, false);
      assert.equal(resolveDemoConfig({ ...flags, NODE_ENV: "development", ...sb }).enabled, false);
    }
  });

  it("empty values (as in .env.example) do not count as present", () => {
    assert.equal(supabasePresent({ NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "" }), false);
    assert.equal(supabasePresent({ UNRELATED: "x", NEXT_PUBLIC_APP_NAME: "y" }), false);
  });
});

describe("session secret strength check", () => {
  it("accepts long varied secrets and rejects short or repetitive ones", () => {
    assert.equal(strongEnoughSecret(SECRET), true);
    assert.equal(strongEnoughSecret(undefined), false);
    assert.equal(strongEnoughSecret("x".repeat(31)), false);
    assert.equal(strongEnoughSecret("ab".repeat(30)), false);        // 60 chars, 2 distinct
    assert.equal(strongEnoughSecret("password-password-password-1234"), false); // 31 chars
  });
});
