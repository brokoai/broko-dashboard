import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unavailableConnectors } from "../src/lib/ai-brain/assistant";
import type { NotionConnector } from "../src/lib/ai-brain/assistant";
import { createMemoryOrgStore, runIngestion, type Extractor } from "../src/lib/ai-brain/org-memory";
import { queryTokens, rankByHits, searchWords, tokenHits } from "../src/lib/ai-brain/org-memory/query";
import { createSupabaseOrgMemory } from "../src/lib/backend/supabase/org-memory";
import { NOW, admin } from "./ai-chat-helpers";
import { ADMIN } from "./precon-helpers";

/**
 * K1/K2 regression (local only): the memory search matches the query WORD BY WORD (ranked by matched words, capped by the limit), so a question-shaped query
 * ("Halcyon warehouse slot") finds the record "Confirm warehouse slot". Nothing else changes: only already-permitted rows are ranked, evidence rules apply.
 */

describe("queryTokens / searchWords / rankByHits", () => {
  it("drops stop words and short words, lower-cases, de-duplicates, caps at 6", () => {
    assert.deepEqual(queryTokens("What do the stored notes say about Halcyon warehouse slot?"), ["halcyon", "warehouse", "slot"]);
    assert.deepEqual(queryTokens("Halcyon halcyon HALCYON"), ["halcyon"]);
    assert.equal(queryTokens("alpha bravo charlie delta echo foxtrot golf hotel").length, 6);
  });
  it("falls back to the whole cleaned phrase when no token survives, and to nothing without a query", () => {
    assert.deepEqual(searchWords("AI"), ["ai"]);
    assert.deepEqual(searchWords("the and"), ["the and"]);
    assert.deepEqual(searchWords(undefined), []);
    assert.deepEqual(searchWords("   "), []);
  });
  it("counts matched words and ranks two-word matches before one-word matches, stable otherwise", () => {
    const rows = ["slot only", "warehouse slot", "nothing", "slot again"];
    const words = ["warehouse", "slot"];
    assert.equal(tokenHits(words, "Warehouse SLOT"), 2);
    assert.deepEqual(rankByHits(rows, words, (r) => r), ["warehouse slot", "slot only", "slot again", "nothing"]);
    assert.deepEqual(rankByHits(rows, ["slot"], (r) => r), rows, "a single word keeps the incoming order");
  });
});

const TITLE = "Ops sync";
const LINES = ["Dana confirms the warehouse slot.", "Priya will send the checklist by Friday."];
function notion(): NotionConnector {
  return {
    ...unavailableConnectors().notion,
    async findMeetingCandidates() { return { ok: true, data: [{ system: "notion", record_id: "p1", title: TITLE, url: "https://www.notion.so/p1", last_edited: "2026-10-20T10:00:00.000Z", date_only: false, date_source: "none" }] } as never; },
    async readMeetingDocument(id) {
      const segments = [TITLE, ...LINES].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? ("title" as const) : ("text" as const), text: t, depth: 0 }));
      return { ok: true, data: { system: "notion", record_id: id, title: TITLE, url: "https://www.notion.so/p1", last_edited: "2026-10-20T10:00:00.000Z", date_only: false, date_source: "none", segments } } as never;
    },
  };
}
const extractor: Extractor = {
  async extract() {
    return { ok: true, truncated: false, raw: [
      { entity_type: "task", name: "Confirm warehouse slot", description: "Dana confirms the warehouse slot.", owner: "Dana", team: "Operations", evidence: ["S2"], basis: "explicit", confidence: "high" },
      { entity_type: "task", name: "Send checklist", description: "Priya will send the checklist by Friday.", owner: "Priya", evidence: ["S3"], basis: "explicit", confidence: "high" },
    ] };
  },
};

async function seeded() {
  const store = createMemoryOrgStore(() => NOW);
  await runIngestion({ notion: notion(), writer: store.writer, extractor }, { workspaceId: "ws-1", now: () => NOW });
  return store.readerFor(admin);
}
const names = async (query: string | undefined, limit = 10) => (await (await seeded()).findEntities({ query, limit })).map((e) => e.name);

describe("in-memory twin: question-shaped queries find the record (K1/K2)", () => {
  it("K1/K2 phrasings recall 'Confirm warehouse slot'", async () => {
    for (const q of ["Halcyon warehouse slot", "stored notes Halcyon warehouse slot", "warehouse slot", "Dana"]) {
      assert.ok((await names(q)).includes("Confirm warehouse slot"), q);
    }
  });
  it("a query with no matching word returns nothing (budget), and no query lists everything", async () => {
    assert.deepEqual(await names("budget"), []);
    assert.equal((await names(undefined)).length, 2);
  });
  it("existing task-query behaviour: 'checklist' still finds only the checklist task", async () => {
    assert.deepEqual(await names("who sends the checklist"), ["Send checklist"]);
  });
  it("ranking: the two-word match comes first and the limit cuts after ranking", async () => {
    const r = await seeded();
    const found = await r.findEntities({ query: "checklist warehouse slot", limit: 1 });
    assert.deepEqual(found.map((e) => e.name), ["Confirm warehouse slot"]);
  });
});

function stub(rows: unknown[]) {
  const ors: string[] = []; const limits: number[] = [];
  const db = {
    from() {
      const b: unknown = new Proxy({}, { get(_t, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => void) => ok({ data: rows, error: null });
        return (...a: unknown[]) => { if (prop === "or") ors.push(String(a[0])); if (prop === "limit") limits.push(Number(a[0])); return b; };
      } });
      return b;
    },
  } as unknown as SupabaseClient;
  return { db, ors, limits };
}
const ROW = (name: string, description: string) => ({ id: name, name, description, owner: null, team: null, entity_type: "task", review_status: "proposed", stale: false, evidence: ["S2"], basis: "explicit", confidence: "high", extracted_at: "2026-10-20T10:00:00Z", source_doc_id: "d1", stable_id: name, unknowns: [], due: null, source_doc: { archived: false } });

describe("Supabase adapter: OR filter shape and ranking", () => {
  it("builds one OR over every word and column, fetches wide, ranks, then cuts to the limit", async () => {
    const s = stub([ROW("One word slot", "x"), ROW("Confirm warehouse slot", "y")]);
    const { reader } = createSupabaseOrgMemory(s.db, ADMIN) as unknown as { reader: { findEntities(q: { query: string; limit: number }): Promise<{ name: string }[]> } };
    const out = await reader.findEntities({ query: "Halcyon warehouse slot", limit: 1 });
    const filter = s.ors.find((o) => o.includes("ilike"))!;
    for (const w of ["halcyon", "warehouse", "slot"]) for (const c of ["name", "description", "owner", "team"]) assert.ok(filter.includes(`${c}.ilike."%${w}%"`), `${c}/${w}`);
    assert.deepEqual(out.map((e) => e.name), ["Confirm warehouse slot"]);
  });
  it("a single word keeps the single ilike and the caller's limit", async () => {
    const s = stub([]);
    const { reader } = createSupabaseOrgMemory(s.db, ADMIN) as unknown as { reader: { findEntities(q: { query: string; limit: number }): Promise<unknown[]> } };
    await reader.findEntities({ query: "budget", limit: 3 });
    assert.equal(s.ors.filter((o) => o.includes("ilike")).length, 1);
    assert.ok(s.limits.includes(3));
  });
});
