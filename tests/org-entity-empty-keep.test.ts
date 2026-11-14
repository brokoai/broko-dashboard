import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unavailableConnectors } from "../src/lib/ai-brain/assistant";
import type { NotionConnector } from "../src/lib/ai-brain/assistant";
import type { MeetingCandidate, MeetingDocument } from "../src/lib/ai-brain/assistant/meetings/types";
import { createMemoryOrgStore, runIngestion, type EntityFields, type Extractor } from "../src/lib/ai-brain/org-memory";
import { createSupabaseOrgMemory } from "../src/lib/backend/supabase/org-memory";
import { NOW, admin } from "./ai-chat-helpers";
import { ADMIN } from "./precon-helpers";

/**
 * Phase 2A regression (local only): an extraction that kept NO valid entity (empty answer, everything failed validation, or a missing list) proves nothing
 * about what the document states, so it must never mark existing entities stale, REVIEWED ones included. The 0013 function org_memory_stale_missing would
 * stale every non-rejected entity of the document for an empty keep list; the adapter and the in-memory twin now never ask it to. A non-empty list still
 * reconciles. (0013 itself is untouched.)
 */

const TITLE = "Weekly sync";
const LINES = ["Priya will send the checklist by Friday.", "Decision: launch the marketplace in Pune first."];
function notion(): NotionConnector {
  return {
    ...unavailableConnectors().notion,
    async findMeetingCandidates() { return { ok: true, data: [{ system: "notion", record_id: "p1", title: TITLE, url: "https://www.notion.so/p1", last_edited: "2026-10-20T10:00:00.000Z", date_only: false, date_source: "none", retrieved_at: NOW.toISOString() } as MeetingCandidate] }; },
    async readMeetingDocument(id) {
      const segments = [TITLE, ...LINES].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? ("title" as const) : ("text" as const), text: t, depth: 0 }));
      return { ok: true, data: { system: "notion", record_id: id, title: TITLE, url: "https://www.notion.so/p1", last_edited: "2026-10-20T10:00:00.000Z", date_only: false, date_source: "none", retrieved_at: NOW.toISOString(), segments, coverage: { complete: true, gaps: [], blocks_read: segments.length } } as MeetingDocument };
    },
  };
}
const ENT = (entity_type: string, name: string, evidence: string) => ({ entity_type, name, description: `${name} is stated in the notes.`, evidence: [evidence], basis: "explicit", confidence: "high" });
const THREE = [ENT("person", "Priya", "S2"), ENT("task", "Send checklist", "S2"), ENT("decision", "Launch in Pune", "S3")];
const extractor: Extractor = { async extract() { return { ok: true, raw: THREE, truncated: false }; } };

async function seeded() {
  const store = createMemoryOrgStore(() => NOW);
  await runIngestion({ notion: notion(), writer: store.writer, extractor }, { workspaceId: "ws-1", now: () => NOW });
  const reader = store.readerFor(admin);
  const byName = (n: string) => store.snapshot().entities.find((e) => e.name === n)!;
  await reader.review(byName("Send checklist").id, "approve", null); // one REVIEWED entity
  const docId = store.snapshot().docs[0]!.id;
  const fields = (n: string): EntityFields => { const e = byName(n); return { entity_type: e.entity_type, name: e.name, description: e.description, evidence: e.evidence, basis: e.basis, confidence: e.confidence, owner: e.owner, team: e.team, due: e.due, unknowns: e.unknowns }; };
  return { store, byName, docId, fields };
}

describe("an empty extraction never stales entities (in-memory behaviour, the reference for the adapter)", () => {
  it("empty list: nothing goes stale, the reviewed entity is untouched, the counts are zero", async () => {
    const w = await seeded();
    const out = await w.store.writer.upsertEntities(w.docId, [], NOW.toISOString());
    assert.deepEqual(out, { created: 0, updated: 0, staled: 0, unchanged: 0 });
    for (const e of w.store.snapshot().entities) assert.equal(e.stale, false, e.name);
    assert.equal(w.byName("Send checklist").review_status, "reviewed");
  });
  it("non-empty list that omits some entities: the omitted ones go stale (reviewed included, never rejected or overwritten)", async () => {
    const w = await seeded();
    const out = await w.store.writer.upsertEntities(w.docId, [w.fields("Priya")], NOW.toISOString());
    assert.equal(out.staled, 2);
    assert.equal(w.byName("Priya").stale, false);
    assert.equal(w.byName("Launch in Pune").stale, true);
    assert.equal(w.byName("Send checklist").stale, true, "a reviewed entity the document no longer states is marked stale (not deleted, not rejected)");
    assert.equal(w.byName("Send checklist").review_status, "reviewed");
  });
  it("a non-empty list that restates everything stales nothing", async () => {
    const w = await seeded();
    const out = await w.store.writer.upsertEntities(w.docId, ["Priya", "Send checklist", "Launch in Pune"].map(w.fields), NOW.toISOString());
    assert.equal(out.staled, 0);
  });
});

