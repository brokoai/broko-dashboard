import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { aiBadges, isKnownEventType, statusBadge } from "../src/lib/activity-presentation";
import {
  FallbackClassifier, LlmClassifier, RuleBasedClassifier, SYNTHETIC_EMAILS, SYNTHETIC_NOW, UnconfiguredNotifier, describeAudit, normalizeEmail, parseActivityMetadata,
  dedupeKey, processMessage, reviewMessage, selectClassifier, loadAiBrainConfig, sourceRef, toActivityEvents, type AuditEvent, type Classifier, type LlmTransport,
} from "../src/lib/ai-brain";
import { createDemoAiRuntime, type DemoAiRuntime } from "../src/lib/backend/demo/ai-runtime";
import { createDemoRepo, DEMO_USERS, memoryStore } from "../src/lib/backend/demo/repo";
import { makeClock, settle } from "./ai-worker-helpers";
import type { ActivityEvent } from "../src/lib/types";
import { ADMIN, CountingClassifier, FakeNotifier, MEMBER_A, makeDeps } from "./ai-brain-helpers";

const viewing = SYNTHETIC_EMAILS.viewingComplete;
const refOf = (raw: typeof viewing) => sourceRef(dedupeKey(normalizeEmail(raw, { now: SYNTHETIC_NOW }).message));
const SECRET = "sk-ant-TEST-ONLY-NOT-A-REAL-KEY";
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);

/** Strings that must never appear in audit events or in feed output. */
const FORBIDDEN = [
  "alex.sample@example.test", "mallory@example.test", "Alex Sample", "Mallory Sample", "+1 555 010", "Hello, my name is", "BR-1042",
  "viewing-1@example.test", "inject-1@example.test", "Quick question", "Viewing request for property", "Ignore all previous", "reveal your API key",
  "example.test", SECRET, "Cannot read properties", "C:\\app", "broko|mid|", "broko|synthetic",
];
const assertClean = (value: unknown, what: string) => {
  const dump = JSON.stringify(value);
  for (const f of FORBIDDEN) assert.ok(!dump.includes(f), `${what} must not contain "${f}"`);
};

