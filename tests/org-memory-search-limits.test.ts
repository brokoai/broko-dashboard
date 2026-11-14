import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryTools } from "../src/lib/ai-brain/assistant/memory-tools";
import { searchNote } from "../src/lib/ai-brain/chat/tool-agent";
import { createMemoryOrgStore, runIngestion, type Extractor } from "../src/lib/ai-brain/org-memory";
import { ENDPOINT_BATCH, MAX_SEARCH_PAGES, SEARCH_PAGE_SIZE } from "../src/lib/ai-brain/org-memory/query";
import { createSupabaseOrgMemory } from "../src/lib/backend/supabase/org-memory";
import { unavailableConnectors, type NotionConnector } from "../src/lib/ai-brain/assistant";
import { NOW, admin, alice } from "./ai-chat-helpers";
import { ADMIN } from "./precon-helpers";

/**
 * K1/K2 follow-up (local only, no Supabase): the adapter reads entities and relationship endpoints in stable pages and small batches, ranks across ALL pages it
 * reads, never builds an oversized id filter, reports a hit work limit instead of claiming "no match", and treats `_` and `%` like any other separator.
 * The fake below is a small in-memory PostgREST: it applies eq/neq/or(ilike | in)/order/range/limit to plain row arrays, with real LIKE semantics.
 */

type Row = Record<string, unknown>;
interface Call { table: string; or: string[]; ranges: [number, number][]; limits: number[]; eqs: [string, unknown][]; neqs: [string, unknown][] }
const likeRe = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "is");

function fakeDb(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, or: [], ranges: [], limits: [], eqs: [], neqs: [] };
      calls.push(call);
      let rows = [...(tables[table] ?? [])];
      const order: [string, boolean][] = [];
      let from = 0; let to = Infinity;
      const b: Record<string, unknown> = {};
      const self = () => b;
      b.select = self;
      b.eq = (c: string, v: unknown) => { call.eqs.push([c, v]); if (c !== "doc.archived") rows = rows.filter((r) => r[c] === v); return b; };
      b.neq = (c: string, v: unknown) => { call.neqs.push([c, v]); rows = rows.filter((r) => r[c] !== v); return b; };
      b.in = self;
      b.or = (expr: string) => {
        call.or.push(expr);
        const inM = expr.match(/^from_entity_id\.in\.\(([^)]*)\),to_entity_id\.in\.\(([^)]*)\)$/);
        if (inM) { const f = new Set(inM[1]!.split(",")); const t = new Set(inM[2]!.split(",")); rows = rows.filter((r) => f.has(String(r.from_entity_id)) || t.has(String(r.to_entity_id))); return b; }
        const terms = [...expr.matchAll(/(\w+)\.ilike\."([^"]*)"/g)].map((m) => ({ col: m[1]!, re: likeRe(m[2]!) }));
        if (terms.length) rows = rows.filter((r) => terms.some((t) => t.re.test(String(r[t.col] ?? ""))));
        return b;
      };
      b.order = (c: string, o?: { ascending?: boolean }) => { order.push([c, o?.ascending !== false]); return b; };
      b.range = (a: number, z: number) => { call.ranges.push([a, z]); from = a; to = z; return b; };
      b.limit = (n: number) => { call.limits.push(n); to = from + n - 1; return b; };
      b.then = (ok: (v: unknown) => void) => {
        const sorted = [...rows].sort((x, y) => { for (const [c, asc] of order) { const a = String(x[c]); const z = String(y[c]); if (a !== z) return (a < z ? -1 : 1) * (asc ? 1 : -1); } return 0; });
        ok({ data: sorted.slice(from, to + 1), error: null });
      };
      return b;
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const ts = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(); // larger i = newer
const ent = (i: number, name: string, description = "d", extra: Row = {}): Row => ({
  id: `e${String(i).padStart(5, "0")}`, stable_id: `s${i}`, source_doc_id: "d1", entity_type: "task", name, description, evidence: ["S2"], basis: "explicit", confidence: "high", owner: null, team: null,
  due: null, unknowns: [], extracted_at: ts(i), review_status: "proposed", stale: false, pending_revision: null, knowledge_item_id: null, doc: { archived: false }, ...extra,
});
const reader = (rows: Record<string, Row[]>, user = ADMIN) => { const f = fakeDb(rows); return { ...f, reader: createSupabaseOrgMemory(f.db, user).reader }; };
const entityCalls = (t: { calls: Call[] }) => t.calls.filter((c) => c.table === "org_entities");

