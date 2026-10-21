import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DUPLICATE_OF_VIEWING, SYNTHETIC_EMAILS, SyntheticEmailProvider, UnconfiguredEmailProvider, UnconfiguredNotifier,
  ingestFromProvider, processMessage, reviewMessage, type Classifier, type RawEmail,
} from "../src/lib/ai-brain";
import { ADMIN, CountingClassifier, FakeNotifier, MEMBER_A, MEMBER_B, makeDeps } from "./ai-brain-helpers";

const viewing = SYNTHETIC_EMAILS.viewingComplete;
const autoPolicy = { auto_create: "low_risk" as const, verified_sender_domains: ["example.test"], min_confidence: 0.6 };

describe("pipeline: default policy (a human approves every proposed task)", () => {
  it("a viewing request becomes a review item with a rule-based owner and the message's own date", async () => {
    const { deps, sink } = makeDeps();
    const r = await processMessage(deps, viewing);
    assert.equal(r.outcome, "processed");
    assert.equal(r.record?.status, "REVIEW_REQUIRED");
    assert.equal(r.record?.owner.user_id, MEMBER_A.id);
    assert.equal(r.record?.owner.rule_id, "viewings");
    assert.equal(r.record?.proposed_due_at, "2026-11-14T00:00:00.000Z");
    assert.ok(r.record?.review_reasons.includes("policy_requires_approval"));
    assert.equal(sink.calls, 0, "nothing is created before approval");
    assert.equal(r.record?.excerpt, null, "no email text is retained by default");
  });

  it("an admin approves: exactly one task, linked to the source, assigned per rule", async () => {
    const { deps, sink } = makeDeps({ notifier: new FakeNotifier() });
    const { record } = await processMessage(deps, viewing);
    const res = await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    assert.equal(res.ok, true);
    assert.equal(sink.tasks.size, 1);
    const t = [...sink.tasks.values()][0];
    assert.equal(t.input.assigned_to, MEMBER_A.id);
    assert.equal(t.ctx.source, "email");
    assert.equal(t.ctx.dedupe_key, record!.dedupe_key);
    assert.match(t.input.description ?? "", /no reply has been sent/i);
    assert.equal(res.ok && res.record.status, "NOTIFICATION_SENT");
  });

  it("approval overrides are validated and cannot bypass the permission rule", async () => {
    const { deps, sink } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    const k = record!.dedupe_key;
    const bad = await reviewMessage(deps, k, { action: "approve", by: ADMIN, assigned_to: "ghost" });
    assert.deepEqual(bad.ok === false && bad.error, "invalid_override");
    const badDate = await reviewMessage(deps, k, { action: "approve", by: ADMIN, due_at: "tomorrow" });
    assert.deepEqual(badDate.ok === false && badDate.error, "invalid_override");
    assert.equal(sink.calls, 0);
    const ok = await reviewMessage(deps, k, { action: "approve", by: ADMIN, assigned_to: MEMBER_B.id, priority: "high" });
    assert.equal(ok.ok, true);
    assert.equal([...sink.tasks.values()][0].input.assigned_to, MEMBER_B.id);
  });

  it("members cannot review, and a non-existent message is reported plainly", async () => {
    const { deps, sink } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    const r = await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: MEMBER_A });
    assert.equal(r.ok === false && r.error, "forbidden");
    assert.equal(sink.calls, 0);
    const nf = await reviewMessage(deps, "nope", { action: "reject", by: ADMIN });
    assert.equal(nf.ok === false && nf.error, "not_found");
  });

  it("double and concurrent approval create one task", async () => {
    const { deps, sink } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    const k = record!.dedupe_key;
    const results = await Promise.all([1, 2, 3].map(() => reviewMessage(deps, k, { action: "approve", by: ADMIN })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === "not_reviewable"));
    assert.equal(sink.tasks.size, 1);
    const again = await reviewMessage(deps, k, { action: "approve", by: ADMIN });
    assert.equal(again.ok === false && again.error, "not_reviewable");
  });

  it("rejecting creates nothing and cannot be reversed by approving", async () => {
    const { deps, sink } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    assert.equal((await reviewMessage(deps, record!.dedupe_key, { action: "reject", by: ADMIN })).ok, true);
    const after = await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    assert.equal(after.ok === false && after.error, "not_reviewable");
    assert.equal(sink.calls, 0);
  });

  it("if the task backend fails after approval, the item returns to review and can be retried", async () => {
    const { deps, sink } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    const real = sink.createTask.bind(sink);
    let fail = true;
    sink.createTask = async (i, c) => { if (fail) throw new Error("db down: password=hunter2"); return real(i, c); };
    const r1 = await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    assert.equal(r1.ok === false && r1.error, "task_failed");
    assert.ok(r1.ok === false && r1.message === "unexpected internal error" && !JSON.stringify(r1).includes("hunter2"));
    assert.equal((await deps.store.get(record!.dedupe_key))?.status, "REVIEW_REQUIRED");
    fail = false;
    assert.equal((await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN })).ok, true);
    assert.equal(sink.tasks.size, 1);
  });

  it("approval without a connected task backend fails honestly", async () => {
    const { deps } = makeDeps({ taskSink: undefined });
    const { record } = await processMessage(deps, viewing);
    const r = await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    assert.equal(r.ok === false && r.error, "task_failed");
  });
});

