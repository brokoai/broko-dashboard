import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryJobStore, JOB_DEFAULTS, SYNTHETIC_EMAILS, backoffMs, jobId, jobKey, type JobClaim } from "../src/lib/ai-brain";
import { makeClock, refOf } from "./ai-worker-helpers";

const ref = refOf(SYNTHETIC_EMAILS.viewingComplete);
const ref2 = refOf(SYNTHETIC_EMAILS.spam);

describe("job identity and idempotent enqueue", () => {
  it("is idempotent on the provider reference and keeps one job per message", async () => {
    const c = makeClock(), s = new InMemoryJobStore();
    const a = await s.enqueue(ref, c.now()), b = await s.enqueue(ref, c.now());
    assert.deepEqual([a.created, b.created, a.job.id === b.job.id], [true, false, true]);
    assert.equal((await s.list(10)).length, 1);
    assert.equal((await s.enqueue({ ...ref, mailbox_ref: "other-box" }, c.now())).created, true, "a copy in another mailbox is its own job (content dedupe happens at processing)");
  });

  it("derives a stable, hashed, content-free id from the reference", () => {
    assert.equal(jobId(ref), jobId({ ...ref }));
    assert.match(jobId(ref), /^[0-9a-f]{12}$/);
    assert.notEqual(jobId(ref), jobId(ref2));
    assert.ok(!jobId(ref).includes(ref.source_message_id) && jobKey(ref).includes(ref.source_message_id));
  });

  it("stores a reference only: no subject, body, sender or Message-ID", async () => {
    const c = makeClock(), s = new InMemoryJobStore();
    await s.enqueue(ref, c.now());
    const dump = JSON.stringify(await s.list(5));
    for (const f of ["Viewing request", "Hello, my name is", "alex.sample", "viewing-1@example.test", "BR-1042"]) assert.ok(!dump.includes(f), f);
  });
});

describe("claiming, leases and fencing", () => {
  const setup = async () => {
    const c = makeClock(), s = new InMemoryJobStore();
    await s.enqueue(ref, c.now());
    return { c, s };
  };

  it("moves queued -> processing -> completed and records attempts and the lease", async () => {
    const { c, s } = await setup();
    const { claim } = await s.claim("w1", c.now(), 60_000);
    assert.equal(claim?.attempt, 1);
    const j = (await s.get(claim!.job.id))!;
    assert.deepEqual([j.status, j.attempts, j.lease_owner], ["processing", 1, "w1"]);
    assert.ok(Date.parse(j.lease_expires_at!) === c.now().getTime() + 60_000);
    assert.equal(await s.complete(claim!, { workflow_id: "0123456789ab", outcome: "REVIEW_REQUIRED", audit_failed: false }, c.now()), true);
    const done = (await s.get(j.id))!;
    assert.deepEqual([done.status, done.outcome, done.lease_owner], ["completed", "REVIEW_REQUIRED", null]);
    assert.equal(await s.complete(claim!, { workflow_id: null, outcome: "x", audit_failed: false }, c.now()), false, "completing twice is refused");
  });

  it("two workers claiming at the same moment: exactly one gets the job", async () => {
    const { c, s } = await setup();
    const results = await Promise.all(["w1", "w2", "w3"].map((w) => s.claim(w, c.now(), 60_000)));
    assert.equal(results.filter((r) => r.claim).length, 1);
  });

  it("claims in order and never claims a retry before its time", async () => {
    const { c, s } = await setup();
    await s.enqueue(ref2, c.now());
    const first = (await s.claim("w1", c.now(), 60_000)).claim!;
    assert.equal(first.job.id, jobId(ref), "first in, first out");
    assert.equal(await s.retry(first, { error_category: "internal_error", run_at: new Date(c.now().getTime() + 10_000), workflow_id: null, audit_failed: false }, c.now()), true);
    const second = (await s.claim("w2", c.now(), 60_000)).claim!;
    assert.equal(second.job.id, jobId(ref2), "the retrying job is skipped while it waits");
    assert.equal((await s.claim("w3", c.now(), 60_000)).claim, null);
    c.advance(10_000);
    assert.equal((await s.claim("w3", c.now(), 60_000)).claim?.job.id, jobId(ref));
  });

  it("an abandoned lease is recovered with a new attempt, and the stale holder is fenced out", async () => {
    const { c, s } = await setup();
    const a = (await s.claim("w1", c.now(), 60_000)).claim!;
    assert.equal((await s.claim("w2", c.now(), 60_000)).claim, null, "a live lease is respected");
    c.advance(60_001);
    const b = (await s.claim("w2", c.now(), 60_000)).claim!;
    assert.equal(b.attempt, 2);
    // The zombie worker comes back after losing its lease: every write is refused and nothing changes.
    const zombie = { error_category: "internal_error" as const, workflow_id: null, audit_failed: false };
    assert.equal(await s.complete(a, { workflow_id: null, outcome: "REVIEW_REQUIRED", audit_failed: false }, c.now()), false);
    assert.equal(await s.fail(a, zombie, c.now()), false);
    assert.equal(await s.retry(a, { ...zombie, run_at: c.now() }, c.now()), false);
    const j = (await s.get(a.job.id))!;
    assert.deepEqual([j.status, j.lease_owner, j.attempts], ["processing", "w2", 2]);
    assert.equal(await s.complete(b, { workflow_id: null, outcome: "NO_ACTION", audit_failed: false }, c.now()), true);
  });

  it("an abandoned job with no attempts left becomes failed (processing_interrupted), is reported, and is not looped forever", async () => {
    const c = makeClock(), s = new InMemoryJobStore();
    await s.enqueue(ref, c.now(), { max_attempts: 2 });
    let claim: JobClaim | null = null;
    for (let i = 0; i < 2; i++) {
      claim = (await s.claim(`w${i}`, c.now(), 1_000)).claim;
      assert.ok(claim);
      c.advance(1_001); // the worker dies without reporting
    }
    const r = await s.claim("w9", c.now(), 1_000);
    assert.equal(r.claim, null);
    assert.equal(r.reaped.length, 1);
    const j = (await s.get(jobId(ref)))!;
    assert.deepEqual([j.status, j.error_category, j.attempts], ["failed", "processing_interrupted", 2]);
    assert.equal((await s.claim("w9", c.now(), 1_000)).reaped.length, 0, "reaped once");
  });

  it("refuses a retry when no attempts are left (the caller must fail the job instead)", async () => {
    const c = makeClock(), s = new InMemoryJobStore();
    await s.enqueue(ref, c.now(), { max_attempts: 1 });
    const claim = (await s.claim("w1", c.now(), 1000)).claim!;
    assert.equal(await s.retry(claim, { error_category: "internal_error", run_at: c.now(), workflow_id: null, audit_failed: false }, c.now()), false);
    assert.equal(await s.fail(claim, { error_category: "internal_error", workflow_id: null, audit_failed: false }, c.now()), true);
  });
});