interface Call { rpc?: string; args?: Record<string, unknown> }
function stub(results: Record<string, unknown>) {
  const calls: Call[] = [];
  const db = {
    rpc(name: string, args?: Record<string, unknown>) {
      calls.push({ rpc: name, args });
      const b: unknown = new Proxy({}, { get(_t, prop: string) { return prop === "then" ? (ok: (v: unknown) => void) => ok({ data: results[name] ?? null, error: null }) : () => b; } });
      return b;
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}
const FIELDS: EntityFields = { entity_type: "task", name: "Send checklist", description: "d", evidence: ["S2"], basis: "explicit", confidence: "high", owner: null, team: null, due: null, unknowns: [] };

describe("the Supabase adapter never calls org_memory_stale_missing for an empty or missing list", () => {
  it("empty list: no RPC at all, zero counts", async () => {
    const s = stub({ org_memory_upsert_entity: "unchanged", org_memory_stale_missing: 5 });
    const { writer } = createSupabaseOrgMemory(s.db, ADMIN);
    assert.deepEqual(await writer.upsertEntities("d1", [], "t"), { created: 0, updated: 0, staled: 0, unchanged: 0 });
    assert.equal(s.calls.length, 0);
  });
  it("null list (a caller that passes nothing): treated as empty, no RPC", async () => {
    const s = stub({ org_memory_stale_missing: 5 });
    const { writer } = createSupabaseOrgMemory(s.db, ADMIN);
    // deliberately not type-correct: the point is that a missing list cannot reach the database function that would stale everything
    assert.deepEqual(await writer.upsertEntities("d1", null as unknown as EntityFields[], "t"), { created: 0, updated: 0, staled: 0, unchanged: 0 });
    assert.equal(s.calls.length, 0);
  });
  it("non-empty list: upsert per entity, then stale_missing with exactly the kept ids; its count is reported", async () => {
    const s = stub({ org_memory_upsert_entity: "created", org_memory_stale_missing: 2 });
    const { writer } = createSupabaseOrgMemory(s.db, ADMIN);
    const out = await writer.upsertEntities("d1", [FIELDS, { ...FIELDS }], "t"); // the same entity twice counts once
    assert.deepEqual(s.calls.map((c) => c.rpc), ["org_memory_upsert_entity", "org_memory_stale_missing"]);
    assert.equal((s.calls[1]!.args!.p_keep as string[]).length, 1);
    assert.deepEqual(out, { created: 1, updated: 0, staled: 2, unchanged: 0 });
  });
  it("non-empty list but truncated (reconcile false): upsert only, no stale_missing", async () => {
    const s = stub({ org_memory_upsert_entity: "created", org_memory_stale_missing: 2 });
    const { writer } = createSupabaseOrgMemory(s.db, ADMIN);
    await writer.upsertEntities("d1", [FIELDS], "t", { reconcile: false });
    assert.deepEqual(s.calls.map((c) => c.rpc), ["org_memory_upsert_entity"]);
  });
  it("the relationship-side safeguard is unchanged: empty list calls nothing, non-empty reconciles", async () => {
    const s = stub({ org_relationship_upsert: "created", org_relationship_stale_missing: 1 });
    const { writer } = createSupabaseOrgMemory(s.db, ADMIN);
    assert.deepEqual(await writer.upsertRelationships("d1", [], "t"), { created: 0, updated: 0, staled: 0, unchanged: 0, skipped: 0 });
    assert.equal(s.calls.length, 0);
    await writer.upsertRelationships("d1", [{ relation_type: "ASSIGNED_TO", from_entity_id: "e1", to_entity_id: "e2", evidence: ["S2"], basis: "explicit", confidence: "high" }], "t");
    assert.deepEqual(s.calls.map((c) => c.rpc), ["org_relationship_upsert", "org_relationship_stale_missing"]);
  });
});
