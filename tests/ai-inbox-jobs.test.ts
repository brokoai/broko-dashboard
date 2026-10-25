import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ERROR_CATEGORIES, JOB_STATUSES, RuleBasedClassifier, SYNTHETIC_EMAILS, describeAudit, type Classifier } from "../src/lib/ai-brain";
import { ERROR_LABEL, errorLabel, jobStatusBadge, jobSummary, ownerSummary, queueActive } from "../src/lib/ai-presentation";
import { createDemoAiRuntime } from "../src/lib/backend/demo/ai-runtime";
import { createDemoRepo, DEMO_USERS, memoryStore } from "../src/lib/backend/demo/repo";
import type { AiInboxView } from "../src/lib/backend/types";
import { makeClock } from "./ai-worker-helpers";

const [admin, memberA, memberB] = DEMO_USERS;
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const nameOf = (id: string | null) => DEMO_USERS.find((u) => u.id === id)?.full_name ?? "someone";

/** A runtime that counts classifications, so we can prove when classification happens. */
function setup() {
  const counter = { calls: 0 };
  const inner = new RuleBasedClassifier();
  const classifier: Classifier = { name: "counting", async analyze(m) { counter.calls++; return inner.analyze(m); } };
  const selection = { classifier, mode: "rules" as const, model: null, note: null };
  const clock = makeClock();
  const rt = createDemoAiRuntime(selection, { now: clock.now, jitter: () => 1 });
  const store = memoryStore();
  const repo = (u: typeof admin) => createDemoRepo(u, store, () => NOW, { classifier: selection, runtime: rt }).aiInbox!;
  return { counter, rt, store, repo, clock };
}
const find = (v: AiInboxView, re: RegExp) => v.messages.find((m) => re.test(m.subject))!;

describe("the dashboard separates page requests from classification", () => {
  it("building the view queues the messages but never classifies, reads content or waits for the model", async () => {
    const { counter, repo } = setup();
    const v = await repo(admin).view();
    assert.equal(counter.calls, 0);
    assert.equal(v.messages.length, 0, "no message content exists until the worker has read it");
    assert.deepEqual(v.queue, { queued: 10, processing: 0, retry_wait: 0, completed: 0, failed: 0 });
    assert.ok(v.jobs.every((j) => j.status === "queued" && j.attempts === 0));
    await repo(admin).view();
    assert.equal(counter.calls, 0, "refreshing the page is still free");
    assert.equal((await repo(admin).view()).jobs.length, 10, "enqueueing is idempotent");
  });

  it("the worker moves jobs queued -> completed and the messages appear, waiting for a person", async () => {
    const { counter, repo } = setup();
    await repo(admin).view();
    const r = await repo(admin).process();
    assert.deepEqual(r, { completed: 10, retried: 0, failed: 0 });
    assert.equal(counter.calls, 9, "one classification per unique message; the duplicate delivery is not classified");
    const v = await repo(admin).view();
    assert.deepEqual(v.queue, { queued: 0, processing: 0, retry_wait: 0, completed: 10, failed: 0 });
    assert.equal(v.messages.length, 9);
    assert.ok(v.messages.every((m) => m.status === "REVIEW_REQUIRED" || m.status === "NO_ACTION"), "completed is not approved");
    assert.equal(v.duplicates_suppressed, 1);
    assert.ok(v.jobs.every((j) => j.status === "completed" && j.outcome !== null));
  });

  it("job views are content-free (no subject, sender, body, Message-ID or provider message id)", async () => {
    const { repo } = setup();
    await repo(admin).process();
    const dump = JSON.stringify((await repo(admin).view()).jobs);
    for (const f of ["Viewing request", "alex.sample", "example.test", "viewing-1@example.test", "syn-001", "synthetic-mailbox", "Hello, my name is"]) assert.ok(!dump.includes(f), f);
    for (const j of (await repo(admin).view()).jobs) assert.match(j.id, /^[0-9a-f]{12}$/);
  });

  it("process and requeue are administrator-only, so a member can never trigger classification", async () => {
    const { counter, repo } = setup();
    for (const u of [memberA, memberB]) {
      await assert.rejects(repo(u).process());
      await assert.rejects(repo(u).requeue("0123456789ab"));
      await assert.rejects(repo(u).view());
    }
    assert.equal(counter.calls, 0);
  });

  it("only a failed job can be requeued (and the administrator is recorded)", async () => {
    const { repo } = setup();
    await repo(admin).process();
    const v = await repo(admin).view();
    assert.equal(await repo(admin).requeue(v.jobs[0].id), false, "completed jobs are not requeued");
    assert.equal(await repo(admin).requeue("ffffffffffff"), false, "unknown jobs are not requeued");
  });

  it("shared worker state never contains one visitor's decisions", async () => {
    const { repo, rt } = setup();
    await repo(admin).process();
    const key = find(await repo(admin).view(), /BR-1042/).review_id;
    assert.equal((await repo(admin).review(key, { action: "approve" })).ok, true);
    assert.equal((await rt.records.list(100)).find((r) => r.review_id === key)?.status, "REVIEW_REQUIRED", "the shared record is untouched");
    assert.equal(find(await repo(admin).view(), /BR-1042/).status, "TASK_CREATED", "this visitor sees their decision");
    const other = createDemoRepo(admin, memoryStore(), () => NOW, { classifier: rt.selection, runtime: rt }).aiInbox!;
    assert.equal(find(await other.view(), /BR-1042/).status, "REVIEW_REQUIRED", "another visitor does not");
  });

  it("an unprocessed message cannot be approved (it has no record yet)", async () => {
    const { repo } = setup();
    await repo(admin).view();
    const r = await repo(admin).review("broko|mid|viewing-1@example.test", { action: "approve" });
    assert.equal(r.ok === false && r.error, "not_found");
  });
});