describe("recovering a failed job", () => {
  it("only a failed job can be requeued; it restarts with a fresh attempt budget and records who did it", async () => {
    const c = makeClock(), s = new InMemoryJobStore();
    await s.enqueue(ref, c.now(), { max_attempts: 1 });
    assert.equal(await s.requeue(jobId(ref), "demo-admin", c.now()), false, "not failed yet");
    const claim = (await s.claim("w1", c.now(), 1000)).claim!;
    await s.fail(claim, { error_category: "internal_error", workflow_id: null, audit_failed: false }, c.now());
    assert.equal(await s.requeue(jobId(ref), "demo-admin", c.now()), true);
    const j = (await s.get(jobId(ref)))!;
    assert.deepEqual([j.status, j.attempts, j.requeued_by, j.error_category], ["queued", 0, "demo-admin", null]);
    assert.equal(await s.requeue(jobId(ref), "demo-admin", c.now()), false, "queued jobs are not requeued again");
    assert.equal(await s.requeue("missing", "x", c.now()), false);
  });
});

describe("retry backoff", () => {
  it("grows exponentially, is capped, and jitter scales it between 50% and 100%", () => {
    const full = (n: number) => backoffMs(n, { jitter: () => 1 });
    assert.deepEqual([1, 2, 3, 4].map(full), [5_000, 10_000, 20_000, 40_000]);
    assert.equal(full(20), JOB_DEFAULTS.backoffCapMs);
    assert.equal(backoffMs(3, { jitter: () => 0 }), 10_000);
    assert.equal(backoffMs(1, { base: 100, cap: 1000, jitter: () => 0.5 }), 75);
    for (const j of [-5, 7, Number.NaN, Infinity]) { const ms = backoffMs(2, { jitter: () => j }); assert.ok(Number.isFinite(ms) && ms >= 5_000 && ms <= 10_000, String(j)); }
  });
});
