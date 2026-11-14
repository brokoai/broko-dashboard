import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SECRET_PATTERNS, secretSignals } from "../src/lib/knowledge/safety";

// The application screen (src/lib/knowledge/safety.ts) and the DRAFT database trigger (supabase/proposed/0012) must agree on the formats
// the database enforces. The same corpus is run against both: this file runs it against the JavaScript patterns, and
// supabase/proposed/tests/0012_knowledge_secret_check.pglite.mjs runs it against the SQL on a local PostgreSQL.

interface Case { name: string; parts: string[]; js: string; db: string | null; app_only?: boolean; js_raw?: boolean }
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const CASES = (JSON.parse(read("tests/fixtures/secret-corpus.json")) as { cases: Case[] }).cases;
const SQL = read("supabase/proposed/0012_knowledge_secret_check.proposed.sql");
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, ""); // whole-line comments only: a "--" inside a pattern literal must survive
const textOf = (c: Case) => c.parts.join("");

describe("secret corpus: the application screen", () => {
  for (const c of CASES) {
    it(`${c.name}: application reports ${c.js}`, () => {
      const ids = secretSignals(textOf(c));
      if (c.js === "none") assert.deepEqual(ids, [], `expected nothing, got ${ids.join(",")}`);
      else assert.ok(ids.includes(c.js), `expected ${c.js}, got ${ids.join(",") || "nothing"}`);
    });
  }
  it("the corpus covers every format the database enforces, at least one case that must NOT match, and the application-only formats", () => {
    const enforced = new Set(CASES.map((c) => c.db).filter((x): x is string => x !== null));
    for (const id of ["private_key", "api_key_prefix", "supabase_key", "jwt", "aws_key", "vcs_token", "slack_token"]) assert.ok(enforced.has(id), `no corpus case for ${id}`);
    assert.ok(CASES.filter((c) => c.db === null && c.js === "none").length >= 5);
    assert.ok(CASES.filter((c) => c.app_only).length >= 3);
  });
  it("a case marked application-only is something the database deliberately does not enforce", () => {
    for (const c of CASES.filter((x) => x.app_only)) assert.equal(c.db, null, c.name);
  });
  it("every case where the database refuses is either refused by the application too, or is a normalization case the application never sees raw", () => {
    for (const c of CASES.filter((x) => x.db !== null)) assert.ok(c.js !== "none" || c.js_raw === true, c.name);
  });
});

describe("draft migration 0012 (static; behaviour is in 0012_knowledge_secret_check.pglite.mjs)", () => {
  it("is a draft: marked as not applied, and kept out of supabase/migrations", () => {
    assert.match(SQL, /DRAFT, NOT APPLIED/);
    assert.ok(!existsSync(new URL("../supabase/migrations/0012_knowledge_secret_check.sql", import.meta.url)));
  });
  it("every id the database can report is also an application pattern id (no database-only formats)", () => {
    const dbIds = [...CODE.matchAll(/then return '(\w+)'/g)].map((m) => m[1]);
    assert.equal(new Set(dbIds).size, 7);
    const appIds = new Set(SECRET_PATTERNS.map((p) => p.id));
    for (const id of dbIds) assert.ok(appIds.has(id), `${id} is enforced by the database but not by the application`);
  });
  it("the guard covers insert and update of title, body, topic, source_ref and review_note, for every role (no auth.uid() bypass)", () => {
    assert.match(CODE, /before insert or update of title, body, topic, source_ref, review_note on public\.knowledge_items/);
    const guard = /create or replace function public\.knowledge_secret_guard[\s\S]*?end \$\$;/.exec(CODE)?.[0] ?? "";
    assert.ok(guard.length > 0);
    assert.ok(!/auth\.uid\(\)|is_admin\(\)|current_user|session_user/.test(guard), "the guard must not exempt any caller");
    assert.match(guard, /security definer set search_path = ''/);
  });
  it("the history table's note is guarded too, by a separate trigger that exempts no caller", () => {
    assert.match(CODE, /before insert or update of note on public\.knowledge_events/);
    const g = /create or replace function public\.knowledge_events_secret_guard[\s\S]*?end \$\$;/.exec(CODE)?.[0] ?? "";
    assert.ok(g.length > 0 && !/auth\.uid\(\)|is_admin\(\)|current_user|session_user/.test(g));
    assert.match(g, /knowledge_secret_signal\(new\.note\)/);
    assert.match(g, /security definer set search_path = ''/);
    assert.ok(!/new\.note/.test(/raise exception[^;]*;/.exec(g)?.[0] ?? ""), "the error must not carry the note");
    assert.match(CODE, /revoke all on function public\.knowledge_events_secret_guard\(\) from public, anon, authenticated, service_role/);
  });
  it("the error carries the pattern id only, never the text", () => {
    const guard = /create or replace function public\.knowledge_secret_guard[\s\S]*?end \$\$;/.exec(CODE)?.[0] ?? "";
    const raise = /raise exception[^;]*;/.exec(guard)?.[0] ?? "";
    assert.match(raise, /\(%\)', signal/);
    assert.ok(!/new\.(title|body|topic|source_ref)/.test(raise));
  });
  it("neither function is executable by any API role, and the file grants nothing", () => {
    assert.match(CODE, /revoke all on function public\.knowledge_secret_signal\(text\) from public, anon, authenticated, service_role/);
    assert.match(CODE, /revoke all on function public\.knowledge_secret_guard\(\) from public, anon, authenticated, service_role/);
    assert.ok(!/\bgrant\b/i.test(CODE));
  });
  it("has no destructive statement and does not touch the tables of other migrations", () => {
    assert.ok(!/^\s*(drop|truncate|delete from)\b/im.test(CODE));
    assert.ok(!/alter table/i.test(CODE) && !/create table/i.test(CODE));
  });
  it("removes invisible and control characters before matching", () => {
    assert.match(SQL, /regexp_replace\(coalesce\(p_text, ''\), '\[\\u0001-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\]', '', 'g'\)/);
  });
});
