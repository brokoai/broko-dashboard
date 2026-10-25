import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RuleBasedClassifier, SYNTHETIC_NOW, isValidJobId, jobId, jobKey, reviewIdFor, toMessageView, type JobClaim, type MessageRef } from "../src/lib/ai-brain";
import { createDemoAiRuntime } from "../src/lib/backend/demo/ai-runtime";
import {
  approveArgs, claimArgs, completeArgs, enqueueArgs, failArgs, jobFromRow, messageInsertFromRecord, recordFromRow, rejectArgs, requeueArgs, retryArgs,
} from "../src/lib/backend/supabase/ai-contract";
import { makeClock } from "./ai-worker-helpers";

/**
 * CONTRACT tests. They hold the application's mapping and RPC-argument rules against the text of the proposed SQL (0003/0004).
 * They are NOT integration tests: no Supabase repository exists yet, nothing here talks to a database, and a pass says nothing about
 * real behaviour. The SQL itself is exercised by supabase/proposed/tests (PGlite, single session) and, for concurrency, only by the
 * manual two-session procedure in docs/ai-brain/REMOTE_VERIFICATION_CHECKLIST.md.
 */
const sql = (f: string) => readFileSync(new URL(`../supabase/proposed/${f}`, import.meta.url), "utf8").replace(/--[^\n]*/g, "");
const SQL = sql("0003_ai_brain.proposed.sql") + sql("0004_ai_jobs.proposed.sql");

/** Parameter names of `create function public.NAME(...)` in the SQL text. */
function sqlParams(name: string): string[] {
  const m = SQL.match(new RegExp(`create function public\\.${name}\\(([\\s\\S]*?)\\)\\s*(?:returns|language)`, "i"));
  assert.ok(m, `${name} not found in the SQL`);
  return [...m[1].matchAll(/\bp_\w+/g)].map((x) => x[0]).sort();
}
const keys = (o: object) => Object.keys(o).sort();

const REF: MessageRef = { provider: "synthetic", mailbox_ref: "box", source_message_id: "msg-1" };
const CLAIM: JobClaim = {
  worker_id: "w1", attempt: 2,
  job: { id: jobId(REF), ref: REF } as JobClaim["job"],
};