describe("pipeline: other kinds of mail", () => {
  it("sensitive intents always go to a human, with the right flags", async () => {
    const { deps } = makeDeps({ policy: autoPolicy });
    const inv = (await processMessage(deps, SYNTHETIC_EMAILS.invoice)).record!;
    assert.equal(inv.status, "REVIEW_REQUIRED");
    assert.ok(inv.risk_flags.includes("financial"));
    assert.ok(inv.review_reasons.some((x) => x.startsWith("sensitive_intent")));
    const legal = (await processMessage(deps, SYNTHETIC_EMAILS.legal)).record!;
    assert.equal(legal.status, "REVIEW_REQUIRED");
    assert.ok(legal.risk_flags.includes("legal_or_compliance"));
    const complaint = (await processMessage(deps, SYNTHETIC_EMAILS.urgentComplaint)).record!;
    assert.equal(complaint.status, "REVIEW_REQUIRED");
    assert.equal(complaint.proposed_priority, "urgent");
  });

  it("a prompt-injection email is flagged for review even under the auto-create policy, and no task is made", async () => {
    const { deps, sink } = makeDeps({ policy: autoPolicy });
    const r = (await processMessage(deps, SYNTHETIC_EMAILS.injection)).record!;
    assert.equal(r.status, "REVIEW_REQUIRED");
    assert.ok(r.risk_flags.includes("prompt_injection_suspected"));
    assert.equal(sink.calls, 0);
  });

  it("hidden-text injection is caught even though the hidden text never reaches the classifier", async () => {
    const seen: string[] = [];
    const spy: Classifier = { name: "spy", async analyze(m) { seen.push(m.body_text); return new CountingClassifier().analyze(m); } };
    const { deps } = makeDeps({ classifier: spy, policy: autoPolicy });
    const r = (await processMessage(deps, SYNTHETIC_EMAILS.hiddenHtml)).record!;
    assert.ok(!/ignore previous/i.test(seen.join(" ")));
    assert.ok(r.risk_flags.includes("prompt_injection_suspected"));
    assert.equal(r.status, "REVIEW_REQUIRED");
  });

  it("spam needs no action and creates nothing", async () => {
    const { deps, sink } = makeDeps({ policy: autoPolicy });
    const r = (await processMessage(deps, SYNTHETIC_EMAILS.spam)).record!;
    assert.equal(r.status, "NO_ACTION");
    assert.equal(r.proposed_priority, null);
    assert.equal(sink.calls, 0);
  });

  it("a vague request is held for review, lists what is missing, and invents nothing", async () => {
    const { deps } = makeDeps({ policy: autoPolicy });
    const r = (await processMessage(deps, SYNTHETIC_EMAILS.viewingVague)).record!;
    assert.equal(r.status, "REVIEW_REQUIRED");
    assert.ok(r.review_reasons.includes("missing_information"));
    assert.equal(r.proposed_due_at, null);
    assert.equal(r.analysis?.contact.phone, null);
  });

  it("malformed input is rejected without creating a record", async () => {
    const { deps, store, audit } = makeDeps();
    const r = await processMessage(deps, SYNTHETIC_EMAILS.invalidSender);
    assert.equal(r.outcome, "invalid_input");
    assert.equal((await store.list(10)).length, 0);
    assert.ok(audit.events.some((e) => e.event_type === "workflow_failed"));
    assert.ok(!JSON.stringify(audit.events).includes("not-an-email"));
  });
});

