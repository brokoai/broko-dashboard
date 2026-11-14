import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { NotionConnector } from "../src/lib/ai-brain/assistant";
import { unavailableConnectors } from "../src/lib/ai-brain/assistant";
import type { MeetingCandidate, MeetingDocument } from "../src/lib/ai-brain/assistant/meetings/types";
import { ENTITY_TYPES, createMemoryOrgStore, proposeToKnowledge, runIngestion, type Extractor } from "../src/lib/ai-brain/org-memory";
import { KIND, ORG_SCOPE_KINDS } from "../src/lib/ai-brain/org-memory/promote";
import { knowledgeInputSchema } from "../src/lib/knowledge/schemas";
import { createMemoryKnowledgeRepo, emptyKnowledgeStore } from "../src/lib/knowledge/memory-repo";
import type { KnowledgeRepo } from "../src/lib/knowledge/repo";
import { KNOWLEDGE_KINDS, type KnowledgeInput } from "../src/lib/knowledge/types";
import { NOW, admin } from "./ai-chat-helpers";

/**
 * Regression for the promotion mapping. Before the fix every entity type other than decision/commitment was promoted as kind "project_note" at
 * ORGANIZATION scope, which migration 0009 forbids (constraint knowledge_project_note_needs_project, SQLSTATE 23514). The in-memory Knowledge repository
 * does not enforce database constraints, so the defect was invisible to the earlier tests. These tests read the constraints from the migration itself.
 */
const SQL = readFileSync(new URL("../supabase/proposed/0009_knowledge.proposed.sql", import.meta.url), "utf8");

/** Kinds the database allows at organization scope for a MANUAL submission (source_type 'manual'), derived from the migration text, not copied. */
function orgScopeKindsFromMigration(): string[] {
  const list = /kind text not null check \(kind in \(([^)]*)\)\)/.exec(SQL);
  assert.ok(list, "the kind check constraint is in migration 0009");
  const kinds = [...list![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  assert.match(SQL, /knowledge_project_note_needs_project check \(kind <> 'project_note' or scope = 'project'\)/);
  assert.match(SQL, /knowledge_source_matches_kind check \(\(kind = 'correction'\) = \(source_type = 'correction'\)\)/);
  return kinds.filter((k) => k !== "project_note" && k !== "correction"); // project_note needs project scope; correction needs source_type 'correction'
}

/** A Knowledge repository that applies the same rules as the database before it stores anything (the code's own input schema plus the SQL constraints). */
function constraintEnforcing(inner: KnowledgeRepo): KnowledgeRepo {
  const allowed = new Set(orgScopeKindsFromMigration());
  return {
    ...inner,
    async submit(input: KnowledgeInput) {
      if (input.scope === "organization" && !allowed.has(input.kind)) throw new Error("23514 check constraint violated");
      if (!knowledgeInputSchema.safeParse(input).success) throw new Error("input schema refused");
      return inner.submit(input);
    },
  };
}

const LINES = ["Priya will send the checklist by Friday.", "Decision: launch the marketplace in Pune first.", "Vendor onboarding may slip."];
function notion(): NotionConnector {
  return {
    ...unavailableConnectors().notion,
    async findMeetingCandidates() { return { ok: true, data: [{ system: "notion", record_id: "p1", title: "Weekly sync", url: "https://www.notion.so/p1", last_edited: "2026-10-20T10:00:00.000Z", date_only: false, date_source: "none", retrieved_at: NOW.toISOString() } as MeetingCandidate] }; },
    async readMeetingDocument(id) {
      const segments = ["Weekly sync", ...LINES].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? ("title" as const) : ("text" as const), text: t, depth: 0 }));
      return { ok: true, data: { system: "notion", record_id: id, title: "Weekly sync", url: "https://www.notion.so/p1", last_edited: "2026-10-20T10:00:00.000Z", date_only: false, date_source: "none", retrieved_at: NOW.toISOString(), segments, coverage: { complete: true, gaps: [], blocks_read: 4 } } as MeetingDocument };
    },
  };
}
const ENTITIES = [
  { entity_type: "task", name: "Send checklist", description: "Priya sends the checklist.", evidence: ["S2"], basis: "explicit", confidence: "high", owner: "Priya", due: "Friday" },
  { entity_type: "decision", name: "Launch in Pune", description: "Launch the marketplace in Pune first.", evidence: ["S3"], basis: "explicit", confidence: "high" },
  { entity_type: "risk", name: "Vendor onboarding slip", description: "Vendor onboarding may slip.", evidence: ["S4"], basis: "extracted", confidence: "medium" },
];
const extractor: Extractor = { async extract() { return { ok: true, raw: ENTITIES, truncated: false }; } };