describe("job id contract: the public job id is the 12-hex correlation id, everywhere", () => {
  it("is a hash of the canonical job key, 12 lower-case hex characters", () => {
    assert.match(jobId(REF), /^[0-9a-f]{12}$/);
    assert.equal(isValidJobId(jobId(REF)), true);
    for (const bad of ["", "ABCDEF012345", "0123456789a", "0123456789abc", " 0123456789ab", "0123456789ab\n", "11111111-1111-4111-8111-111111111111", 5, null, undefined]) assert.equal(isValidJobId(bad), false, String(bad));
    assert.equal(jobKey(REF), '["synthetic","box","msg-1"]');
  });

  it("every job RPC takes p_job_id (text), never a uuid, and the argument builders use the SQL parameter names exactly", () => {
    const cases: [string, object][] = [
      ["ai_enqueue_job", enqueueArgs(REF, 3)],
      ["ai_claim_job", claimArgs("w1", 60)],
      ["ai_complete_job", completeArgs(CLAIM, "aaaaaaaaaaaa", "REVIEW_REQUIRED", false)],
      ["ai_retry_job", retryArgs(CLAIM, "internal_error", SYNTHETIC_NOW, null, false)],
      ["ai_fail_job", failArgs(CLAIM, "internal_error", null, false)],
      ["ai_requeue_job", requeueArgs(jobId(REF))],
      ["ai_approve_message", approveArgs(reviewIdFor("k"), { title: "t", description: null, assigned_to: null, due_at: null, priority: "high" })],
      ["ai_reject_message", rejectArgs(reviewIdFor("k"))],
    ];
    for (const [fn, args] of cases) assert.deepEqual(keys(args), sqlParams(fn), `${fn}: argument names differ from the SQL`);
    for (const fn of ["ai_complete_job", "ai_retry_job", "ai_fail_job", "ai_requeue_job"]) assert.ok(sqlParams(fn).includes("p_job_id"), fn);
    assert.match(SQL, /ai_requeue_job\(p_job_id text\)/);
    assert.match(SQL, /correlation_id text not null unique\s+check \(correlation_id ~ '\^\[0-9a-f\]\{12\}\$'\)/);
  });

  it("refuses an id that is not the public job id before any RPC is made (an internal uuid, upper case, empty)", () => {
    for (const bad of ["11111111-1111-4111-8111-111111111111", "ABCDEF012345", "", "x"]) {
      assert.throws(() => requeueArgs(bad), /job id/, bad);
      assert.throws(() => completeArgs({ ...CLAIM, job: { ...CLAIM.job, id: bad } }, null, "NO_ACTION", false), /job id/, bad);
    }
  });

  const dbRow = (over: Record<string, unknown> = {}) => ({
    id: "5b0f6a52-3b1e-4a64-9a0c-0e3f1b8f7a11",            // the INTERNAL uuid: must never surface
    job_key: jobKey(REF), correlation_id: jobId(REF), provider: "synthetic", mailbox_ref: "box", source_message_id: "msg-1", status: "processing",
    attempts: 2, max_attempts: 3, next_attempt_at: "2026-10-12T10:00:00.123456+00:00", lease_owner: "w1", lease_expires_at: "2026-10-12T10:01:00+00:00",
    workflow_id: null, outcome: null, error_category: null, audit_failed: false, requeued_by: null, requeued_at: null,
    enqueued_at: "2026-10-12T09:59:00+00:00", started_at: "2026-10-12T10:00:00+00:00", finished_at: null, updated_at: "2026-10-12T10:00:00+00:00", ...over,
  });

  it("maps a database row to a JobRecord whose id is the public id; the internal uuid never leaves the mapper; timestamps become UTC Z", () => {
    const rec = jobFromRow(dbRow());
    assert.equal(rec.id, jobId(REF));
    assert.equal(rec.id, jobId(rec.ref), "round trip: the id is recomputable from the reference");
    assert.equal(JSON.stringify(rec).includes("5b0f6a52"), false);
    assert.equal(rec.next_attempt_at, "2026-10-12T10:00:00.123Z");
    assert.equal(rec.lease_expires_at, "2026-10-12T10:01:00.000Z");
    assert.throws(() => jobFromRow(dbRow({ correlation_id: "5b0f6a52-3b1e-4a64-9a0c-0e3f1b8f7a11" })), /correlation_id/);
    assert.throws(() => jobFromRow(dbRow({ correlation_id: undefined })), /correlation_id/);
    assert.throws(() => jobFromRow(dbRow({ next_attempt_at: "not a date" })), /timestamp/);
  });
});

