import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { createMemoryKnowledgeRepo, emptyKnowledgeStore, type KnowledgeStore } from "../src/lib/knowledge/memory-repo";
import { REPLACEMENT_MISMATCH, describeReplacement, sameReplacementScope } from "../src/lib/knowledge/policy";
import type { KnowledgeRepo } from "../src/lib/knowledge/repo";
import { reviewKnowledge, submitKnowledge, type KnowledgeContext } from "../src/lib/knowledge/service";
import type { KnowledgeInput, KnowledgeItem } from "../src/lib/knowledge/types";
import type { ProjectInput } from "../src/lib/precon/types";
import { ADMIN, MEMBER, MEMBER2, world } from "./precon-helpers";

// Replacement of an approved item: which item is replaced is shown to the reviewer, and a replacement may only retire an item of the
// same scope, project and topic. The database enforces the same rule in the DRAFT migration 0011 (checked by 0011_knowledge_guards.pglite.mjs).

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url));
const text = (p: string) => read(p).toString("utf8");
const PROJECT: ProjectInput = { name: "Harbour", developer: null, city: null, address: null, status: "selling", description: null, expected_completion: null };
const input = (over: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
  kind: "procedure", scope: "organization", project_id: null, title: "Refund approvals", body: "Refunds over 500 dollars need a second approver before payment.",
  topic: "refunds", source_ref: null, supersedes_id: null, expires_on: null, ...over,
});

function setup() {
  const w = world();
  const store: KnowledgeStore = emptyKnowledgeStore();
  const now = new Date("2026-10-26T12:00:00Z");
  const knowledgeFor = (user = ADMIN): KnowledgeRepo =>
    createMemoryKnowledgeRepo({ user, store, writable: true, now: () => now, projectIds: async () => new Set((await w.repoFor(user).listProjects()).map((p) => p.id)) });
  const kctx = (user = ADMIN): KnowledgeContext => ({ user, repo: knowledgeFor(user), precon: w.repoFor(user), now: () => now, log: () => undefined });
  const approve = async (raw: Partial<KnowledgeInput> = {}) => reviewKnowledge(kctx(ADMIN), { id: (await submitKnowledge(kctx(MEMBER), input(raw))).id, action: "approve", note: "ok" });
  return { w, store, kctx, knowledgeFor, approve, now };
}

const item = (over: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
  id: "i1", kind: "procedure", scope: "organization", project_id: null, title: "New rule", body: "A body that is long enough.", topic: null, status: "proposed",
  author_id: "u1", author_name: "Mo", source_type: "manual", source_ref: null, supersedes_id: "old", effective_from: "2026-01-01T00:00:00Z", expires_at: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", reviewed_by: null, reviewer_name: null, reviewed_at: null, review_note: null, ...over,
});
const target = (over: Partial<KnowledgeItem> = {}): KnowledgeItem => item({ id: "old", title: "Old rule", status: "approved", supersedes_id: null, ...over });

describe("describeReplacement: what the review card says", () => {
  it("says nothing when the item replaces nothing", () => {
    assert.deepEqual(describeReplacement(item({ supersedes_id: null }), null), { kind: "none" });
  });
  it("a proposal that will retire an approved item of the same scope names it", () => {
    assert.deepEqual(describeReplacement(item(), target()), { kind: "will_replace", title: "Old rule" });
    assert.deepEqual(describeReplacement(item({ scope: "project", project_id: "p1" }), target({ scope: "project", project_id: "p1" })), { kind: "will_replace", title: "Old rule" });
  });
  it("a different scope or a different project is flagged as one that cannot be approved", () => {
    assert.deepEqual(describeReplacement(item({ scope: "project", project_id: "p1" }), target()), { kind: "mismatch", title: "Old rule" });
    assert.deepEqual(describeReplacement(item(), target({ scope: "project", project_id: "p1" })), { kind: "mismatch", title: "Old rule" });
    assert.deepEqual(describeReplacement(item({ scope: "project", project_id: "p2" }), target({ scope: "project", project_id: "p1" })), { kind: "mismatch", title: "Old rule" });
  });
  it("a target that is no longer approved is reported, and approving will not touch it", () => {
    for (const status of ["superseded", "expired", "rejected", "proposed"] as const) assert.deepEqual(describeReplacement(item(), target({ status })), { kind: "inactive", title: "Old rule", status });
  });
  it("a target that could not be loaded is reported, never silently ignored", () => {
    assert.deepEqual(describeReplacement(item(), null), { kind: "unavailable" });
    assert.deepEqual(describeReplacement(item(), undefined), { kind: "unavailable" });
  });
  it("an item that is no longer proposed shows the link as plain history", () => {
    for (const status of ["approved", "rejected", "superseded", "expired"] as const) assert.deepEqual(describeReplacement(item({ status }), target()), { kind: "history", title: "Old rule" });
  });
  it("scope matching treats a missing project like null", () => {
    assert.ok(sameReplacementScope({ scope: "organization", project_id: null }, { scope: "organization", project_id: undefined as unknown as null }));
    assert.ok(!sameReplacementScope({ scope: "project", project_id: "a" }, { scope: "project", project_id: "b" }));
  });
});

