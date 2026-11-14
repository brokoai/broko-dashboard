import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { describeErr, expectEmpty, expectNoAccess, schemaHint } from "./live/lib/org-relationships-smoke-plan";
import { REL_SELECT } from "../src/lib/backend/supabase/org-memory";

// Local checks for the READ-ONLY relationship smoke script (tests/live/org-relationships-readonly.live-dev.script.ts). Nothing here touches a network.
const SCRIPT = readFileSync(new URL("./live/org-relationships-readonly.live-dev.script.ts", import.meta.url), "utf8");
const AUDIT = readFileSync(new URL("../supabase/proposed/tests/0014_catalog_audit.proposed.sql", import.meta.url), "utf8");
const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the smoke script probes exactly what the adapter sends", () => {
  it("uses the adapter's own REL_SELECT, with both explicit foreign-key hints and the document embed", () => {
    assert.match(code, /select: REL_SELECT/);
    assert.match(REL_SELECT, /from:org_entities!org_relationships_from_entity_id_fkey\(/);
    assert.match(REL_SELECT, /to:org_entities!org_relationships_to_entity_id_fkey\(/);
    assert.match(REL_SELECT, /doc:org_source_docs!inner\(archived\)/);
  });
  it("the hint names are the constraints the catalog audit checks by exact name", () => {
    assert.match(AUDIT, /org_relationships_from_entity_id_fkey/);
    assert.match(AUDIT, /org_relationships_to_entity_id_fkey/);
  });
  it("has negative controls so a passing embed check could have failed", () => {
    assert.match(code, /org_relationships_no_such_fkey/);
    assert.match(code, /select\("id, e:org_entities\(id\)"\)/);
  });
});

describe("the smoke script cannot write", () => {
  it("contains no insert, update, delete or upsert on a table, and no service role", () => {
    assert.doesNotMatch(code, /\.(insert|update|delete|upsert)\(/);
    assert.doesNotMatch(code, /service_role|SERVICE_ROLE/);
    assert.doesNotMatch(code, /BROKO_ORG_RELATIONSHIPS|runIngestion|handleIngest|extract\(/);
  });
  it("calls only the three relationship functions, and only behind --with-noop-rpc, with all-zero or empty inputs", () => {
    const rpcs = [...code.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)].sort(), ["org_relationship_review", "org_relationship_stale_missing", "org_relationship_upsert"]);
    assert.match(code, /if \(noopRpc\) \{/);
    assert.doesNotMatch(code, /rpc\("org_relationship_review", \{ p_id: (?!ZERO)/);
    assert.match(code, /p_doc: ZERO, p_keep: \[\]/);
    assert.match(code, /p_from: ZERO, p_to: ZERO2/);
  });
  it("only the guarded target is contacted: dev ref guard, confirm variable, no secrets printed", () => {
    assert.match(code, /targetProblems\(/);
    assert.match(code, /signInFailureMessage\(/);
    assert.doesNotMatch(code, /console\.(log|error)\([^)]*(PASSWORD|ANON_KEY)\)/);
  });
});

describe("helpers: sanitized error text and verdicts", () => {
  it("describeErr prints status and code and redacts anything secret-shaped", () => {
    assert.equal(describeErr({ status: 400, code: "PGRST200", message: "Could not find a relationship between 'a' and 'b' in the schema cache" }), "400 PGRST200: Could not find a relationship between 'a' and 'b' in the schema cache");
    const out = describeErr({ status: 401, code: "weird code!", message: "x admin@example.com eyJhbGciOiJIUzI1NiJ9.abc sb_publishable_abcdefghij 123456789" });
    assert.doesNotMatch(out, /admin@example|eyJhbGci|sb_publishable|123456789/);
    assert.match(out, /^401 \?:/);
    assert.equal(describeErr(null), "no error");
  });
  it("schemaHint explains the schema-cache codes", () => {
    for (const c of ["PGRST200", "PGRST201", "PGRST205", "PGRST202", "42501"]) assert.ok(schemaHint({ code: c }), c);
    assert.equal(schemaHint({ code: "XX000" }), null);
    assert.equal(schemaHint(null), null);
  });
  it("expectEmpty passes only for a 200 with an empty list; rows or an error fail, and row data is never shown", () => {
    assert.equal(expectEmpty({ data: [], error: null }).ok, true);
    const rows = expectEmpty({ data: [{ id: "secret-row" }], error: null });
    assert.equal(rows.ok, false);
    assert.doesNotMatch(rows.detail, /secret-row/);
    assert.equal(expectEmpty({ data: null, error: { code: "PGRST200", message: "m" } }).ok, false);
    assert.equal(expectEmpty({ data: {}, error: null }).ok, false);
  });
  it("expectNoAccess passes for permission denied / 401 / empty, and fails if rows come back", () => {
    assert.equal(expectNoAccess({ data: null, error: { code: "42501", message: "permission denied" }, status: 401 }).ok, true);
    assert.equal(expectNoAccess({ data: null, error: { code: "x", message: "m" }, status: 401 }).ok, true);
    assert.equal(expectNoAccess({ data: [], error: null }).ok, true);
    assert.equal(expectNoAccess({ data: [{ id: "r" }], error: null }).ok, false);
    assert.equal(expectNoAccess({ data: null, error: { code: "PGRST200", message: "m" }, status: 400 }).ok, false);
  });
});
