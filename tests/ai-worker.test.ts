import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CountingClassifierLike, goodAnalysis,
} from "./ai-worker-fakes";
import { DUPLICATE_OF_VIEWING, SYNTHETIC_EMAILS, jobId, processMessage, sourceRef, dedupeKey, normalizeEmail, SYNTHETIC_NOW, rulesSelection, type LlmTransport } from "../src/lib/ai-brain";
import { harness, modelSelection, MESSAGES, refOf } from "./ai-worker-helpers";

const viewing = SYNTHETIC_EMAILS.viewingComplete;
const FORBIDDEN = ["alex.sample@example.test", "Alex Sample", "+1 555 010", "Hello, my name is", "BR-1042", "viewing-1@example.test", "Viewing request for property", "example.test", "TEST-KEY-NOT-REAL", "broko|mid|"];
const clean = (v: unknown, what: string) => { const d = JSON.stringify(v); for (const f of FORBIDDEN) assert.ok(!d.includes(f), `${what} must not contain "${f}"`); };

describe("worker: a job ends in classification, never in approval", () => {
  it("processes every synthetic message to completed; each message waits for a human or needs no action", async () => {
    const h = harness();
    await h.enqueueAll();
    const sum = await h.worker().drain();
    assert.deepEqual([sum.completed, sum.failed, sum.retried], [MESSAGES.length, 0, 0]);
    const jobs = await h.jobs.list(50);
    assert.ok(jobs.every((j) => j.status === "completed" && j.attempts === 1));
    for (const j of jobs) assert.ok(["REVIEW_REQUIRED", "NO_ACTION"].includes(j.outcome!), `${j.outcome}`);
    assert.ok(jobs.every((j) => !/approv/i.test(j.outcome!)), "no job outcome is an approval");
    assert.equal(h.sink.calls, 0, "no task is created by a worker");
    const recs = await h.records.list(50);
    assert.ok(recs.every((r) => r.reviewed_by === null && r.reviewed_at === null && r.confirmed_owner === null), "no reviewer is recorded without a human");
  });

  it("records the hashed workflow id on the job and nothing else about the message", async () => {
    const h = harness({ messages: [viewing] });
    await h.enqueueAll();
    await h.worker().drain();
    const [j] = await h.jobs.list(5);
    assert.equal(j.workflow_id, sourceRef(dedupeKey(normalizeEmail(viewing, { now: SYNTHETIC_NOW }).message)));
    assert.equal(j.id, jobId(refOf(viewing)));
  });

  it("is idempotent: re-enqueueing and re-running classifies nothing twice", async () => {
    const counting = new CountingClassifierLike();
    const h = harness({ selection: { ...rulesSelection(), classifier: counting } });
    await h.enqueueAll();
    await h.worker().drain();
    const calls = counting.calls;
    await h.enqueueAll();
    const again = await h.worker().drain();
    assert.equal(again.runs, 0);
    assert.equal(counting.calls, calls);
    assert.equal((await h.records.list(50)).length, MESSAGES.length);
  });

  it("a copy in a second mailbox completes as a duplicate without a second classification or record", async () => {
    const counting = new CountingClassifierLike();
    const h = harness({ selection: { ...rulesSelection(), classifier: counting }, messages: [viewing, DUPLICATE_OF_VIEWING] });
    await h.enqueueAll();
    await h.worker().drain();
    const jobs = await h.jobs.list(5);
    assert.deepEqual(jobs.map((j) => j.outcome).sort(), ["REVIEW_REQUIRED", "duplicate"]);
    assert.equal(counting.calls, 1);
    assert.equal((await h.records.list(10)).length, 1);
    assert.equal(h.audit.events.filter((e) => e.event_type === "email_received").length, 1);
  });

  it("two workers draining concurrently process every job exactly once", async () => {
    const counting = new CountingClassifierLike(5);
    const h = harness({ selection: { ...rulesSelection(), classifier: counting }, messages: MESSAGES.filter((m) => m !== viewing) });
    await h.enqueueAll();
    const [a, b] = await Promise.all([h.worker("w1").drain({ concurrency: 2 }), h.worker("w2").drain({ concurrency: 2 })]);
    assert.equal(a.completed + b.completed, h.messages.length);
    assert.equal(counting.calls, h.messages.length, "each message classified once");
    assert.ok((await h.jobs.list(50)).every((j) => j.attempts === 1 && j.status === "completed"));
  });
});