describe("entity search: stable pages, ranking across all pages read, honest budget", () => {
  it("a relevant OLD entity beyond the first 200 candidates is found and ranks above newer partial matches", async () => {
    const rows = [ent(0, "Confirm warehouse slot", "Dana confirms it."), ...Array.from({ length: 450 }, (_v, k) => ent(k + 1, `Warehouse item ${k}`))];
    const t = reader({ org_entities: rows });
    const out = { budget_reached: false };
    const found = await t.reader.findEntities({ query: "warehouse slot", limit: 5, outcome: out });
    assert.equal(found[0]!.name, "Confirm warehouse slot", "two matched words beat one, however old");
    assert.equal(found.length, 5);
    assert.equal(out.budget_reached, false);
    const ranges = entityCalls(t).flatMap((c) => c.ranges);
    assert.ok(ranges.length >= 3 && ranges.length <= MAX_SEARCH_PAGES, `pages read: ${ranges.length}`);
    assert.deepEqual(ranges.slice(0, 2), [[0, SEARCH_PAGE_SIZE - 1], [SEARCH_PAGE_SIZE, 2 * SEARCH_PAGE_SIZE - 1]]);
  });
  it("pages follow a total order (newest first, then id) so none overlap or skip", async () => {
    const t = reader({ org_entities: Array.from({ length: 10 }, (_v, k) => ent(k, `Slot ${k}`, "d", { extracted_at: ts(5) })) });
    const found = await t.reader.findEntities({ query: "slot warehouse", limit: 10 });
    assert.deepEqual(found.map((e) => e.id), Array.from({ length: 10 }, (_v, k) => `e${String(k).padStart(5, "0")}`));
  });
  it("stops reading as soon as the best rows cannot be beaten", async () => {
    const t = reader({ org_entities: Array.from({ length: 1000 }, (_v, k) => ent(k, "Warehouse slot plan")) });
    await t.reader.findEntities({ query: "warehouse slot", limit: 3 });
    assert.equal(entityCalls(t).flatMap((c) => c.ranges).length, 1);
  });
  it("search-budget exhaustion is reported; a genuine empty result and a small result are not", async () => {
    const big = reader({ org_entities: Array.from({ length: (MAX_SEARCH_PAGES + 1) * SEARCH_PAGE_SIZE }, (_v, k) => ent(k, `Warehouse item ${k}`)) });
    const hit = { budget_reached: false };
    const r = await big.reader.findEntities({ query: "warehouse slot", limit: 5, outcome: hit });
    assert.equal(r.length, 5);
    assert.equal(hit.budget_reached, true, "older rows were not read");
    assert.equal(entityCalls(big).flatMap((c) => c.ranges).length, MAX_SEARCH_PAGES);
    const none = { budget_reached: false };
    assert.deepEqual(await reader({ org_entities: [ent(1, "Checklist")] }).reader.findEntities({ query: "warehouse slot", limit: 5, outcome: none }), []);
    assert.equal(none.budget_reached, false, "a genuine zero-result search");
    const small = { budget_reached: false };
    await reader({ org_entities: Array.from({ length: 150 }, (_v, k) => ent(k, `Warehouse item ${k}`)) }).reader.findEntities({ query: "warehouse slot", limit: 5, outcome: small });
    assert.equal(small.budget_reached, false);
  });
  it("filters stay in force (type, document, rejected, archived)", async () => {
    const rows = [ent(1, "Warehouse slot", "d", { entity_type: "risk" }), ent(2, "Warehouse slot", "d", { source_doc_id: "d2" }), ent(3, "Warehouse slot", "d", { review_status: "rejected" }), ent(4, "Warehouse slot")];
    const t = reader({ org_entities: rows });
    const found = await t.reader.findEntities({ query: "warehouse slot", limit: 10, entity_type: "task", source_doc_id: "d1" });
    assert.deepEqual(found.map((e) => e.id), ["e00004"]);
    const c = entityCalls(t)[0]!;
    assert.ok(c.eqs.some(([k, v]) => k === "doc.archived" && v === false) && c.neqs.some(([k, v]) => k === "review_status" && v === "rejected"));
  });
});

const end = (id: string, name: string, extra: Row = {}): Row => ({ id, entity_type: "task", name, review_status: "proposed", stale: false, pending_revision: null, source_doc_id: "d1", ...extra });
const rel = (i: number, a: Row, b: Row, extra: Row = {}): Row => ({
  id: `r${String(i).padStart(5, "0")}`, stable_id: `rs${i}`, source_doc_id: "d1", from_entity_id: a.id, to_entity_id: b.id, relation_type: "DEPENDS_ON", evidence: ["S2"], basis: "explicit", confidence: "high",
  extracted_at: ts(i), review_status: "proposed", stale: false, pending_revision: null, doc: { archived: false }, from: a, to: b, ...extra,
});

