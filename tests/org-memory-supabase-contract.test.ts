import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseOrgMemory } from "../src/lib/backend/supabase/org-memory";
import { hashContent, stableEntityId } from "../src/lib/ai-brain/org-memory";
import { UserFacingError } from "../src/lib/backend/types";
import { ADMIN, MEMBER } from "./precon-helpers";

// The adapter cannot be exercised against a real project: 0013 is PROPOSED and NOT APPLIED. This contract test records exactly what it asks the database for,
// so the decisions in supabase/proposed/0013 (writes only through functions, nothing direct, administrators only, explicit columns, counts-only runs) cannot
// drift. It proves the adapter's requests, NOT that a real database answers them.

interface Call { table?: string; rpc?: string; args?: Record<string, unknown>; ops: [string, unknown[]][] }
function stub(results: Record<string, unknown> = {}, errors: Record<string, { message: string; code?: string }> = {}) {
  const calls: Call[] = [];
  const builder = (call: Call, key: string) => {
    const b: unknown = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => void) => ok({ data: key in results ? results[key] : [], error: errors[key] ?? null });
        return (...args: unknown[]) => { call.ops.push([prop, args]); return b; };
      },
    });
    return b;
  };
  const db = {
    from(table: string) { const c: Call = { table, ops: [] }; calls.push(c); return builder(c, table); },
    rpc(name: string, args?: Record<string, unknown>) { const c: Call = { rpc: name, args, ops: [] }; calls.push(c); return builder(c, name); },
  } as unknown as SupabaseClient;
  return { db, calls };
}
const op = (c: Call, name: string) => c.ops.find(([o]) => o === name)?.[1];
const docRow = { id: "d1", provider: "notion", workspace_id: "ws", source_id: "p1", url: "https://www.notion.so/p1", title: "Weekly sync", doc_type: "page", content: "x", segments: [], coverage: { complete: true, gaps: [], blocks_read: 1 }, content_hash: "h", last_edited: "2026-10-20T10:00:00+00:00", ingested_at: "2026-10-25T12:00:00+00:00", owner: null, access_scope: "admin", sync_status: "synced", attempts: 0, last_error: null, extracted_hash: null, extraction_error: null, archived: false };
const entRow = { id: "e1", stable_id: "abcdef012345", source_doc_id: "d1", entity_type: "task", name: "Send", description: "Priya sends.", evidence: ["S2"], basis: "explicit", confidence: "high", owner: "Priya", team: null, due: null, unknowns: [], extracted_at: "2026-10-25T12:00:00+00:00", review_status: "reviewed", stale: true, knowledge_item_id: null, doc: { archived: false },
  pending_revision: { description: "Priya sends Monday.", evidence: ["S2"], basis: "explicit", confidence: "high", owner: "Priya", team: null, due: "Monday", unknowns: [], extracted_at: "2026-10-26T12:00:00+00:00" } };
const writes = (calls: Call[]) => calls.filter((c) => c.ops.some(([o]) => ["insert", "update", "delete", "upsert"].includes(o)));