describe("worker: model failures, timeouts, invalid output and fallback", () => {
  it("retries a transient model failure with backoff, then completes; the failed attempt is a pending audit event", async () => {
    let calls = 0;
    const transport: LlmTransport = async () => { if (++calls === 1) throw new Error("503 TEST-KEY-NOT-REAL"); return JSON.stringify(goodAnalysis()); };
    const h = harness({ selection: modelSelection(transport), messages: [viewing] });
    await h.enqueueAll();
    const first = await h.worker().runOnce();
    assert.deepEqual([first.kind, first.kind === "retry" && first.error_category], ["retry", "classification_failed"]);
    let job = (await h.jobs.list(5))[0];
    assert.deepEqual([job.status, job.attempts], ["retry_wait", 1]);
    assert.equal(Date.parse(job.next_attempt_at) - h.clock.now().getTime(), 5_000, "backoff of one base interval");
    assert.equal((await h.worker().runOnce()).kind, "idle", "nothing is due before the backoff elapses");
    h.clock.advance(5_000);
    assert.equal((await h.worker().runOnce()).kind, "completed");
    job = (await h.jobs.list(5))[0];
    assert.deepEqual([job.status, job.attempts, job.outcome], ["completed", 2, "REVIEW_REQUIRED"]);
    const failed = h.audit.events.filter((e) => e.event_type === "workflow_failed");
    assert.deepEqual(failed.map((e) => [e.status, e.attempt, e.error_category]), [["pending", 1, "classification_failed"]]);
    assert.equal(h.audit.events.filter((e) => e.event_type === "email_received").length, 1, "no duplicate audit events after the retry");
    assert.equal((await h.records.list(5))[0].classifier?.mode, "llm");
    clean(h.audit.events, "audit events");
  });

  it("when the model never recovers, the last attempt falls back to the rules (visibly) instead of leaving the message stuck", async () => {
    const transport: LlmTransport = async () => { throw new Error("down"); };
    const h = harness({ selection: modelSelection(transport), messages: [viewing] });
    await h.enqueueAll();
    for (let i = 0; i < 6; i++) { await h.worker().runOnce(); h.clock.advance(60_000); }
    const job = (await h.jobs.list(5))[0];
    assert.deepEqual([job.status, job.attempts, job.outcome], ["completed", 3, "REVIEW_REQUIRED"]);
    const rec = (await h.records.list(5))[0];
    assert.deepEqual(rec.classifier, { name: "rule-based", mode: "rules", fallback_reason: "model_unavailable" });
    assert.equal(rec.status, "REVIEW_REQUIRED", "a fallback result still needs a human");
    assert.deepEqual(h.audit.events.filter((e) => e.event_type === "workflow_failed").map((e) => [e.status, e.attempt]), [["pending", 1], ["pending", 2]]);
  });

  it("aborts a hanging model call at the timeout and treats it as transient", async () => {
    const h = harness({ selection: modelSelection(() => new Promise(() => {})), messages: [viewing], config: { classifyTimeoutMs: 25 } });
    await h.enqueueAll();
    const r = await h.worker().runOnce();
    assert.equal(r.kind, "retry");
    assert.equal((await h.jobs.list(5))[0].status, "retry_wait");
  });

  it("invalid model output is never retried and never trusted: rules take over immediately", async () => {
    const hijack = JSON.stringify({ ...goodAnalysis(), owner_id: "demo-admin", approved: true, reviewed_by: "demo-admin", status: "TASK_CREATED" });
    for (const output of ["I cannot help with that.", "{broken", hijack]) {
      const h = harness({ selection: modelSelection(async () => output), messages: [viewing] });
      await h.enqueueAll();
      assert.equal((await h.worker().runOnce()).kind, "completed", output.slice(0, 12));
      const [job] = await h.jobs.list(5);
      assert.equal(job.attempts, 1);
      const [rec] = await h.records.list(5);
      assert.equal(rec.classifier?.fallback_reason, "model_output_invalid");
      assert.equal(rec.status, "REVIEW_REQUIRED");
      assert.deepEqual([rec.reviewed_by, rec.confirmed_owner, rec.task_id], [null, null, null], "the model cannot set the reviewer, owner or approval");
      assert.equal(h.sink.calls, 0);
    }
  });

  it("the default (rules) mode never calls a model", async () => {
    const h = harness({ selection: rulesSelection(), messages: MESSAGES });
    assert.equal(h.selection.llm, undefined, "rules mode has no model classifier at all");
    await h.enqueueAll();
    await h.worker().drain();
    assert.ok((await h.records.list(50)).every((r) => r.classifier?.mode === "rules" && r.classifier.fallback_reason === null));
  });
});