const HELPER = new URL("./knowledge-render-helper.tsx", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
/** Renders the card in a child process (react-dom/server cannot load under the react-server condition the suite runs with). */
function renderCard(it: KnowledgeItem, replacement?: ReturnType<typeof describeReplacement>): string {
  const env = { ...process.env, NODE_OPTIONS: "" };
  return (JSON.parse(execFileSync(process.execPath, ["--import", "tsx", HELPER], { input: JSON.stringify([{ item: it, replacement }]), env, encoding: "utf8" })) as string[])[0];
}

describe("ItemCard: the replaced item is visible to the reviewer", () => {
  const html = (replacement: Parameters<typeof describeReplacement>[1], over: Partial<KnowledgeItem> = {}) => renderCard(item(over), describeReplacement(item(over), replacement));

  it("shows the title and what approving does", () => {
    const out = html(target());
    assert.match(out, /Replaces the approved item/);
    assert.match(out, /Old rule/);
    assert.match(out, /marked superseded/);
  });
  it("shows a clear warning when the replacement cannot be approved", () => {
    const out = html(target({ scope: "project", project_id: "p1" }));
    assert.match(out, /different scope, project or topic/);
    assert.match(out, /cannot be approved/);
  });
  it("shows when the target is already gone, or could not be loaded", () => {
    assert.match(html(target({ status: "superseded" })), /no longer approved \(superseded\)/);
    assert.match(html(null), /could not be loaded/);
  });
  it("shows nothing extra for an item that replaces nothing", () => {
    assert.ok(!/Replaces|replace/.test(renderCard(item({ supersedes_id: null }))));
  });
  it("renders the older item's title as text, never as markup", () => {
    const out = html(target({ title: "<img src=x onerror=alert(1)>" }));
    assert.ok(!out.includes("<img"));
    assert.match(out, /&lt;img/);
  });
});

describe("page wiring: every card that can show a replacement is given one", () => {
  const PAGE = text("src/app/(app)/knowledge/page.tsx");
  it("resolves titles from what is loaded, fetches the rest, and passes the result to all four lists", () => {
    assert.match(PAGE, /describeReplacement\(i, /);
    assert.match(PAGE, /repo\.getItem\(id\)/);
    assert.equal((PAGE.match(/replacement=\{replacementOf\(i\)\}/g) ?? []).length, 4);
  });
});

describe("a replacement must match the scope, project and topic of the item it replaces (app layer; mirrors 0011)", () => {
  it("submitting: an organization item cannot be replaced from a project, and a project item not from another project", async () => {
    const { w, kctx, approve } = setup();
    const projectA = await w.repoFor(ADMIN).createProject(PROJECT);
    const projectB = await w.repoFor(ADMIN).createProject({ ...PROJECT, name: "Marina" });
    const org = await approve({ title: "Company rule" });
    const noteA = await approve({ kind: "project_note", scope: "project", project_id: projectA.id, title: "Harbour parking", topic: "parking" });
    const project = (id: string, project_id: string) => input({ kind: "project_note", scope: "project", project_id, supersedes_id: id, title: "Replacement", topic: "parking" });

    await assert.rejects(submitKnowledge(kctx(MEMBER2), project(org.id, projectA.id)), new RegExp(REPLACEMENT_MISMATCH));
    await assert.rejects(submitKnowledge(kctx(MEMBER2), project(noteA.id, projectB.id)), new RegExp(REPLACEMENT_MISMATCH));
    await assert.rejects(submitKnowledge(kctx(MEMBER2), input({ supersedes_id: noteA.id, title: "Org over project" })), new RegExp(REPLACEMENT_MISMATCH));
    const ok = await submitKnowledge(kctx(MEMBER2), project(noteA.id, projectA.id));
    assert.equal(ok.supersedes_id, noteA.id);
    assert.equal((await submitKnowledge(kctx(MEMBER2), input({ supersedes_id: org.id, title: "Company rule v2" }))).supersedes_id, org.id);
  });

  it("approving: a mismatched row is refused by the service AND by the repository, and nothing changes", async () => {
    const { w, store, kctx, knowledgeFor, approve } = setup();
    const project = await w.repoFor(ADMIN).createProject(PROJECT);
    const org = await approve({ title: "Company rule" });
    const proposal = await submitKnowledge(kctx(MEMBER2), input({ supersedes_id: org.id, title: "Company rule v2" }));
    // Simulates a row that got past the submit checks (the database test does the same with an owner insert).
    const row = store.items.find((i) => i.id === proposal.id)!;
    row.scope = "project"; row.project_id = project.id; row.kind = "decision";
    const eventsBefore = store.events.length;

    await assert.rejects(reviewKnowledge(kctx(ADMIN), { id: proposal.id, action: "approve", note: null }), new RegExp(REPLACEMENT_MISMATCH));
    await assert.rejects(knowledgeFor(ADMIN).review(proposal.id, "approve", null), new RegExp(REPLACEMENT_MISMATCH));
    assert.equal(store.items.find((i) => i.id === org.id)!.status, "approved");
    assert.equal(row.status, "proposed");
    assert.equal(store.events.length, eventsBefore);
    assert.equal((await reviewKnowledge(kctx(ADMIN), { id: proposal.id, action: "reject", note: "Names an item of another scope" })).status, "rejected");
  });

  it("topic: a replacement must carry the same topic, compared null-safely, at submit and at approval", async () => {
    const { store, kctx, knowledgeFor, approve } = setup();
    const withTopic = await approve({ title: "Refund limits", topic: "refund-limits" });
    const plain = await approve({ title: "Office hours", topic: null });
    const rep = (id: string, topic: string | null) => input({ supersedes_id: id, title: "Replacement", topic });
    await assert.rejects(submitKnowledge(kctx(MEMBER2), rep(withTopic.id, "refund-process")), new RegExp(REPLACEMENT_MISMATCH));
    await assert.rejects(submitKnowledge(kctx(MEMBER2), rep(withTopic.id, null)), new RegExp(REPLACEMENT_MISMATCH));
    await assert.rejects(submitKnowledge(kctx(MEMBER2), rep(plain.id, "office-hours")), new RegExp(REPLACEMENT_MISMATCH));
    assert.equal((await submitKnowledge(kctx(MEMBER2), rep(plain.id, null))).supersedes_id, plain.id);
    const ok = await submitKnowledge(kctx(MEMBER2), rep(withTopic.id, "refund-limits"));
    // A row that got past the submit checks (the database test does the same with an owner insert) is refused at approval, and nothing changes.
    const sneaky = await submitKnowledge(kctx(MEMBER2), rep(withTopic.id, "refund-limits"));
    store.items.find((i) => i.id === sneaky.id)!.topic = "refund-process";
    const eventsBefore = store.events.length;
    await assert.rejects(reviewKnowledge(kctx(ADMIN), { id: sneaky.id, action: "approve", note: null }), new RegExp(REPLACEMENT_MISMATCH));
    await assert.rejects(knowledgeFor(ADMIN).review(sneaky.id, "approve", null), new RegExp(REPLACEMENT_MISMATCH));
    assert.equal(store.items.find((i) => i.id === withTopic.id)!.status, "approved");
    assert.equal(store.events.length, eventsBefore);
    await reviewKnowledge(kctx(ADMIN), { id: ok.id, action: "approve", note: null });
    assert.equal(store.items.find((i) => i.id === withTopic.id)!.status, "superseded");
  });
  it("sameReplacementScope and describeReplacement treat topic like scope and project", () => {
    assert.ok(sameReplacementScope({ scope: "organization", project_id: null, topic: null }, { scope: "organization", project_id: null, topic: undefined }));
    assert.ok(!sameReplacementScope({ scope: "organization", project_id: null, topic: "a" }, { scope: "organization", project_id: null, topic: "b" }));
    assert.ok(!sameReplacementScope({ scope: "organization", project_id: null, topic: "a" }, { scope: "organization", project_id: null, topic: null }));
    assert.deepEqual(describeReplacement(item({ topic: "a" }), target({ topic: "b" })), { kind: "mismatch", title: "Old rule" });
    assert.deepEqual(describeReplacement(item({ topic: "a" }), target({ topic: "a" })), { kind: "will_replace", title: "Old rule" });
  });

  it("approving a matching replacement still supersedes its target in the same step", async () => {
    const { kctx, store, approve } = setup();
    const org = await approve({ title: "Company rule" });
    const proposal = await submitKnowledge(kctx(MEMBER2), input({ supersedes_id: org.id, title: "Company rule v2" }));
    await reviewKnowledge(kctx(ADMIN), { id: proposal.id, action: "approve", note: "Updated" });
    assert.equal(store.items.find((i) => i.id === org.id)!.status, "superseded");
    assert.equal(store.items.find((i) => i.id === proposal.id)!.status, "approved");
  });
});

describe("draft migration 0011 (static guards; behaviour is in 0011_knowledge_guards.pglite.mjs)", () => {
  const SQL = text("supabase/proposed/0011_knowledge_guards.proposed.sql");
  const CODE = SQL.replace(/--[^\n]*/g, "");

  it("is a draft: marked as not applied, and kept out of supabase/migrations", () => {
    assert.match(SQL, /DRAFT, NOT APPLIED/);
    assert.ok(!existsSync(new URL("../supabase/migrations/0011_knowledge_guards.sql", import.meta.url)));
  });
  it("the removal function is administrator-only, by the caller's session, with a FIXED list of reasons and no free text", () => {
    const fn = /create or replace function public\.knowledge_redact[\s\S]*?\$\$;?[\s\S]*?end \$\$;/.exec(CODE)?.[0] ?? "";
    assert.ok(fn.length > 0);
    assert.match(fn, /auth\.uid\(\) is null or not public\.is_admin\(\)/);
    assert.match(fn, /p_reason not in \('secret', 'personal_data', 'incorrect', 'other'\)/);
    assert.match(fn, /security definer set search_path = ''/);
    assert.ok(!/\bp_note\b|\bp_text\b|\bp_body\b/.test(fn), "no free-text parameter");
    assert.match(CODE, /revoke all on function public\.knowledge_redact\(uuid, text\) from public, anon, authenticated, service_role/);
    assert.match(CODE, /grant execute on function public\.knowledge_redact\(uuid, text\) to authenticated/);
  });
  it("the replacement helper and the insert policy require the same scope, project and topic", () => {
    assert.match(CODE, /k\.scope = p_scope and k\.project_id is not distinct from p_project_id and k\.topic is not distinct from p_topic/);
    assert.match(CODE, /alter policy knowledge_items_insert[\s\S]*knowledge_can_replace\(supersedes_id, scope, project_id, topic\)/);
    assert.match(CODE, /prior\.scope <> k\.scope or prior\.project_id is distinct from k\.project_id or prior\.topic is distinct from k\.topic/);
    assert.match(CODE, /grant execute on function public\.knowledge_can_replace\(uuid, text, uuid, text\) to authenticated/);
  });
  it("adds no privilege to anon, service_role or anyone for UPDATE, DELETE or TRUNCATE, and has no destructive statement", () => {
    const grants = [...CODE.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => m[0]);
    assert.equal(grants.length, 3);
    for (const g of grants) assert.match(g, /grant execute on function public\.knowledge_(can_replace|review|redact)\([^)]*\) to authenticated;?$/i);
    assert.ok(!/^\s*(drop|truncate|delete from)\b/im.test(CODE));
  });
  it("does not edit the applied migrations: it only adds objects and replaces functions it names", () => {
    assert.ok(!/alter table public\.knowledge_items (alter|drop)/i.test(CODE));
    assert.ok(!/alter table public\.chat_audit/i.test(CODE));
  });
});

describe("applied migration files are pinned: an edit would make them differ from what broko-dev ran", () => {
  const sha = (p: string) => createHash("sha256").update(read(p)).digest("hex");
  it("0008, 0009 and 0010 are byte-identical to the reviewed and applied copies", () => {
    assert.equal(sha("supabase/proposed/0008_chat_audit.proposed.sql"), "d560f6be2d4f78f1a8ec14f8f8ce993c00bfd5f669261767f630eb8bb05feeb8");
    assert.equal(sha("supabase/proposed/0009_knowledge.proposed.sql"), "9988197336342fa89b716fae2f303910de57fdffe8c9526a492f1717d43de46f");
    assert.equal(sha("supabase/proposed/0010_chat_audit_vocab.proposed.sql"), "4a40baf60444967f02845cf8039071a21cdbd8b718353469f36a10ddad5d93de");
    // Applied to broko-dev on 2026-11-02 (Phase 3B gates 1 and 2); the stored statements were compared with these bytes.
    assert.equal(sha("supabase/proposed/0011_knowledge_guards.proposed.sql"), "58ae732df76c2886888d4aa4fb634efc34c43ade77dbf8bf906309359d1572b2");
    assert.equal(sha("supabase/proposed/0012_knowledge_secret_check.proposed.sql"), "c337484d1d023aadbc32416e1c43c0dfd689f405824c8117b6cc1126e596cd03");
  });
  it("the status page says 0009 to 0012 are applied to broko-dev only", () => {
    const doc = text("docs/MIGRATION_STATUS.md");
    assert.match(doc, /\| `0009_knowledge` \| `[0-9a-f]{12}` \| Applied/);
    assert.match(doc, /\| `0010_chat_audit_vocab` \| `[0-9a-f]{12}` \| Applied/);
    assert.match(doc, /\| \*\*`0011_knowledge_guards`\*\* \| `[0-9a-f]{12}` \| \*\*Applied to `broko-dev` only/);
    assert.match(doc, /\| \*\*`0012_knowledge_secret_check`\*\* \| `[0-9a-f]{12}` \| \*\*Applied to `broko-dev` only/);
  });
});