describe("relationship search: bounded id batches, both ends, one copy each", () => {
  const orbit = Array.from({ length: 130 }, (_v, k) => end(`o${String(k).padStart(4, "0")}`, `Orbit ${k}`));
  const other = Array.from({ length: 6 }, (_v, k) => end(`x${k}`, `Plain ${k}`));
  const entityRows = [...orbit, ...other].map((e, k) => ent(k, String(e.name), "d", { id: e.id }));
  const rels: Row[] = [];
  orbit.slice(0, 60).forEach((o, k) => rels.push(rel(k, o, orbit[(k * 2 + 7) % 130]!)));  // both ends match; the ends land in different batches
  other.forEach((x, k) => rels.push(rel(100 + k, x, orbit[120 + k]!)));                    // only the TARGET matches (late batch)
  other.forEach((x, k) => rels.push(rel(200 + k, orbit[k]!, x)));                          // only the SOURCE matches (early batch)

  it("returns every expected relationship once, from source or target matches, across batches", async () => {
    const t = reader({ org_entities: entityRows, org_relationships: rels });
    const out = { budget_reached: false };
    const found = await t.reader.findRelationships({ query: "orbit", limit: 200, outcome: out });
    const ids = found.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicates after aggregation");
    assert.equal(ids.length, 72, "60 internal + 6 target-only + 6 source-only");
    for (const k of [100, 105, 200, 205]) assert.ok(ids.includes(`r${String(k).padStart(5, "0")}`), `r${k}`);
    assert.equal(out.budget_reached, false);
  });
  it("never sends more than ENDPOINT_BATCH ids per request, and splits 130 ids into 3 requests", async () => {
    const t = reader({ org_entities: entityRows, org_relationships: rels });
    await t.reader.findRelationships({ query: "orbit", limit: 10 });
    const ors = t.calls.filter((c) => c.table === "org_relationships").flatMap((c) => c.or);
    assert.equal(ors.length, Math.ceil(130 / ENDPOINT_BATCH));
    for (const o of ors) { assert.ok(o.split(",").length - 1 <= 2 * ENDPOINT_BATCH, "ids per request bounded"); assert.ok(o.length < 4200, `filter length ${o.length}`); }
  });
  it("the result is cut to the limit after a stable newest-first order", async () => {
    const t = reader({ org_entities: entityRows, org_relationships: rels });
    const found = await t.reader.findRelationships({ query: "orbit", limit: 4 });
    assert.deepEqual(found.map((r) => r.id), ["r00205", "r00204", "r00203", "r00202"]);
  });
  it("type, source document, rejected and ineligible-endpoint filters still apply in every batch", async () => {
    const stale = end("z1", "Orbit stale", { stale: true });
    const withExtra = [...rels,
      rel(300, orbit[1]!, orbit[2]!, { relation_type: "OWNS" }), rel(301, orbit[3]!, orbit[4]!, { review_status: "rejected" }), rel(302, orbit[5]!, orbit[6]!, { source_doc_id: "d2" }),
      rel(303, stale, orbit[7]!)];
    const t = reader({ org_entities: [...entityRows, ent(900, "Orbit stale", "d", { id: "z1" })], org_relationships: withExtra });
    const owns = await t.reader.findRelationships({ query: "orbit", limit: 50, relation_type: "OWNS" });
    assert.deepEqual(owns.map((r) => r.id), ["r00300"]);
    const d1 = await t.reader.findRelationships({ query: "orbit", limit: 200, source_doc_id: "d1" });
    assert.ok(!d1.some((r) => r.id === "r00302") && !d1.some((r) => r.id === "r00301"), "other document and rejected excluded");
    assert.ok(!d1.some((r) => r.id === "r00303"), "a stale endpoint makes the link ineligible (never citable as current)");
    const withRejected = await t.reader.findRelationships({ query: "orbit", limit: 200, include_rejected: true });
    assert.ok(withRejected.some((r) => r.id === "r00301"));
  });
  it("an entity_id filter is intersected with the name matches, still bounded", async () => {
    const t = reader({ org_entities: entityRows, org_relationships: rels });
    const found = await t.reader.findRelationships({ entity_id: "o0000", query: "orbit", limit: 50 });
    assert.ok(found.length > 0 && found.every((r) => r.from.id === "o0000" || r.to.id === "o0000"));
  });
  it("a hit work limit is reported, not hidden; a genuine empty result is not", async () => {
    const many = Array.from({ length: 1100 }, (_v, k) => ent(k, `Orbit ${k}`, "d", { id: `m${String(k).padStart(5, "0")}` }));
    const out = { budget_reached: false };
    await reader({ org_entities: many, org_relationships: [] }).reader.findRelationships({ query: "orbit", limit: 5, outcome: out });
    assert.equal(out.budget_reached, true);
    const none = { budget_reached: false };
    assert.deepEqual(await reader({ org_entities: entityRows, org_relationships: rels }).reader.findRelationships({ query: "nomatchword", limit: 5, outcome: none }), []);
    assert.equal(none.budget_reached, false);
  });
});

