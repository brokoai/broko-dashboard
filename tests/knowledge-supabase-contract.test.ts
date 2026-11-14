import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseKnowledgeRepo } from "../src/lib/backend/supabase/knowledge";
import { UserFacingError } from "../src/lib/backend/types";
import { ADMIN, MEMBER } from "./precon-helpers";

// The Supabase adapter cannot be exercised against a live project here. This contract test records exactly what it asks the
// database for, so the decisions in supabase/proposed/0009 (status/reviewer/timestamps are never sent, author comes from the session,
// status changes go through the review function, feedback is never read back) cannot drift without a test failing.

interface Call { table?: string; rpc?: string; args?: unknown; ops: [string, unknown[]][] }

function stub(results: Record<string, unknown> = {}, error: { message: string; code?: string } | null = null) {
  const calls: Call[] = [];
  const builder = (call: Call, key: string) => {
    const b: unknown = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => void) => ok({ data: results[key] ?? [], error, count: 0 });
        return (...args: unknown[]) => { call.ops.push([prop, args]); return b; };
      },
    });
    return b;
  };
  const db = {
    from(table: string) { const c: Call = { table, ops: [] }; calls.push(c); return builder(c, table); },
    rpc(name: string, args: unknown) { const c: Call = { rpc: name, args, ops: [] }; calls.push(c); return builder(c, name); },
  } as unknown as SupabaseClient;
  return { db, calls };
}
const op = (c: Call, name: string) => c.ops.find(([o]) => o === name)?.[1];
const row = { id: "i1", kind: "procedure", scope: "organization", project_id: null, title: "T", body: "B", topic: null, status: "proposed", author_id: MEMBER.id, source_type: "manual", source_ref: null, supersedes_id: null, effective_from: "2026-01-01T00:00:00Z", expires_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", reviewed_by: null, reviewed_at: null, review_note: null, author: { full_name: "Mo" }, reviewer: null };
const input = { kind: "correction", scope: "organization", project_id: null, title: "Title", body: "A body that is long enough.", topic: null, source_ref: null, supersedes_id: null, expires_on: "2027-01-31" } as const;

describe("Supabase knowledge adapter contract", () => {
  it("submit sends the session user as author and never status, reviewer or timestamps", async () => {
    const s = stub({ knowledge_items: row });
    const item = await createSupabaseKnowledgeRepo(s.db, MEMBER).submit(input);
    const sent = op(s.calls[0], "insert")?.[0] as Record<string, unknown>;
    assert.equal(sent.author_id, MEMBER.id);
    assert.equal(sent.source_type, "correction", "a correction is typed as one");
    assert.equal(sent.expires_at, "2027-01-31T23:59:59.000Z");
    for (const k of ["status", "reviewed_by", "reviewed_at", "review_note", "created_at", "updated_at", "effective_from", "id", "organization_id"]) assert.ok(!(k in sent), `${k} must not be sent`);
    assert.equal(item.author_name, "Mo");
  });

  it("review calls the review function with the action and note, and never updates the table", async () => {
    const s = stub({ knowledge_items: row });
    await createSupabaseKnowledgeRepo(s.db, ADMIN).review("i1", "approve", "ok");
    const rpc = s.calls.find((c) => c.rpc);
    assert.equal(rpc?.rpc, "knowledge_review");
    assert.deepEqual(rpc?.args, { p_id: "i1", p_action: "approve", p_note: "ok" });
    assert.ok(!s.calls.some((c) => c.ops.some(([o]) => o === "update" || o === "delete" || o === "upsert")), "no direct writes");
  });

  it("lists name explicit columns (never *), and the Brain list asks only for approved, in-effect, unexpired items", async () => {
    const s = stub();
    const repo = createSupabaseKnowledgeRepo(s.db, MEMBER);
    await repo.listCurrent(); await repo.listMine(); await repo.listQueue(); await repo.listAll({ status: "approved" });
    for (const c of s.calls) assert.ok(!/\*/.test(String(op(c, "select")?.[0])), "explicit columns only");
    const current = s.calls[0];
    assert.deepEqual(op(current, "eq"), ["status", "approved"]);
    assert.ok(current.ops.some(([o]) => o === "lte") && current.ops.some(([o, a]) => o === "or" && /expires_at\.is\.null/.test(String(a[0]))));
    assert.deepEqual(op(s.calls[1], "eq"), ["author_id", MEMBER.id]);
    const queue = s.calls[2].ops.filter(([o]) => o === "eq").map(([, a]) => a);
    assert.deepEqual(queue, [["status", "proposed"], ["author_id", MEMBER.id]], "a member's queue is limited to their own");
  });

  it("an administrator's queue is not limited to their own submissions", async () => {
    const s = stub();
    await createSupabaseKnowledgeRepo(s.db, ADMIN).listQueue();
    assert.deepEqual(s.calls[0].ops.filter(([o]) => o === "eq").map(([, a]) => a), [["status", "proposed"]]);
  });

  it("feedback is inserted without asking for the row back, and members never query history or feedback", async () => {
    const s = stub();
    const repo = createSupabaseKnowledgeRepo(s.db, MEMBER);
    await repo.recordFeedback({ rating: "useful", reason: null, intent: "knowledge", source_ids: ["knowledge"] });
    const call = s.calls[0];
    assert.equal(call.table, "answer_feedback");
    assert.deepEqual(op(call, "insert")?.[0], { actor_id: MEMBER.id, rating: "useful", reason: null, intent: "knowledge", source_ids: ["knowledge"] });
    assert.ok(!call.ops.some(([o]) => o === "select"), "members cannot read feedback back");
    assert.deepEqual(await repo.events("i1"), []);
    assert.deepEqual(await repo.feedbackSummary(), { useful: 0, not_useful: 0 });
    assert.equal(s.calls.length, 1, "no further queries for a member");
  });

  it("maps database refusals to friendly messages and hides unknown errors", async () => {
    const mk = (code: string, message = "internal detail postgres://secret") => createSupabaseKnowledgeRepo(stub({}, { code, message }).db, MEMBER);
    await assert.rejects(mk("42501").listMine(), /permission/);
    await assert.rejects(mk("54000").submit(input), /too quickly/);
    await assert.rejects(mk("23514").submit(input), /rules/);
    await assert.rejects(mk("55000").review("i1", "approve", null), /state/);
    // Raised by knowledge_review() in the DRAFT migration 0011: a specific sentence, and still no database text leaks through.
    await assert.rejects(mk("23514", "a replacement must have the same scope, project and topic as the item it replaces").review("i1", "approve", null),
      (e: Error) => e instanceof UserFacingError && /apply to the same scope, project and topic as the item it replaces\.$/.test(e.message) && !/must have/.test(e.message));
    // Raised by the secret-check trigger in the DRAFT migration 0012: a friendly sentence, and the database text (pattern id) is not shown.
    await assert.rejects(mk("23514", "knowledge text appears to contain a secret or credential (api_key_prefix)").submit(input),
      (e: Error) => e instanceof UserFacingError && /password, key or other secret/.test(e.message) && !/api_key_prefix/.test(e.message));
    // The same trigger guards review notes (knowledge_review is the only writer), so a review is mapped the same way.
    await assert.rejects(mk("23514", "knowledge text appears to contain a secret or credential (jwt)").review("i1", "reject", "x"),
      (e: Error) => e instanceof UserFacingError && /password, key or other secret/.test(e.message) && !/jwt/.test(e.message));
    await assert.rejects(mk("XX000").listMine(), (e: Error) => e.message === "internal detail postgres://secret" && e.name !== "UserFacingError");
  });
});