describe("pipeline: idempotency", () => {
  it("the same email twice is classified once and yields one record", async () => {
    const { deps, store, classifier } = makeDeps();
    const a = await processMessage(deps, viewing);
    const b = await processMessage(deps, viewing);
    assert.equal(a.outcome, "processed");
    assert.equal(b.outcome, "duplicate");
    assert.equal(classifier.calls, 1);
    assert.equal((await store.list(10)).length, 1);
  });

  it("the same message seen in a second mailbox (same Message-ID) is one item", async () => {
    const { deps, store } = makeDeps();
    await processMessage(deps, viewing);
    assert.equal((await processMessage(deps, DUPLICATE_OF_VIEWING)).outcome, "duplicate");
    assert.equal((await store.list(10)).length, 1);
  });

  it("concurrent delivery of the same email is processed once", async () => {
    const h = makeDeps({ classifier: new CountingClassifier(undefined, 10) });
    const rs = await Promise.all(Array.from({ length: 5 }, () => processMessage(h.deps, viewing)));
    assert.equal(rs.filter((r) => r.outcome === "processed").length, 1);
    assert.equal(rs.filter((r) => r.outcome === "duplicate").length, 4);
    assert.equal((h.deps.classifier as CountingClassifier).calls, 1);
  });

  it("under auto-create, a replayed email creates no second task or notification", async () => {
    const notifier = new FakeNotifier();
    const { deps, sink } = makeDeps({ policy: autoPolicy, notifier });
    sink.allowSystem = true;
    await processMessage(deps, viewing);
    await processMessage(deps, viewing);
    await processMessage(deps, DUPLICATE_OF_VIEWING);
    assert.equal(sink.tasks.size, 1);
    assert.equal(notifier.calls.length, 1);
  });

  it("even if the processing store is lost, the task backend's own idempotency prevents a duplicate task", async () => {
    const first = makeDeps({ policy: autoPolicy });
    first.sink.allowSystem = true;
    await processMessage(first.deps, viewing);
    const second = makeDeps({ policy: autoPolicy, taskSink: first.sink }); // fresh store, same backend
    await processMessage(second.deps, viewing);
    assert.equal(first.sink.tasks.size, 1);
    assert.equal(first.sink.calls, 2);
  });
});

describe("pipeline: failure handling", () => {
  it("a classifier failure is recorded as FAILED with the stage; retry succeeds without duplicating", async () => {
    let boom = true;
    const flaky: Classifier = { name: "flaky", async analyze(m) { if (boom) throw new Error("upstream 500"); return new CountingClassifier().analyze(m); } };
    const { deps, store } = makeDeps({ classifier: flaky });
    const r1 = await processMessage(deps, viewing);
    assert.equal(r1.record?.status, "FAILED");
    assert.equal(r1.record?.error?.stage, "classify");
    assert.equal((await processMessage(deps, viewing)).outcome, "duplicate", "failure is not silently retried");
    boom = false;
    const r2 = await processMessage(deps, viewing, { retryFailed: true });
    assert.equal(r2.record?.status, "REVIEW_REQUIRED");
    assert.equal((await store.list(10)).length, 1);
  });

  it("unknown errors are reduced to a generic message (no internals leaked)", async () => {
    const leaky: Classifier = { name: "leaky", async analyze() { throw new TypeError("Cannot read properties of undefined (reading 'secret') at C:\\app\\key.ts"); } };
    const { deps } = makeDeps({ classifier: leaky });
    const r = await processMessage(deps, viewing);
    assert.equal(r.record?.error?.message, "unexpected internal error");
  });

  it("a failing audit sink never breaks processing", async () => {
    const { deps } = makeDeps({ audit: { record: async () => { throw new Error("audit down"); } } });
    assert.equal((await processMessage(deps, viewing)).record?.status, "REVIEW_REQUIRED");
  });
});