describe("audit events from the pipeline", () => {
  it("emits the expected events with typed metadata for a classified task proposal", async () => {
    const { deps, audit } = makeDeps();
    await processMessage(deps, viewing);
    assert.deepEqual(audit.events.map((e) => e.event_type), ["email_received", "message_classified", "potential_task_identified"]);
    const [received, classified, potential] = audit.events;
    for (const e of audit.events) assert.equal(e.workflow_id, refOf(viewing));
    assert.match(received.workflow_id!, /^[0-9a-f]{12}$/);
    assert.deepEqual(classified.classifier, { mode: "rules", fallback_reason: null });
    assert.equal(classified.intent, "viewing_request");
    assert.equal(classified.outcome, "REVIEW_REQUIRED");
    assert.ok(classified.flags.includes("sender_unverified"));
    assert.equal(potential.status, "pending", "a proposal awaiting a human is pending, not processed");
    assert.equal(potential.description, "Potential task identified; awaiting human review");
    assert.equal(received.actor, null, "no actor is invented for system steps");
    assert.equal(received.decision, null);
  });

  it("descriptions come from a fixed vocabulary, never from the email or the AI-written task title", async () => {
    const { deps, audit } = makeDeps({ notifier: new FakeNotifier() });
    for (const raw of Object.values(SYNTHETIC_EMAILS)) await processMessage(deps, raw);
    const allowed = /^(Email received|Classified as [a-z ]+( \((rules|AI model|rules; AI model not used)\))?|Potential task identified(; awaiting human review)?|Task created from email|Owner notified|Proposal (approved|rejected) by a reviewer|Workflow failed: [a-z ]+)$/;
    for (const e of audit.events) assert.match(e.description, allowed, e.description);
  });

  it("contains no email content, addresses, ids, secrets or raw errors for any sample message, including failures", async () => {
    const leaky: Classifier = { name: "leaky", async analyze() { throw new Error(`Cannot read properties of undefined at C:\\app\\key.ts ${SECRET}`); } };
    for (const classifier of [new CountingClassifier(), leaky]) {
      const { deps, audit } = makeDeps({ classifier, notifier: new FakeNotifier() });
      for (const raw of Object.values(SYNTHETIC_EMAILS)) await processMessage(deps, raw);
      assert.ok(audit.events.length > 0);
      assertClean(audit.events, `audit events (${classifier.name})`);
    }
  });

  it("failures carry a safe category instead of error text", async () => {
    const cases: [string, Classifier, string][] = [
      ["classification", { name: "x", async analyze() { throw new Error("boom"); } }, "classification_failed"],
      ["validation", { name: "x", async analyze() { return { owner_id: "demo-admin" }; } }, "invalid_model_output"],
    ];
    for (const [name, classifier, category] of cases) {
      const { deps, audit } = makeDeps({ classifier });
      await processMessage(deps, viewing);
      const failed = audit.events.find((e) => e.event_type === "workflow_failed")!;
      assert.equal(failed.error_category, category, name);
      assert.equal(failed.outcome, "FAILED");
      assert.equal(failed.status, "failed");
    }
    const { deps, audit } = makeDeps();
    await processMessage(deps, SYNTHETIC_EMAILS.invalidSender);
    assert.deepEqual([audit.events[0].error_category, audit.events[0].workflow_id], ["invalid_input", null]);
  });

  it("records the classifier mode and why the model was bypassed", async () => {
    const down: LlmTransport = async () => { throw new Error(SECRET); };
    const { deps, audit } = makeDeps({ classifier: new FallbackClassifier(new LlmClassifier(down, "llm:test"), new RuleBasedClassifier()) });
    await processMessage(deps, viewing);
    const classified = audit.events.find((e) => e.event_type === "message_classified")!;
    assert.deepEqual(classified.classifier, { mode: "rules", fallback_reason: "model_unavailable" });
    assert.equal(classified.description, "Classified as viewing request (rules; AI model not used)");
    assertClean(audit.events, "fallback audit events");
  });
});

describe("approval and rejection attribution", () => {
  it("attributes an approval to the authenticated reviewer and records the decision as typed metadata", async () => {
    const { deps, audit } = makeDeps({ notifier: new FakeNotifier() });
    const { record } = await processMessage(deps, viewing);
    await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    const approved = audit.events.find((e) => e.decision === "approved")!;
    assert.deepEqual(approved.actor, { kind: "user", id: ADMIN.id });
    assert.equal(approved.event_type, "message_classified", "the existing taxonomy is reused; no new event type");
    assert.equal(approved.outcome, "APPROVED");
    const created = audit.events.find((e) => e.event_type === "task_created")!;
    assert.deepEqual(created.actor, { kind: "user", id: ADMIN.id });
    assert.ok(created.task_id);
  });

  it("attributes a rejection, and a rejected message never yields a task event", async () => {
    const { deps, audit } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    await reviewMessage(deps, record!.dedupe_key, { action: "reject", by: ADMIN });
    const rejected = audit.events.find((e) => e.decision === "rejected")!;
    assert.deepEqual(rejected.actor, { kind: "user", id: ADMIN.id });
    assert.ok(!audit.events.some((e) => e.event_type === "task_created"));
  });

  it("never invents a decision: refused, repeated and failed reviews add none", async () => {
    const { deps, audit } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    const before = audit.events.length;
    await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: MEMBER_A }); // forbidden
    await reviewMessage(deps, "unknown", { action: "approve", by: ADMIN });             // not found
    assert.equal(audit.events.length, before);
    await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    const n = audit.events.filter((e) => e.decision).length;
    await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });    // second approval refused
    assert.equal(audit.events.filter((e) => e.decision).length, n);
    assert.equal(n, 1);
  });

  it("automatic creation (opt-in) is attributed to the system, not to a person", async () => {
    const { deps, audit, sink } = makeDeps({ policy: { auto_create: "low_risk", verified_sender_domains: ["example.test"], min_confidence: 0.6 }, notifier: new UnconfiguredNotifier() });
    sink.allowSystem = true;
    await processMessage(deps, viewing);
    const created = audit.events.find((e) => e.event_type === "task_created")!;
    assert.equal(created.actor?.kind, "system");
    assert.equal(audit.events.some((e) => e.decision), false, "no human decision is fabricated");
  });
});