describe("reviewer decisions in the dashboard view", () => {
  it("shows the AI-suggested owner, then the human-confirmed owner, reviewer and time after approval", async () => {
    const { repo } = setup();
    await repo(admin).process();
    const key = find(await repo(admin).view(), /BR-1042/).review_id;
    const before = ownerSummary(find(await repo(admin).view(), /BR-1042/), nameOf);
    assert.deepEqual([before.suggested, before.confirmed, before.decision], ["Demo Member A", null, null]);
    await repo(admin).review(key, { action: "approve", assigned_to: memberB.id });
    const m = find(await repo(admin).view(), /BR-1042/);
    const after = ownerSummary(m, nameOf);
    assert.deepEqual([after.suggested, after.confirmed, after.confirmedBy, after.changedByReviewer, after.decision, after.decidedBy], ["Demo Member A", "Demo Member B", "Demo Administrator", true, "approved", "Demo Administrator"]);
    assert.equal(m.reviewed_at, m.confirmed_owner?.confirmed_at);
    assert.equal(Date.parse(m.reviewed_at!), Math.floor(NOW / 1000) * 1000, "the recorded time is the real decision time");
  });

  it("a confirmed suggestion is not marked as changed; a rejection shows who and when but no owner", async () => {
    const { repo } = setup();
    await repo(admin).process();
    await repo(admin).review(find(await repo(admin).view(), /BR-1042/).review_id, { action: "approve" });
    await repo(admin).review(find(await repo(admin).view(), /Invoice 8841/).review_id, { action: "reject" });
    const v = await repo(admin).view();
    assert.equal(ownerSummary(find(v, /BR-1042/), nameOf).changedByReviewer, false);
    const rej = ownerSummary(find(v, /Invoice 8841/), nameOf);
    assert.deepEqual([rej.decision, rej.confirmed, rej.decidedBy], ["rejected", null, "Demo Administrator"]);
    assert.ok(rej.decidedAt);
  });
});

describe("status rendering rules", () => {
  it("every job status and error category has a label, and the two label tables stay in sync", () => {
    for (const s of JOB_STATUSES) assert.notEqual(jobStatusBadge(s).label, "Unknown", s);
    for (const c of ERROR_CATEGORIES) {
      assert.ok(ERROR_LABEL[c], c);
      assert.equal(describeAudit({ event_type: "workflow_failed", status: "failed", error_category: c, decision: null, outcome: null, intent: null, classifier: null }), `Workflow failed: ${ERROR_LABEL[c]}`, "feed and queue panel agree");
    }
  });

  it("handles a status or category this build does not know", () => {
    assert.deepEqual(jobStatusBadge("brand_new"), { label: "Unknown", tone: "neutral" });
    assert.equal(errorLabel("brand_new"), "unknown cause");
    assert.equal(errorLabel(null), "unknown cause");
    assert.equal(jobSummary({ status: "weird" as never, attempts: 1, max_attempts: 3, next_attempt_at: "2026-10-12T10:00:00.000Z", error_category: null, outcome: null }, 0), "Unknown state.");
  });

  it("describes each state honestly: completed means classified, never approved, and a retry says when", () => {
    const base = { attempts: 1, max_attempts: 3, next_attempt_at: "2026-10-12T10:00:10.000Z", error_category: null, outcome: null };
    const t0 = Date.parse("2026-10-12T10:00:00.000Z");
    assert.match(jobSummary({ ...base, status: "queued", attempts: 0 }, t0), /Waiting for the background worker/);
    assert.match(jobSummary({ ...base, status: "processing" }, t0), /attempt 1 of 3/);
    assert.match(jobSummary({ ...base, status: "retry_wait", error_category: "classification_failed" }, t0), /Attempt 1 of 3 failed \(classification failed\)\. Next try in about 10s/);
    assert.match(jobSummary({ ...base, status: "retry_wait" }, t0 + 60_000), /is due now/);
    const done = jobSummary({ ...base, status: "completed", outcome: "REVIEW_REQUIRED" }, t0);
    assert.match(done, /A person still decides/);
    assert.ok(!/approved/i.test(done));
    assert.match(jobSummary({ ...base, status: "completed", outcome: "duplicate" }, t0), /copy of a message already processed/);
    assert.match(jobSummary({ ...base, status: "failed", attempts: 3, error_category: "internal_error" }, t0), /Failed after 3 attempts: an internal error occurred\. An administrator can retry it\./);
  });

  it("keeps the page refreshing only while work is outstanding", () => {
    assert.equal(queueActive({ queued: 0, processing: 0, retry_wait: 0, completed: 10, failed: 2 }), false);
    assert.equal(queueActive({ queued: 1 }), true);
    assert.equal(queueActive({ retry_wait: 3 }), true);
    assert.equal(queueActive({}), false);
  });

  it("unused fixtures stay synthetic", () => {
    assert.ok(Object.values(SYNTHETIC_EMAILS).every((m) => m.provider === "synthetic"));
  });
});