describe("worker: bounded retries, terminal failure and recovery", () => {
  it("retries provider failures a bounded number of times, then fails terminally with a safe category; an admin can requeue", async () => {
    const h = harness({ messages: [viewing] });
    h.fetcher.failNext = 99;
    await h.enqueueAll();
    const kinds: string[] = [];
    for (let i = 0; i < 5; i++) { kinds.push((await h.worker().runOnce()).kind); h.clock.advance(600_000); }
    assert.deepEqual(kinds.slice(0, 3), ["retry", "retry", "failed"]);
    assert.equal(kinds[3], "idle", "a failed job is not claimed again");
    const job = (await h.jobs.list(5))[0];
    assert.deepEqual([job.status, job.attempts, job.error_category], ["failed", 3, "internal_error"]);
    assert.deepEqual(h.audit.events.filter((e) => e.event_type === "workflow_failed").map((e) => [e.status, e.attempt]), [["pending", 1], ["pending", 2], ["failed", 3]]);
    // Recovery: the cause is fixed and an administrator requeues it.
    h.fetcher.failNext = 0;
    assert.equal(await h.jobs.requeue(job.id, "demo-admin", h.clock.now()), true);
    assert.equal((await h.worker().runOnce()).kind, "completed");
    const after = (await h.jobs.list(5))[0];
    assert.deepEqual([after.status, after.attempts, after.requeued_by], ["completed", 1, "demo-admin"]);
  });

  it("a message that no longer exists fails at once (retrying cannot help)", async () => {
    const h = harness({ messages: [] });
    await h.jobs.enqueue(refOf(viewing), h.clock.now());
    assert.equal((await h.worker().runOnce()).kind, "failed");
    const [j] = await h.jobs.list(5);
    assert.deepEqual([j.status, j.attempts, j.error_category], ["failed", 1, "invalid_input"]);
  });

  it("a message that cannot be normalised fails terminally without retry", async () => {
    const h = harness({ messages: [SYNTHETIC_EMAILS.invalidSender] });
    await h.enqueueAll();
    assert.equal((await h.worker().runOnce()).kind, "failed");
    assert.equal((await h.jobs.list(5))[0].error_category, "invalid_input");
    assert.equal((await h.records.list(5)).length, 0);
  });
});