describe("promotion kind mapping honours the organization-scope database constraints", () => {
  it("the kinds the mapping may produce are exactly what migration 0009 allows at organization scope", () => {
    assert.deepEqual([...ORG_SCOPE_KINDS].sort(), orgScopeKindsFromMigration().sort());
    assert.ok(ORG_SCOPE_KINDS.every((k) => (KNOWLEDGE_KINDS as readonly string[]).includes(k)));
  });
  it("every entity type maps to a permitted kind, and the resulting input passes the Knowledge input schema at organization scope", () => {
    const allowed = new Set(orgScopeKindsFromMigration());
    for (const t of ENTITY_TYPES) {
      const kind = KIND[t];
      assert.ok(allowed.has(kind), `${t} -> ${kind} must be allowed at organization scope`);
      const parsed = knowledgeInputSchema.safeParse({ kind, scope: "organization", project_id: null, title: "Send checklist", body: "Priya sends the checklist. Basis: explicit.", topic: null, source_ref: "Notion: Weekly sync", supersedes_id: null, expires_on: null });
      assert.equal(parsed.success, true, `${t}`);
    }
    assert.equal(KIND.decision, "decision");
    assert.equal(KIND.commitment, "decision");
  });
  it("the old mapping (project_note at organization scope) is refused by BOTH the schema and the migration rule: the guard this test exists for", () => {
    assert.equal(knowledgeInputSchema.safeParse({ kind: "project_note", scope: "organization", project_id: null, title: "Send checklist", body: "Priya sends the checklist.", topic: null, source_ref: null, supersedes_id: null, expires_on: null }).success, false);
    assert.equal(orgScopeKindsFromMigration().includes("project_note"), false);
  });
  it("a reviewed TASK and a reviewed RISK are promoted through a repository that enforces the constraints: PROPOSED, kind procedure, never approved", async () => {
    const store = createMemoryOrgStore(() => NOW);
    await runIngestion({ notion: notion(), writer: store.writer, extractor }, { workspaceId: "ws-1", now: () => NOW });
    const reader = store.readerFor(admin);
    const kstore = emptyKnowledgeStore();
    const knowledge = constraintEnforcing(createMemoryKnowledgeRepo({ user: admin, store: kstore, writable: true, projectIds: async () => new Set(), now: () => NOW }));
    for (const name of ["Send checklist", "Vendor onboarding slip", "Launch in Pune"]) {
      const e = store.snapshot().entities.find((x) => x.name === name)!;
      await reader.review(e.id, "approve", null);
      const out = await proposeToKnowledge({ reader, knowledge }, e.id);
      assert.equal(out.ok, true, `${name} must be promotable`);
      assert.equal((await reader.getEntity(e.id))!.review_status, "promotion_proposed");
    }
    assert.deepEqual(kstore.items.map((i) => [i.kind, i.scope, i.status]).sort(), [["decision", "organization", "proposed"], ["procedure", "organization", "proposed"], ["procedure", "organization", "proposed"]]);
    assert.equal((await knowledge.listCurrent()).length, 0, "nothing is current until an administrator approves it");
  });
  it("the enforcing repository really does reject the old mapping (so the test above cannot pass vacuously)", async () => {
    const knowledge = constraintEnforcing(createMemoryKnowledgeRepo({ user: admin, store: emptyKnowledgeStore(), writable: true, projectIds: async () => new Set(), now: () => NOW }));
    await assert.rejects(knowledge.submit({ kind: "project_note", scope: "organization", project_id: null, title: "Send checklist", body: "Priya sends the checklist.", topic: null, source_ref: null, supersedes_id: null, expires_on: null }), /23514/);
  });
});