describe("review id contract: the persisted review_id is authoritative", () => {
  async function aRecord() {
    const rt = createDemoAiRuntime({ classifier: new RuleBasedClassifier(), mode: "rules", model: null, note: null }, { now: makeClock().now, jitter: () => 1 });
    await rt.ensureQueued();
    await rt.drain();
    const rec = (await rt.records.list(100)).find((r) => /BR-1042/.test(r.subject));
    assert.ok(rec, "sample record");
    return rec;
  }
  // A row as PostgREST returns it: the database's own review_id and "+00:00" timestamps.
  const PERSISTED = "0b5fd0c4-6a6f-4e0a-9b1e-3f2f6a1c2d3e";
  const asRow = (r: Awaited<ReturnType<typeof aRecord>>, over: Record<string, unknown> = {}) => ({
    ...r, review_id: PERSISTED, received_at: r.received_at.replace("Z", "+00:00"), created_at: r.created_at.replace("Z", "+00:00"), updated_at: r.updated_at.replace("Z", "+00:00"),
    proposed_due_at: r.proposed_due_at ? r.proposed_due_at.replace("Z", "+00:00") : null, ...over,
  });

  it("reads review_id from the row and never recomputes it from the dedupe key", async () => {
    const rec = await aRecord();
    assert.notEqual(PERSISTED, reviewIdFor(rec.dedupe_key), "fixture: the persisted id differs from a derived one");
    const back = recordFromRow(asRow(rec));
    assert.equal(back.review_id, PERSISTED);
    assert.equal(toMessageView(back).review_id, PERSISTED, "the browser-facing id is the persisted one");
    assert.deepEqual({ ...back, review_id: rec.review_id }, rec, "everything else survives the round trip, timestamps included");
  });

  it("refuses a row without a valid persisted review_id instead of inventing one", async () => {
    const rec = await aRecord();
    for (const bad of [undefined, null, "", "nope", PERSISTED.toUpperCase(), rec.dedupe_key]) assert.throws(() => recordFromRow(asRow(rec, { review_id: bad })), /review_id/, String(bad));
  });

  it("an INSERT leaves review_id out, so the database default generates it", async () => {
    const rec = await aRecord();
    const ins = messageInsertFromRecord(rec);
    assert.equal("review_id" in ins, false);
    assert.equal(JSON.stringify(ins).includes(rec.review_id), false);
    assert.equal(ins.dedupe_key, rec.dedupe_key);
    assert.match(SQL, /review_id uuid not null unique default gen_random_uuid\(\)/i);
  });

  it("the column defaults in the SQL produce a row the application schema accepts (notification default has every field)", async () => {
    const rec = await aRecord();
    const def = SQL.match(/notification jsonb not null default '(\{[^']*\})'/i);
    assert.ok(def, "notification default not found");
    const back = recordFromRow(asRow(rec, { notification: JSON.parse(def[1]) }));
    assert.deepEqual(keys(back.notification), ["attempted", "detail", "sent"]);
  });

  it("normalises the confirmed-owner timestamp that SQL now() writes into jsonb", async () => {
    const rec = await aRecord();
    const row = asRow(rec, { status: "TASK_CREATED", reviewed_at: "2026-10-12T10:00:00.5+00:00", confirmed_owner: { user_id: null, confirmed_by: "u1", confirmed_at: "2026-10-12T10:00:00.5+00:00" } });
    assert.equal(recordFromRow(row).confirmed_owner?.confirmed_at, "2026-10-12T10:00:00.500Z");
  });

  it("approve and reject RPCs take the persisted id and refuse anything that is not a lower-case UUID (e.g. a dedupe key)", async () => {
    const rec = await aRecord();
    assert.deepEqual(rejectArgs(PERSISTED), { p_review_id: PERSISTED });
    for (const bad of [rec.dedupe_key, rec.source_message_id, "ABCDEF012345", PERSISTED.toUpperCase()]) assert.throws(() => rejectArgs(bad), /review id/);
  });
});

describe("static guards on the future repository", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = walk("src").filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => f.replaceAll("\\", "/"));

  it("only the in-memory demo and the AI Brain core derive a review id from a dedupe key (reviewIdFor is never called in database code)", () => {
    const callers = files.filter((f) => /\breviewIdFor\(/.test(readFileSync(f, "utf8")));
    for (const f of callers) assert.ok(f.startsWith("src/lib/ai-brain/") || f.startsWith("src/lib/backend/demo/"), `${f} derives a review id; a database repository must read the persisted one`);
  });

  it("if a Supabase AI repository is added, it must use the contract module (this fails then, on purpose, to force integration tests)", () => {
    const supa = files.filter((f) => f.startsWith("src/lib/backend/supabase/") && !f.endsWith("ai-contract.ts"));
    for (const f of supa) {
      const text = readFileSync(f, "utf8");
      if (/\bai_(messages|jobs|approve_message|reject_message|claim_job|requeue_job)\b|aiInbox/.test(text)) {
        assert.match(text, /ai-contract/, `${f} touches the AI tables or functions but does not use ai-contract.ts; add integration tests against a real database`);
      }
    }
  });
});