describe("duplicates and sink failures", () => {
  it("a replayed or second-mailbox delivery adds no events", async () => {
    const { deps, audit } = makeDeps();
    await processMessage(deps, viewing);
    const n = audit.events.length;
    await processMessage(deps, viewing);
    await processMessage(deps, { ...viewing, id: "other", mailboxRef: "box-2" });
    assert.equal(audit.events.length, n);
  });

  it("a failing audit sink never breaks processing or review", async () => {
    const { deps } = makeDeps({ audit: { record: async () => { throw new Error("audit down"); } } });
    const { record } = await processMessage(deps, viewing);
    assert.equal(record?.status, "REVIEW_REQUIRED");
    assert.equal((await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN })).ok, true);
  });
});

describe("mapping to the Activity feed", () => {
  const base: AuditEvent = {
    event_type: "message_classified", status: "processed", description: `Subject: ${viewing.subject} ${SECRET}`, stage: "decide", at: "2026-10-12T10:00:00.000Z",
    workflow_id: "0123456789ab", task_id: null, classifier: { mode: "llm", fallback_reason: null }, intent: "viewing_request", outcome: "REVIEW_REQUIRED",
    flags: ["sender_unverified"], error_category: null, actor: null, decision: null, attempt: null,
  };
  const map = (e: AuditEvent[]) => toActivityEvents(e, { idPrefix: "t", at: (_i, ev) => ev.at });

  it("ignores any description an emitter supplied and builds it from the typed fields", () => {
    const [ev] = map([base]);
    assert.equal(ev.description, "Classified as viewing request (AI model)");
    assertClean(ev, "feed event");
    assert.deepEqual(ev.metadata, { workflow_id: "0123456789ab", classifier_mode: "llm", fallback_reason: null, intent: "viewing_request", outcome: "REVIEW_REQUIRED", flags: ["sender_unverified"], error_category: null, decision: null, actor_kind: null });
  });

  it("does not duplicate task events: a task_created that has a task id is left to the backend's own task event", () => {
    const events = map([{ ...base, event_type: "task_created", task_id: "t1", outcome: "TASK_CREATED" }, base]);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "message_classified");
  });

  it("only exposes a user actor id (a system actor becomes null, never a made-up person)", () => {
    const [u, s] = map([{ ...base, actor: { kind: "user", id: "demo-admin" } }, { ...base, actor: { kind: "system", id: "ai-brain" } }]);
    assert.equal(u.actor_id, "demo-admin");
    assert.equal(s.actor_id, null);
  });

  it("treats database metadata as untrusted: only the exact typed shape survives", () => {
    const good = map([base])[0].metadata;
    assert.deepEqual(parseActivityMetadata(good), good);
    for (const bad of [null, undefined, {}, "x", [], { ...good, dedupe_key: "broko|mid|x" }, { ...good, workflow_id: "broko|mid|abc" }, { ...good, flags: ["made_up"] }, { ...good, decision: "maybe" }, { ...good, error_category: "Cannot read properties" }]) {
      assert.equal(parseActivityMetadata(bad), undefined, JSON.stringify(bad)?.slice(0, 50));
    }
  });

  it("describeAudit has a safe default for an unexpected event type", () => {
    assert.equal(describeAudit({ ...base, event_type: "task_assigned" as never, decision: null, classifier: null }), "AI workflow event");
  });
});