describe("`_` and `%` are separators: no wildcard reaches the database, adapter and twin agree", () => {
  const NAMES = ["Slot plan", "slotXplan", "Slot_plan", "Roadmap"];
  const notion = (): NotionConnector => ({
    ...unavailableConnectors().notion,
    async findMeetingCandidates() { return { ok: true, data: [{ system: "notion", record_id: "p1", title: "T", url: "https://www.notion.so/p1", last_edited: "2026-10-20T10:00:00.000Z", date_only: false, date_source: "none" }] } as never; },
    async readMeetingDocument(id) { return { ok: true, data: { system: "notion", record_id: id, title: "T", url: "https://www.notion.so/p1", last_edited: "2026-10-20T10:00:00.000Z", date_only: false, date_source: "none", segments: [{ id: "S1", ref: "b0", kind: "title", text: "T", depth: 0 }, { id: "S2", ref: "b1", kind: "text", text: "Notes.", depth: 0 }] } } as never; },
  });
  const extractor: Extractor = { async extract() { return { ok: true, truncated: false, raw: NAMES.map((n) => ({ entity_type: "task", name: n, description: "Notes.", evidence: ["S2"], basis: "explicit", confidence: "high" })) }; } };
  it("the same queries return the same records from both implementations; the filter holds no _ or %", async () => {
    const store = createMemoryOrgStore(() => NOW);
    await runIngestion({ notion: notion(), writer: store.writer, extractor }, { workspaceId: "ws-1", now: () => NOW });
    const twin = store.readerFor(admin);
    const t = reader({ org_entities: NAMES.map((n, k) => ent(k, n, "Notes.")) });
    for (const q of ["slot_plan", "slot%plan", "plan_", "sl_t", "%", "_"]) {
      const a = (await t.reader.findEntities({ query: q, limit: 10 })).map((e) => e.name).sort();
      const b = (await twin.findEntities({ query: q, limit: 10 })).map((e) => e.name).sort();
      assert.deepEqual(a, b, `query ${JSON.stringify(q)}`);
    }
    for (const c of t.calls) for (const expr of c.or) assert.ok(!/[%_]/.test(expr.replace(/"%/g, "").replace(/%"/g, "").replace(/(name|description|owner|team)\.ilike\./g, "")), expr);
  });
});

describe("authorization, citations and messaging stay intact", () => {
  it("a member gets nothing and the database is never called (entities and relationships)", async () => {
    const t = reader({ org_entities: [ent(1, "Warehouse slot")], org_relationships: [] }, alice);
    assert.deepEqual(await t.reader.findEntities({ query: "warehouse slot", limit: 5 }), []);
    assert.deepEqual(await t.reader.findRelationships({ query: "warehouse", limit: 5 }), []);
    assert.equal(t.calls.length, 0);
  });
  it("the memory tools still require an administrator and pass the outcome through to the delivered result", async () => {
    const tools = memoryTools();
    for (const id of ["memory.entities.find", "memory.relationships.find"]) assert.equal(tools.find((x) => x.id === id)!.requires, "admin");
    const stop = async (q: { outcome?: { budget_reached: boolean } }) => { if (q.outcome) q.outcome.budget_reached = true; return []; };
    const ctx = { brain: { orgMemory: { findEntities: stop, findRelationships: stop, getDocument: async () => null } }, now: NOW } as never;
    const e = await tools.find((x) => x.id === "memory.entities.find")!.run!({ limit: 5, query: "x" }, ctx);
    const r = await tools.find((x) => x.id === "memory.relationships.find")!.run!({ limit: 5, query: "x" }, ctx);
    assert.equal((e as { native: { budget_reached?: boolean } }).native.budget_reached, true);
    assert.equal((r as { native: { budget_reached?: boolean } }).native.budget_reached, true);
  });
  it("an empty result and a budget stop are told apart to the model", () => {
    assert.match(searchNote(0, undefined).hint ?? "", /No stored record matched/);
    assert.deepEqual(searchNote(3, undefined), {});
    const stopped = searchNote(0, true);
    assert.equal(stopped.budget_reached, true);
    assert.match(stopped.hint ?? "", /work limit.*does NOT mean nothing matches/);
    assert.equal(searchNote(2, true).budget_reached, true, "partial results are flagged too");
  });
});