describe("Supabase org-memory adapter contract", () => {
  it("a member (or anyone but an administrator) is refused before a single database call", async () => {
    const s = stub({ org_source_docs: docRow, org_entities: [entRow] });
    const { reader, writer, runs } = createSupabaseOrgMemory(s.db, MEMBER);
    assert.deepEqual(await reader.findEntities({ limit: 5 }), []);
    assert.equal(await reader.getEntity("e1"), null);
    assert.equal(await reader.getDocument("d1"), null);
    assert.deepEqual(await reader.listReviewQueue(5), []);
    assert.equal(await writer.getDoc("notion", "ws", "p1"), null);
    assert.deepEqual(await writer.listUnextracted("notion", "ws"), []);
    assert.deepEqual(await writer.listRetryable("notion", "ws", 5), []);
    await assert.rejects(() => reader.review("e1", "approve", null), UserFacingError);
    await assert.rejects(() => writer.upsertEntities("d1", [], "t"), UserFacingError);
    await assert.rejects(() => writer.archiveDoc("notion", "ws", "p1"), UserFacingError);
    assert.deepEqual(await runs.start(), { ok: false, reason: "forbidden" });
    assert.equal(s.calls.length, 0, "fail closed: the database was never asked");
  });

  it("writes go ONLY through the 0013 functions; the tables are never inserted, updated, deleted or upserted", async () => {
    const s = stub({ org_source_docs: docRow, org_memory_upsert_doc: "created", org_memory_upsert_entity: "created", org_memory_stale_missing: 0, org_memory_run_start: "run-1" });
    const { writer, reader, runs } = createSupabaseOrgMemory(s.db, ADMIN);
    await writer.upsertDoc({ provider: "notion", workspace_id: "ws", source_id: "p1", url: null, title: "Weekly sync", doc_type: "page", segments: [{ id: "S1", ref: "b", kind: "text", text: "  Hello   world ", depth: 0 }], coverage: { complete: true, gaps: [], blocks_read: 1 }, last_edited: null, owner: null, ingested_at: "t" });
    await writer.recordFailure("notion", "ws", "p2", { title: "T", url: null }, "timeout", "t");
    await writer.archiveDoc("notion", "ws", "p1");
    await writer.markExtracted("d1", "h", null);
    await writer.upsertEntities("d1", [{ entity_type: "task", name: "Send", description: "d", evidence: ["S1"], basis: "explicit", confidence: "high", owner: null, team: null, due: null, unknowns: [] }], "t");
    await reader.review("e1", "approve", "ok");
    await reader.markPromotionProposed("e1", "k1");
    await runs.start();
    await runs.finish("run-1", "ok", { created: 1 });
    assert.deepEqual(writes(s.calls), [], "no direct table writes");
    const names = s.calls.filter((c) => c.rpc).map((c) => c.rpc);
    assert.deepEqual(names, ["org_memory_upsert_doc", "org_memory_record_failure", "org_memory_archive_doc", "org_memory_mark_extracted", "org_memory_upsert_entity", "org_memory_stale_missing", "org_memory_review", "org_memory_mark_promotion", "org_memory_run_start", "org_memory_run_finish"]);
  });

  it("the document is sent normalized with a hash computed from the normalized text, and the stable entity id is derived from the document", async () => {
    const s = stub({ org_source_docs: docRow, org_memory_upsert_doc: "changed", org_memory_upsert_entity: "updated", org_memory_stale_missing: 2 });
    const { writer } = createSupabaseOrgMemory(s.db, ADMIN);
    const { change } = await writer.upsertDoc({ provider: "notion", workspace_id: "ws", source_id: "p1", url: "https://www.notion.so/p1", title: "Weekly sync", doc_type: "page", segments: [{ id: "S1", ref: "b", kind: "text", text: "  Hello   world ", depth: 0 }, { id: "S2", ref: "c", kind: "text", text: "  ", depth: 0 }], coverage: { complete: true, gaps: [], blocks_read: 2 }, last_edited: "2026-10-20T10:00:00.000Z", owner: null, ingested_at: "t" });
    assert.equal(change, "changed");
    const a = s.calls[0]!.args!;
    assert.equal(a.p_content, "Hello world");
    assert.equal(a.p_hash, hashContent("Weekly sync", ["Hello world"]));
    assert.deepEqual((a.p_segments as { id: string }[]).map((x) => x.id), ["S1"], "an empty segment is not stored");
    for (const k of ["status", "access_scope", "sync_status", "attempts", "id"]) assert.ok(!(k in a), `${k} is never client-supplied`);
    const res = await writer.upsertEntities("d1", [
      { entity_type: "task", name: "Send", description: "d", evidence: ["S1"], basis: "explicit", confidence: "high", owner: null, team: null, due: null, unknowns: [] },
      { entity_type: "task", name: "send ", description: "dup", evidence: ["S1"], basis: "explicit", confidence: "high", owner: null, team: null, due: null, unknowns: [] },
    ], "t");
    const ent = s.calls.filter((c) => c.rpc === "org_memory_upsert_entity");
    assert.equal(ent.length, 1, "the same entity named twice is sent once");
    assert.equal(ent[0]!.args!.p_stable, stableEntityId("d1", "task", "Send"));
    const stale = s.calls.find((c) => c.rpc === "org_memory_stale_missing")!;
    assert.deepEqual(stale.args, { p_doc: "d1", p_keep: [stableEntityId("d1", "task", "Send")] });
    assert.deepEqual(res, { created: 0, updated: 1, staled: 2, unchanged: 0 });
  });

  it("reads name explicit columns (never *), exclude archived sources, hide rejected records, and times come back as ISO instants", async () => {
    const s = stub({ org_entities: [entRow], org_source_docs: docRow });
    const { reader, writer } = createSupabaseOrgMemory(s.db, ADMIN);
    const list = await reader.findEntities({ limit: 500, entity_type: "task", query: "check, list)(  * % \"x\"" });
    await reader.getDocument("d1"); await writer.getDoc("notion", "ws", "p1"); await reader.listReviewQueue(10);
    for (const c of s.calls.filter((x) => x.table)) assert.ok(!/(^|[^\w])\*($|[^\w])/.test(String(op(c, "select")?.[0])), "explicit columns only");
    const find = s.calls[0]!;
    assert.ok(find.ops.some(([o, a]) => o === "eq" && a[0] === "doc.archived" && a[1] === false), "archived sources are excluded");
    assert.ok(find.ops.some(([o, a]) => o === "neq" && a[0] === "review_status" && a[1] === "rejected"));
    assert.deepEqual(op(find, "range"), [0, 199], "a multi-word search reads stable pages of at most 200 rows (no single unbounded read)");
    assert.deepEqual(find.ops.filter(([o]) => o === "order").map(([, a]) => a[0]), ["extracted_at", "id"], "a total order: newest first, then id");
    const filter = String(op(find, "or")?.[0]);
    // The query is now split into words (check, list): the filter is one ilike per word and column, joined by commas. Strip those fixed pieces and quoted values;
    // nothing user-supplied (parentheses, commas, stars, quotes, backslashes) may remain, and the quoted values themselves hold only letters/digits.
    const rest = filter.replace(/(^|,)(name|description|owner|team)\.ilike\./g, "|").replace(/"%[^"]*%"/g, "");
    assert.ok(!/[(),*\\]/.test(rest), "user text cannot add filter syntax: " + filter);
    for (const v of filter.match(/"%[^"]*%"/g) ?? []) assert.ok(/^"%[\p{L}\p{N} _.-]+%"$/u.test(v), "quoted value holds only plain characters: " + v);
    assert.equal(list[0]!.extracted_at, "2026-10-25T12:00:00.000Z");
    assert.equal(list[0]!.pending_revision?.due, "Monday");
    assert.equal(list[0]!.pending_revision?.name, "Send", "a revision keeps the record's identity");
    const doc = await writer.getDoc("notion", "ws", "p1");
    assert.equal(doc!.last_edited, "2026-10-20T10:00:00.000Z", "so it compares equal to the connector's own timestamp");
  });

  it("unextracted documents are found from light columns, then read in full", async () => {
    const s = stub({ org_source_docs: [{ id: "a", content_hash: "h1", extracted_hash: "h1" }, { id: "b", content_hash: "h2", extracted_hash: null }, { id: "c", content_hash: "h3", extracted_hash: "old" }] });
    const { writer } = createSupabaseOrgMemory(s.db, ADMIN);
    await writer.listUnextracted("notion", "ws");
    assert.deepEqual(op(s.calls[1]!, "in"), ["id", ["b", "c"]]);
    assert.ok(!String(op(s.calls[0]!, "select")?.[0]).includes("content,"), "the first pass does not pull page text");
  });

  it("errors never carry source text: known codes map to fixed messages, unknown ones to a code only", async () => {
    const leak = "secret text from a page";
    for (const [code, expect] of [["42501", /permission/i], ["55000", /not in a state/i]] as const) {
      const s = stub({}, { org_memory_review: { message: leak, code } });
      await assert.rejects(() => createSupabaseOrgMemory(s.db, ADMIN).reader.review("e1", "approve", null), (e: Error) => expect.test(e.message) && !e.message.includes(leak));
    }
    const s = stub({}, { org_memory_archive_doc: { message: leak, code: "XX000" } });
    await assert.rejects(() => createSupabaseOrgMemory(s.db, ADMIN).writer.archiveDoc("notion", "ws", "p1"), (e: Error) => !e.message.includes(leak) && /XX000/.test(e.message));
  });

  it("the single ingestion slot: a busy database answer becomes 'busy', not an error", async () => {
    const s = stub({}, { org_memory_run_start: { message: "an ingestion run is already in progress", code: "55P03" } });
    assert.deepEqual(await createSupabaseOrgMemory(s.db, ADMIN).runs.start(), { ok: false, reason: "busy" });
  });
});