describe("worker: crashes and abandoned leases", () => {
  it("a crashed worker's job is recovered by another worker; the stale worker cannot overwrite the result", async () => {
    const h = harness({ messages: [viewing] });
    await h.enqueueAll();
    const lost = (await h.jobs.claim("crashed", h.clock.now(), 60_000)).claim!; // claimed, then the process dies
    assert.equal((await h.worker("w2").runOnce()).kind, "idle", "the live lease is respected");
    h.clock.advance(60_001);
    assert.equal((await h.worker("w2").runOnce()).kind, "completed");
    const [job] = await h.jobs.list(5);
    assert.deepEqual([job.status, job.attempts, job.lease_owner], ["completed", 2, null]);
    assert.equal(await h.jobs.complete(lost, { workflow_id: null, outcome: "NO_ACTION", audit_failed: false }, h.clock.now()), false);
    assert.equal((await h.jobs.get(job.id))!.outcome, "REVIEW_REQUIRED", "the result is untouched");
  });

  it("a crash AFTER the message was classified does not classify or audit it again", async () => {
    const counting = new CountingClassifierLike();
    const h = harness({ selection: { ...rulesSelection(), classifier: counting }, messages: [viewing] });
    await h.enqueueAll();
    await h.jobs.claim("crashed", h.clock.now(), 60_000); // worker dies right after committing the record, before completing the job
    await processMessage({ store: h.records, audit: h.audit, classifier: counting, ownerRules: [], assignable: new Set(), policy: (await import("../src/lib/ai-brain")).DEFAULT_POLICY, now: h.clock.now }, viewing);
    const events = h.audit.events.length, calls = counting.calls;
    h.clock.advance(60_001);
    const r = await h.worker().runOnce();
    assert.equal(r.kind, "completed");
    assert.equal(counting.calls, calls, "not classified twice");
    assert.equal(h.audit.events.length, events, "no duplicate audit events");
    assert.equal((await h.jobs.list(5))[0].outcome, "REVIEW_REQUIRED", "the job reports the real outcome of the earlier attempt");
  });

  it("resumes a record a crashed run left in PROCESSING (a store failure after the claim)", async () => {
    const h = harness({ messages: [viewing] });
    await h.enqueueAll();
    const real = h.records.update.bind(h.records);
    let broke = false;
    h.records.update = async (k, p) => { if (!broke) { broke = true; throw new Error("database connection lost"); } return real(k, p); };
    assert.equal((await h.worker().runOnce()).kind, "retry");
    assert.equal((await h.records.list(5))[0].status, "PROCESSING", "the record is stuck exactly as after a crash");
    h.clock.advance(5_000);
    assert.equal((await h.worker().runOnce()).kind, "completed");
    const [rec] = await h.records.list(5);
    assert.equal(rec.status, "REVIEW_REQUIRED");
    assert.equal(h.audit.events.filter((e) => e.event_type === "email_received").length, 1);
  });

  it("reports an abandoned job that ran out of attempts as a terminal workflow_failed", async () => {
    const h = harness({ messages: [viewing], maxAttempts: 1 });
    await h.enqueueAll();
    await h.jobs.claim("crashed", h.clock.now(), 1_000);
    h.clock.advance(1_001);
    const r = await h.worker().runOnce();
    assert.deepEqual([r.kind, r.reaped], ["idle", 1]);
    assert.equal((await h.jobs.list(5))[0].status, "failed");
    assert.deepEqual(h.audit.events.map((e) => [e.event_type, e.status, e.error_category]), [["workflow_failed", "failed", "processing_interrupted"]]);
  });
});

describe("worker: audit persistence", () => {
  it("an audit outage never blocks or corrupts processing, and is surfaced on the job", async () => {
    const h = harness({ messages: [viewing] });
    h.audit.failing = true;
    await h.enqueueAll();
    assert.equal((await h.worker().runOnce()).kind, "completed");
    const [job] = await h.jobs.list(5);
    assert.deepEqual([job.status, job.audit_failed], ["completed", true]);
    assert.equal((await h.records.list(5))[0].status, "REVIEW_REQUIRED");
    assert.equal(h.audit.events.length, 0, "nothing is claimed as recorded");
  });

  it("job state and audit events contain no email content, addresses, Message-ID, dedupe key, secrets or raw errors", async () => {
    const transport: LlmTransport = async () => { throw new Error("401 TEST-KEY-NOT-REAL Cannot read properties of undefined"); };
    for (const selection of [rulesSelection(), modelSelection(transport)]) {
      const h = harness({ selection });
      h.fetcher.failNext = 1;
      await h.enqueueAll();
      for (let i = 0; i < 8; i++) { await h.worker().drain(); h.clock.advance(120_000); }
      assert.ok(h.audit.events.length > 0);
      clean(h.audit.events, `audit events (${selection.mode})`);
      const jobDump = (await h.jobs.list(50)).map((j) => { const rest: Record<string, unknown> = { ...j }; delete rest.ref; return rest; });
      clean(jobDump, `job state (${selection.mode})`);
    }
  });
});