describe("Activity feed presentation", () => {
  const md = { workflow_id: "0123456789ab", classifier_mode: "llm" as const, fallback_reason: null, intent: "viewing_request", outcome: "APPROVED", flags: ["a", "b"], error_category: null, decision: "approved" as const, actor_kind: "user" as const };

  it("handles an event type or status this build does not know, without throwing", () => {
    assert.equal(isKnownEventType("brand_new_event"), false);
    assert.equal(isKnownEventType("email_received"), true);
    assert.deepEqual(statusBadge("weird"), { label: "Unknown", tone: "neutral" });
    assert.deepEqual(statusBadge("failed"), { label: "Failed", tone: "red" });
    assert.deepEqual(statusBadge("pending"), { label: "Pending", tone: "amber" });
  });

  it("shows decision, classifier and risk-flag badges for AI events and none for plain task events", () => {
    assert.deepEqual(aiBadges({ metadata: md }).map((b) => b.label), ["Approved", "AI model", "2 risk flags"]);
    assert.deepEqual(aiBadges({ metadata: { ...md, decision: "rejected", classifier_mode: "rules", fallback_reason: "model_unavailable", flags: ["a"] } }).map((b) => b.label), ["Rejected", "Rules (fallback)", "1 risk flag"]);
    assert.deepEqual(aiBadges({}), []);
  });
});

