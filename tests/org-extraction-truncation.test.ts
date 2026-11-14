import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unavailableConnectors } from "../src/lib/ai-brain/assistant";
import type { NotionConnector } from "../src/lib/ai-brain/assistant";
import type { MeetingCandidate, MeetingDocument } from "../src/lib/ai-brain/assistant/meetings/types";
import { createMemoryOrgStore, entityRefs, runIngestion, type Extractor, type RelationshipExtractor } from "../src/lib/ai-brain/org-memory";
import { NOW, admin } from "./ai-chat-helpers";

/**
 * E1 regression (local only): when the model saw only PART of a document (the extractor reports truncated), an incomplete extraction must not mark the
 * records or links it did not mention as stale. Reviewed records and pending revisions stay as they are. Non-truncated runs still reconcile.
 */

const TITLE = "Weekly sync";
const LINES = ["Priya will send the checklist by Friday.", "Decision: launch the marketplace in Pune first.", "Vendor onboarding may slip."];
function notion(lines: string[], edited: string): NotionConnector {
  return {
    ...unavailableConnectors().notion,
    async findMeetingCandidates() { return { ok: true, data: [{ system: "notion", record_id: "p1", title: TITLE, url: "https://www.notion.so/p1", last_edited: edited, date_only: false, date_source: "none", retrieved_at: NOW.toISOString() } as MeetingCandidate] }; },
    async readMeetingDocument(id) {
      const segments = [TITLE, ...lines].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? ("title" as const) : ("text" as const), text: t, depth: 0 }));
      return { ok: true, data: { system: "notion", record_id: id, title: TITLE, url: "https://www.notion.so/p1", last_edited: edited, date_only: false, date_source: "none", retrieved_at: NOW.toISOString(), segments, coverage: { complete: true, gaps: [], blocks_read: segments.length } } as MeetingDocument };
    },
  };
}

const E = (entity_type: string, name: string, evidence: string, extra: Record<string, unknown> = {}) =>
  ({ entity_type, name, description: `${name} is stated in the notes.`, evidence: [evidence], basis: "explicit", confidence: "high", ...extra });
const ALL = [E("person", "Priya", "S2"), E("task", "Send checklist", "S2", { owner: "Priya", due: "Friday" }), E("decision", "Launch in Pune", "S3"), E("risk", "Vendor onboarding slip", "S4")];
const HEAD = [ALL[0]!, ALL[1]!]; // what a model that only saw the first part of the page would return
const entityExtractor = (raw: unknown[], truncated: boolean): Extractor => ({ async extract() { return { ok: true, raw, truncated }; } });

type Link = { from: string; to: string; relation_type: string; evidence: string[]; basis: string; confidence: string };
const ASSIGNED: Link = { from: "Send checklist", to: "Priya", relation_type: "ASSIGNED_TO", evidence: ["S2"], basis: "explicit", confidence: "high" };
const RELATED: Link = { from: "Launch in Pune", to: "Vendor onboarding slip", relation_type: "RELATES_TO", evidence: ["S3", "S4"], basis: "inferred", confidence: "medium" };
const relExtractor = (links: Link[], truncated: boolean): RelationshipExtractor => ({
  async extract(_d, entities) {
    const refs = entityRefs(entities);
    const ref = (n: string) => [...refs].find(([, e]) => e.name === n)?.[0] ?? "E999";
    return { ok: true, raw: links.map((l) => ({ ...l, from: ref(l.from), to: ref(l.to) })), truncated };
  },
});

/** Run 1: a complete extraction. Run 2: the page was edited (so it is extracted again) and the extractor returns `second`. */
async function twoRuns(opts: { entities2: unknown[]; entityTruncated: boolean; links2: Link[]; relTruncated: boolean }) {
  const store = createMemoryOrgStore(() => NOW);
  const deps1 = { notion: notion(LINES, "2026-10-20T10:00:00.000Z"), writer: store.writer, extractor: entityExtractor(ALL, false), relationshipExtractor: relExtractor([ASSIGNED, RELATED], false) };
  const first = await runIngestion(deps1, { workspaceId: "ws-1", now: () => NOW });
  const reader = store.readerFor(admin);
  const byName = (n: string) => store.snapshot().entities.find((e) => e.name === n)!;
  const rel = (t: string) => store.snapshot().relationships.find((r) => r.relation_type === t)!;
  // a human reviews one entity and one link before the page changes
  await reader.review(byName("Send checklist").id, "approve", null);
  await reader.reviewRelationship(rel("ASSIGNED_TO").id, "approve", "confirmed");
  const edited = [LINES[0] + " (edited)", ...LINES.slice(1)];
  const second = await runIngestion(
    { notion: notion(edited, "2026-10-21T10:00:00.000Z"), writer: store.writer, extractor: entityExtractor(opts.entities2, opts.entityTruncated), relationshipExtractor: relExtractor(opts.links2, opts.relTruncated) },
    { workspaceId: "ws-1", now: () => NOW },
  );
  return { store, first, second, byName, rel };
}