describe("pipeline: opt-in automatic creation (policy low_risk, verified domain)", () => {
  it("creates a task through the system actor and notifies the rule-based owner", async () => {
    const notifier = new FakeNotifier();
    const { deps, sink } = makeDeps({ policy: autoPolicy, notifier });
    sink.allowSystem = true;
    const r = (await processMessage(deps, viewing)).record!;
    assert.equal(r.status, "NOTIFICATION_SENT");
    assert.equal(sink.tasks.size, 1);
    assert.deepEqual(notifier.calls, [{ owner_id: MEMBER_A.id, task_id: r.task_id! }]);
  });

  it("never claims a notification that was not sent", async () => {
    const un = makeDeps({ policy: autoPolicy, notifier: new UnconfiguredNotifier() });
    un.sink.allowSystem = true;
    const r1 = (await processMessage(un.deps, viewing)).record!;
    assert.equal(r1.status, "TASK_CREATED");
    assert.equal(r1.notification.sent, false);
    const none = makeDeps({ policy: autoPolicy });
    none.sink.allowSystem = true;
    const r2 = (await processMessage(none.deps, viewing)).record!;
    assert.equal(r2.status, "TASK_CREATED");
    assert.match(r2.notification.detail, /not configured/);
    const failing = makeDeps({ policy: autoPolicy, notifier: new FakeNotifier({ sent: false, detail: "smtp refused" }) });
    failing.sink.allowSystem = true;
    assert.equal((await processMessage(failing.deps, viewing)).record!.status, "TASK_CREATED");
  });

  it("if the backend does not permit system creation, the item falls back to human review", async () => {
    const { deps, sink } = makeDeps({ policy: autoPolicy }); // allowSystem=false
    const r = (await processMessage(deps, viewing)).record!;
    assert.equal(r.status, "REVIEW_REQUIRED");
    assert.ok(r.review_reasons.includes("auto_create_denied"));
    assert.equal(sink.tasks.size, 0);
  });

  it("auto-create is off by default even for a perfect email from a verified domain", async () => {
    const { deps, sink } = makeDeps({ policy: { verified_sender_domains: ["example.test"], min_confidence: 0.6 } });
    sink.allowSystem = true;
    assert.equal((await processMessage(deps, viewing)).record?.status, "REVIEW_REQUIRED");
    assert.equal(sink.calls, 0);
  });
});

describe("audit trail", () => {
  it("records each step in dashboard event types, content-free, tied to the dedupe key", async () => {
    const { deps, audit } = makeDeps({ notifier: new FakeNotifier() });
    const { record } = await processMessage(deps, viewing);
    await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    const types = audit.events.map((e) => e.event_type);
    for (const t of ["email_received", "message_classified", "potential_task_identified", "task_created", "notification_sent"]) assert.ok(types.includes(t as never), t);
    const dump = JSON.stringify(audit.events);
    assert.ok(!dump.includes("+1 555 010 4477"), "no phone numbers in audit");
    assert.ok(!dump.includes("Hello, my name is"), "no email body in audit");
    assert.ok(audit.events.every((e) => e.dedupe_key === record!.dedupe_key));
  });
});

describe("batch ingestion from a provider", () => {
  const batch: RawEmail[] = [viewing, DUPLICATE_OF_VIEWING, SYNTHETIC_EMAILS.spam, SYNTHETIC_EMAILS.invalidSender, SYNTHETIC_EMAILS.invoice];

  it("processes a synthetic provider with per-message isolation and honest counts", async () => {
    const { deps } = makeDeps();
    const s = await ingestFromProvider(deps, new SyntheticEmailProvider(batch), null, 10);
    assert.deepEqual({ p: s.processed, d: s.duplicates, i: s.invalid, f: s.failed }, { p: 3, d: 1, i: 1, f: 0 });
    assert.equal(s.nextCursor, null);
  });

  it("pages with an opaque cursor", async () => {
    const { deps } = makeDeps();
    const p = new SyntheticEmailProvider(batch);
    const a = await ingestFromProvider(deps, p, null, 2);
    assert.equal(a.nextCursor, "2");
    const b = await ingestFromProvider(deps, p, a.nextCursor, 10);
    assert.equal(b.nextCursor, null);
  });

  it("an unconfigured real provider is skipped, never reported as connected, and nothing is fetched", async () => {
    const { deps, store } = makeDeps();
    const s = await ingestFromProvider(deps, new UnconfiguredEmailProvider("microsoft_graph"), null);
    assert.equal(s.skipped, "provider_not_connected");
    assert.equal((await store.list(10)).length, 0);
    assert.equal((await new UnconfiguredEmailProvider("gmail").connection()).status, "pending_setup");
    assert.equal((await new SyntheticEmailProvider([]).connection()).synthetic, true);
  });

  it("one failing message does not stop the rest", async () => {
    let n = 0;
    const flaky: Classifier = { name: "flaky", async analyze(m) { if (++n === 1) throw new Error("x"); return new CountingClassifier().analyze(m); } };
    const { deps } = makeDeps({ classifier: flaky });
    const s = await ingestFromProvider(deps, new SyntheticEmailProvider([viewing, SYNTHETIC_EMAILS.spam]), null);
    assert.equal(s.failed, 1);
    assert.equal(s.processed, 1);
  });
});