describe("demo backend Activity feed", () => {
  const [admin, memberA, memberB] = DEMO_USERS;
  const repoFor = (u: typeof admin, store = memoryStore(), now = NOW, classifier?: ReturnType<typeof selectClassifier>, runtime?: DemoAiRuntime) => createDemoRepo(u, store, () => now, { classifier, runtime });
  const aiOnly = (events: ActivityEvent[]) => events.filter((e) => e.metadata);
  // The page never classifies: events and messages exist once the background worker has processed the queue.
  before(async () => { await repoFor(admin).aiInbox!.process(); });
  const keyOf = async (store: ReturnType<typeof memoryStore>, re: RegExp) => (await repoFor(admin, store).aiInbox!.view()).messages.find((m) => re.test(m.subject))!.review_id;

  it("shows AI workflow events to administrators, content-free, with only existing event types", async () => {
    const events = await repoFor(admin).listActivity(200);
    const ai = aiOnly(events);
    assert.ok(ai.length >= 20);
    const types = new Set(ai.map((e) => e.event_type));
    for (const t of ["email_received", "message_classified", "potential_task_identified"]) assert.ok(types.has(t as never), t);
    assertClean(events, "the Activity feed");
    assert.ok(ai.every((e) => /^[0-9a-f]{12}$/.test(e.metadata!.workflow_id ?? "")));
  });

  it("is deterministic across refreshes (no randomness in regenerated events)", async () => {
    const store = memoryStore();
    const a = await repoFor(admin, store).listActivity(200), b = await repoFor(admin, store).listActivity(200);
    assert.deepEqual(a, b);
    assert.equal(new Set(a.map((e) => e.id)).size, a.length, "event ids are unique");
  });

  it("an approval appears once as a decision (the real approver and time) next to the backend's own task_created, with no duplicate", async () => {
    const store = memoryStore();
    const key = await keyOf(store, /BR-1042/);
    assert.equal((await repoFor(admin, store).aiInbox!.review(key, { action: "approve" })).ok, true);
    const events = await repoFor(admin, store).listActivity(200);
    const decisions = events.filter((e) => e.metadata?.decision === "approved");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].actor_id, admin.id);
    assert.equal(decisions[0].created_at, new Date(Math.floor(NOW / 1000) * 1000).toISOString());
    assert.ok(decisions[0].related_task_id && decisions[0].related_task_title);
    const taskCreated = events.filter((e) => e.event_type === "task_created" && e.related_task_id === decisions[0].related_task_id);
    assert.equal(taskCreated.length, 1, "exactly one task_created for the task: the backend's");
    assert.equal(taskCreated[0].metadata, undefined);
  });

  it("a rejection is attributed to the real reviewer and time", async () => {
    const store = memoryStore();
    const key = await keyOf(store, /Invoice 8841/);
    await repoFor(admin, store).aiInbox!.review(key, { action: "reject" });
    const [r] = (await repoFor(admin, store).listActivity(200)).filter((e) => e.metadata?.decision === "rejected");
    assert.equal(r.actor_id, admin.id);
    assert.equal(r.related_task_id, null);
    assert.equal(r.created_at, new Date(Math.floor(NOW / 1000) * 1000).toISOString());
  });

  it("decisions survive a refresh (same browser state) and vanish on reset or in another browser; nothing is claimed as permanent", async () => {
    const store = memoryStore();
    await repoFor(admin, store).aiInbox!.review(await keyOf(store, /BR-1042/), { action: "approve" });
    await repoFor(admin, store).aiInbox!.review(await keyOf(store, /Invoice 8841/), { action: "reject" });
    const count = async (s: typeof store) => (await repoFor(admin, s).listActivity(200)).filter((e) => e.metadata?.decision).length;
    assert.equal(await count(store), 2);
    assert.equal(await count(store), 2, "refresh");
    assert.equal(await count(memoryStore()), 0, "another visitor");
    store.value = undefined; // "Reset demo" clears the cookie
    assert.equal(await count(store), 0);
  });

  it("members see no AI pipeline events and trigger no classification; only decisions about tasks they can see", async () => {
    const store = memoryStore();
    const key = await keyOf(store, /BR-1042/); // rule: viewings -> Demo Member A
    await repoFor(admin, store).aiInbox!.review(key, { action: "approve" });
    await repoFor(admin, store).aiInbox!.review(await keyOf(store, /Invoice 8841/), { action: "reject" });
    const counting = new CountingClassifier();
    const selection = { classifier: counting, mode: "rules" as const, model: null, note: null };
    const asA = aiOnly(await repoFor(memberA, store, NOW, selection).listActivity(200));
    assert.equal(counting.calls, 0, "no classification for a member");
    assert.deepEqual(asA.map((e) => e.metadata?.decision), ["approved"], "own task's approval only; the rejection and pipeline events are hidden");
    assert.deepEqual(aiOnly(await repoFor(memberB, store, NOW, selection).listActivity(200)), []);
    assert.equal(counting.calls, 0);
  });

  it("task detail shows the approval decision for that task only", async () => {
    const store = memoryStore();
    await repoFor(admin, store).aiInbox!.review(await keyOf(store, /BR-1042/), { action: "approve" });
    const task = (await repoFor(admin, store).listTasks()).find((t) => t.source === "email")!;
    const events = await repoFor(admin, store).listTaskActivity(task.id, 20);
    assert.ok(events.some((e) => e.metadata?.decision === "approved"));
    assert.ok(events.every((e) => e.related_task_id === task.id));
    assert.deepEqual(await repoFor(memberB, store).listTaskActivity(task.id, 20), [], "a user who cannot see the task sees nothing");
  });

  it("model mode and fallback show up in the feed metadata without leaking the key or error text", async () => {
    const selection = selectClassifier(loadAiBrainConfig({ BROKO_AI_CLASSIFIER: "llm", ANTHROPIC_API_KEY: SECRET }), { transport: async () => { throw new Error(`down ${SECRET}`); } });
    const clock = makeClock();
    const rt = createDemoAiRuntime(selection, { now: clock.now, jitter: () => 1, config: { backoffBaseMs: 1_000, backoffCapMs: 1_000, modelCooldownMs: 500 } });
    const repo = repoFor(admin, memoryStore(), NOW, selection, rt);
    await repo.aiInbox!.view();
    await settle(rt, clock);
    const events = await repo.listActivity(200);
    const classified = events.filter((e) => e.metadata?.intent);
    assert.ok(classified.length > 0 && classified.every((e) => e.metadata?.fallback_reason === "model_unavailable" && e.metadata.classifier_mode === "rules"));
    const pending = events.filter((e) => e.event_type === "workflow_failed" && e.status === "pending");
    assert.ok(pending.length > 0 && pending.every((e) => /^Attempt failed, will retry: /.test(e.description)), "retried attempts are pending, not failed");
    assertClean(events, "feed with a failing model");
  });

  it("existing task events are unchanged by the AI events", async () => {
    const store = memoryStore();
    const repo = repoFor(admin, store);
    const t = await repo.createTask({ title: "Manual", description: null, status: "open", priority: "low", assigned_to: null, due_at: null });
    const mine = (await repo.listActivity(200)).filter((e) => e.related_task_id === t.id);
    assert.deepEqual(mine.map((e) => [e.event_type, e.metadata]), [["task_created", undefined]]);
  });
});