describe("a truncated extraction never marks the records it did not mention as stale (entities)", () => {
  it("truncated: stores what was found, marks nothing stale, keeps the reviewed record, counts the skip", async () => {
    const w = await twoRuns({ entities2: HEAD, entityTruncated: true, links2: [ASSIGNED], relTruncated: false });
    assert.equal(w.first.reconcile_skipped_truncated, 0);
    assert.equal(w.second.entities_staled, 0, "no entity went stale");
    assert.equal(w.byName("Launch in Pune").stale, false);
    assert.equal(w.byName("Vendor onboarding slip").stale, false);
    assert.equal(w.byName("Send checklist").review_status, "reviewed", "the reviewed record is intact");
    assert.equal(w.byName("Send checklist").stale, false);
    assert.equal(w.second.reconcile_skipped_truncated, 1);
    assert.equal(w.second.extracted_docs, 1, "the document is still marked extracted: the run is not retried forever");
  });
  it("truncated: a changed REVIEWED record still waits as a pending revision (new evidence is still processed)", async () => {
    const changed = [HEAD[0]!, E("task", "Send checklist", "S2", { owner: "Priya", due: "Monday" })];
    const w = await twoRuns({ entities2: changed, entityTruncated: true, links2: [ASSIGNED], relTruncated: false });
    const t = w.byName("Send checklist");
    assert.equal(t.review_status, "reviewed");
    assert.equal(t.stale, true, "stale because its own revision is waiting, not because it was missing");
    assert.ok(t.pending_revision, "the new extraction parked as a revision");
    assert.equal(t.due, "Friday", "the reviewed value was not overwritten");
    assert.equal(w.byName("Launch in Pune").stale, false, "unmentioned records are untouched");
  });
  it("truncated: a NEW record found in the visible part is still stored (as proposed)", async () => {
    const plus = [...HEAD, E("risk", "Second risk", "S4")];
    const w = await twoRuns({ entities2: plus, entityTruncated: true, links2: [ASSIGNED], relTruncated: false });
    assert.equal(w.second.entities_created, 1);
    assert.equal(w.byName("Second risk").review_status, "proposed");
  });
  it("NOT truncated (control): the same partial answer DOES mark the unmentioned records stale, and the reviewed one is untouched", async () => {
    const w = await twoRuns({ entities2: HEAD, entityTruncated: false, links2: [ASSIGNED], relTruncated: false });
    assert.equal(w.second.entities_staled, 2);
    assert.equal(w.byName("Launch in Pune").stale, true);
    assert.equal(w.byName("Vendor onboarding slip").stale, true);
    assert.equal(w.byName("Send checklist").review_status, "reviewed");
    assert.equal(w.second.reconcile_skipped_truncated, 0);
  });
});

describe("a truncated extraction never marks the links it did not mention as stale (relationships)", () => {
  it("truncated: the unmentioned link and the reviewed link stay current; the skip is counted", async () => {
    const w = await twoRuns({ entities2: ALL, entityTruncated: false, links2: [ASSIGNED], relTruncated: true });
    assert.equal(w.second.relationships_staled, 0);
    assert.equal(w.rel("RELATES_TO").stale, false, "the link the model did not mention is not stale");
    assert.equal(w.rel("ASSIGNED_TO").review_status, "reviewed");
    assert.equal(w.rel("ASSIGNED_TO").stale, false);
    assert.equal(w.second.reconcile_skipped_truncated, 1);
  });
  it("truncated: a reviewed link whose own extraction changed still waits as a pending revision, and a new link is still stored", async () => {
    const changed: Link = { ...ASSIGNED, basis: "extracted", confidence: "medium" };
    const fresh: Link = { from: "Send checklist", to: "Launch in Pune", relation_type: "RELATES_TO", evidence: ["S2", "S3"], basis: "inferred", confidence: "low" };
    const w = await twoRuns({ entities2: ALL, entityTruncated: false, links2: [changed, fresh], relTruncated: true });
    const r = w.rel("ASSIGNED_TO");
    assert.equal(r.review_status, "reviewed");
    assert.equal(r.basis, "explicit", "the reviewed value was not overwritten");
    assert.ok(r.pending_revision && r.stale);
    assert.equal(w.store.snapshot().relationships.filter((x) => x.relation_type === "RELATES_TO").length, 2, "the new link was stored");
  });
  it("NOT truncated (control): the same partial answer DOES mark the unmentioned link stale", async () => {
    const w = await twoRuns({ entities2: ALL, entityTruncated: false, links2: [ASSIGNED], relTruncated: false });
    assert.equal(w.second.relationships_staled, 1);
    assert.equal(w.rel("RELATES_TO").stale, true);
    assert.equal(w.rel("ASSIGNED_TO").stale, false);
    assert.equal(w.second.reconcile_skipped_truncated, 0);
  });
  it("one skip is counted once per document even when both extractors were truncated", async () => {
    const w = await twoRuns({ entities2: HEAD, entityTruncated: true, links2: [ASSIGNED], relTruncated: true });
    assert.equal(w.second.reconcile_skipped_truncated, 1);
    assert.equal(w.second.entities_staled + w.second.relationships_staled, 0);
  });
});

describe("the Supabase adapter skips the stale-missing RPCs when told not to reconcile", () => {
  it("source: both adapter reconcile calls are guarded by opts.reconcile", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/lib/backend/supabase/org-memory.ts", import.meta.url), "utf8");
    assert.match(src, /if \(keep\.length > 0 && opts\?\.reconcile !== false\) \{\s*const missing = check\(await db\.rpc\("org_memory_stale_missing"/);
    assert.match(src, /keep\.length > 0 && opts\?\.reconcile !== false/);
  });
});
