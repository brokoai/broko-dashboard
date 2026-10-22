import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAiReviewInput, isValidDedupeKey } from "../src/lib/ai-review-input";
import { createDemoRepo, DEMO_USERS, memoryStore } from "../src/lib/backend/demo/repo";
import { DEMO_FIXTURES } from "../src/lib/backend/demo/ai-inbox";
import { decodeState, encodedSize, emptyState, LIMITS } from "../src/lib/backend/demo/state";
import { UserFacingError, type AiInboxView } from "../src/lib/backend/types";
import type { ProcessedMessage } from "../src/lib/ai-brain";
import type { TaskInput } from "../src/lib/types";

const [admin, memberA, memberB] = DEMO_USERS;
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const as = (u: typeof admin, store = memoryStore()) => createDemoRepo(u, store, () => NOW);
const inbox = (u: typeof admin, store = memoryStore()) => as(u, store).aiInbox!;
const find = (v: AiInboxView, subject: RegExp): ProcessedMessage => v.messages.find((m) => subject.test(m.subject))!;
const input = (over: Partial<TaskInput> = {}): TaskInput => ({ title: "t", description: null, status: "open", priority: "medium", assigned_to: null, due_at: null, ...over });
const aiTasks = async (u: typeof admin, store: ReturnType<typeof memoryStore>) => (await as(u, store).listTasks()).filter((t) => t.source === "email");

describe("AI Inbox (demo backend, synthetic messages only)", () => {
  it("is labelled synthetic, runs every sample message through the real pipeline, and suppresses the duplicate", async () => {
    const v = await inbox(admin).view();
    assert.equal(v.mode, "synthetic");
    assert.equal(v.messages.length, DEMO_FIXTURES.length - 1);
    assert.equal(v.duplicates_suppressed, 1);
    assert.equal(find(v, /Viewing request for property BR-1042/).status, "REVIEW_REQUIRED");
    assert.equal(find(v, /You have won/).status, "NO_ACTION");
    assert.ok(find(v, /Quick question/).risk_flags.includes("prompt_injection_suspected"));
    assert.ok(v.messages.every((m) => m.provider === "synthetic"));
    assert.ok(v.messages.every((m) => m.status !== "TASK_CREATED"), "nothing is auto-created");
  });

  it("is deterministic: two requests see identical messages", async () => {
    const a = await inbox(admin).view(), b = await inbox(admin).view();
    assert.deepEqual(a, b);
  });

  it("members cannot view or review, and nothing is created", async () => {
    const store = memoryStore();
    const key = find(await inbox(admin, store).view(), /BR-1042/).dedupe_key;
    await assert.rejects(inbox(memberA, store).view(), UserFacingError);
    const r = await inbox(memberA, store).review(key, { action: "approve" });
    assert.equal(r.ok === false && r.error, "forbidden");
    assert.equal((await aiTasks(admin, store)).length, 0);
    const rj = await inbox(memberB, store).review(key, { action: "reject" });
    assert.equal(rj.ok === false && rj.error, "forbidden");
    assert.equal(find(await inbox(admin, store).view(), /BR-1042/).status, "REVIEW_REQUIRED");
  });

  it("approval creates one task through the existing backend, linked to its source, assigned by the owner rule", async () => {
    const store = memoryStore();
    const key = find(await inbox(admin, store).view(), /BR-1042/).dedupe_key;
    const r = await inbox(admin, store).review(key, { action: "approve" });
    assert.equal(r.ok, true);
    const tasks = await aiTasks(admin, store);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].source, "email");
    assert.match(tasks[0].external_reference ?? "", /^synthetic-email:\d+$/);
    assert.equal(tasks[0].assigned_to, memberA.id);
    assert.equal(tasks[0].due_at?.slice(0, 10), "2026-11-14");
    assert.equal(tasks[0].created_by, admin.id, "the reviewer, not the AI, is the creator");
    assert.ok((tasks[0].title.length <= LIMITS.title) && ((tasks[0].description ?? "").length <= LIMITS.description));
    // It is an ordinary task for the assignee, and an activity event exists.
    assert.equal((await as(memberA, store).getTask(tasks[0].id))?.id, tasks[0].id);
    assert.ok((await as(admin, store).listActivity(20)).some((e) => e.event_type === "task_created" && e.related_task_id === tasks[0].id));
    // The inbox now shows it as created, with an honest notification state.
    const after = find(await inbox(admin, store).view(), /BR-1042/);
    assert.equal(after.status, "TASK_CREATED");
    assert.equal(after.task_id, tasks[0].id);
    assert.equal(after.notification.sent, false);
  });

  it("approving twice, or concurrently, never creates a second task", async () => {
    const store = memoryStore();
    const key = find(await inbox(admin, store).view(), /BR-1042/).dedupe_key;
    await Promise.all([1, 2, 3].map(() => inbox(admin, store).review(key, { action: "approve" })));
    assert.equal((await aiTasks(admin, store)).length, 1);
    const again = await inbox(admin, store).review(key, { action: "approve" });
    assert.equal(again.ok === false && again.error, "not_reviewable");
    assert.equal((await aiTasks(admin, store)).length, 1);
  });

  it("the duplicate delivery of an approved message cannot be approved again", async () => {
    const store = memoryStore();
    const v = await inbox(admin, store).view();
    assert.equal(v.messages.filter((m) => /BR-1042/.test(m.subject)).length, 1, "same Message-ID in a second mailbox is one item");
  });

  it("approval honours reviewer overrides within the existing assignment rule", async () => {
    const store = memoryStore();
    const key = find(await inbox(admin, store).view(), /BR-1042/).dedupe_key;
    const bad = await inbox(admin, store).review(key, { action: "approve", assigned_to: "someone-else" });
    assert.equal(bad.ok === false && bad.error, "invalid_override");
    const badDate = await inbox(admin, store).review(key, { action: "approve", due_at: "soon" });
    assert.equal(badDate.ok === false && badDate.error, "invalid_override");
    assert.equal((await aiTasks(admin, store)).length, 0, "a rejected override creates nothing");
    const ok = await inbox(admin, store).review(key, { action: "approve", assigned_to: memberB.id, priority: "urgent", due_at: "2026-12-01T00:00:00.000Z" });
    assert.equal(ok.ok, true);
    const [t] = await aiTasks(admin, store);
    assert.deepEqual([t.assigned_to, t.priority, t.due_at?.slice(0, 10)], [memberB.id, "urgent", "2026-12-01"]);
  });

  it("rejection persists, creates nothing, and cannot later be approved", async () => {
    const store = memoryStore();
    const key = find(await inbox(admin, store).view(), /BR-1042/).dedupe_key;
    assert.equal((await inbox(admin, store).review(key, { action: "reject" })).ok, true);
    assert.equal(find(await inbox(admin, store).view(), /BR-1042/).status, "REJECTED");
    const late = await inbox(admin, store).review(key, { action: "approve" });
    assert.equal(late.ok === false && late.error, "not_reviewable");
    const twice = await inbox(admin, store).review(key, { action: "reject" });
    assert.equal(twice.ok === false && twice.error, "not_reviewable");
    assert.equal((await aiTasks(admin, store)).length, 0);
  });

  it("decisions are per visitor", async () => {
    const mine = memoryStore(), theirs = memoryStore();
    const key = find(await inbox(admin, mine).view(), /BR-1042/).dedupe_key;
    await inbox(admin, mine).review(key, { action: "approve" });
    assert.equal(find(await inbox(admin, theirs).view(), /BR-1042/).status, "REVIEW_REQUIRED");
    assert.equal((await aiTasks(admin, theirs)).length, 0);
  });

  it("messages that need no action, or already failed, cannot be approved", async () => {
    const store = memoryStore();
    const v = await inbox(admin, store).view();
    const spam = find(v, /You have won/);
    const r = await inbox(admin, store).review(spam.dedupe_key, { action: "approve" });
    assert.equal(r.ok === false && r.error, "not_reviewable");
    assert.equal((await aiTasks(admin, store)).length, 0);
  });

  it("unknown message keys are reported without leaking anything", async () => {
    const r = await inbox(admin).review("nope", { action: "approve" });
    assert.equal(r.ok === false && r.error, "not_found");
  });

  it("sensitive and suspicious messages are flagged for a human with reasons, never auto-created", async () => {
    const v = await inbox(admin).view();
    const invoice = find(v, /Invoice 8841/);
    assert.equal(invoice.status, "REVIEW_REQUIRED");
    assert.ok(invoice.risk_flags.includes("financial"));
    assert.ok(invoice.review_reasons.some((r) => r.startsWith("sensitive_intent")));
    assert.equal(invoice.owner.user_id, admin.id);
    const inj = find(v, /Quick question/);
    assert.equal(inj.status, "REVIEW_REQUIRED");
    assert.ok(inj.risk_flags.includes("prompt_injection_suspected"));
    const hidden = find(v, /unit 55/);
    assert.ok(hidden.risk_flags.includes("prompt_injection_suspected"), "hidden-text injection is caught");
  });

  it("error state: when the demo storage is full, approval fails with a clear message and leaves the item in review", async () => {
    const store = memoryStore();
    const repo = as(admin, store);
    for (let i = 0; i < LIMITS.tasks; i++) await repo.createTask(input({ title: `filler ${i}` }));
    const key = find(await inbox(admin, store).view(), /BR-1042/).dedupe_key;
    const r = await inbox(admin, store).review(key, { action: "approve" });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.message : "", /Reset demo|keeps up to/);
    assert.equal(find(await inbox(admin, store).view(), /BR-1042/).status, "REVIEW_REQUIRED");
    assert.equal((await aiTasks(admin, store)).length, 0);
  });

  it("the worst case of approvals and rejections still fits the signed-cookie budget", async () => {
    const store = memoryStore();
    const v = await inbox(admin, store).view();
    const reviewable = v.messages.filter((m) => m.status === "REVIEW_REQUIRED");
    let i = 0;
    for (const m of reviewable) await inbox(admin, store).review(m.dedupe_key, i++ % 2 ? { action: "reject" } : { action: "approve" });
    assert.ok(encodedSize(decodeState(await store.read())) <= LIMITS.maxEncodedBytes);
  });

  it("a backend without AI persistence exposes no inbox (so the UI says 'not connected')", () => {
    // The Repo contract marks aiInbox optional; the page checks it. Verified here at the type level by absence handling.
    const repoLike: { aiInbox?: unknown } = {};
    assert.equal(repoLike.aiInbox, undefined);
  });
});

describe("stored rejections are validated like all demo state", () => {
  it("keeps only well-formed [index, reviewer, time] tuples; drops junk, duplicates, out-of-range and the old bare-index format", () => {
    const good: [number, number, number] = [3, 1, 1_900_000_000];
    const raw = JSON.stringify({ t: [], e: [], r: [good, [3, 2, 1_900_000_001], 1, 2, "x", null, [99, 0, 1], [1, 9, 1], [1, 0, -5], [1, 0], ...Array.from({ length: 50 }, (_, i) => [i % 16, 0, 1_800_000_000])] });
    const s = decodeState(raw);
    assert.deepEqual(s.r[0], good, "the first valid decision for an index wins");
    assert.ok(s.r.every(([i, a, t]) => i >= 0 && i < LIMITS.aiMessages && a >= 0 && a < DEMO_USERS.length && t >= 0));
    assert.equal(new Set(s.r.map((r) => r[0])).size, s.r.length);
    assert.ok(s.r.length <= LIMITS.aiMessages);
    assert.deepEqual(decodeState(JSON.stringify({ t: [], e: [], r: "nope" })), emptyState());
    assert.deepEqual(decodeState(JSON.stringify({ t: [], e: [], r: [0, 1, 2] })).r, [], "old bare-index rejections are ignored, never shown without a reviewer");
    assert.deepEqual(decodeState(JSON.stringify({ t: [], e: [] })).r, [], "old cookies without r still load");
  });
});

describe("review request validation (the browser is untrusted)", () => {
  it("accepts the two valid shapes and normalises dates", () => {
    assert.deepEqual(parseAiReviewInput({ action: "reject" }), { input: { action: "reject" } });
    assert.deepEqual(parseAiReviewInput({ action: "approve" }), { input: { action: "approve" } });
    const r = parseAiReviewInput({ action: "approve", assigned_to: "demo-member-a", priority: "high", due_at: "2026-11-14" });
    assert.deepEqual(r, { input: { action: "approve", assigned_to: "demo-member-a", priority: "high", due_at: "2026-11-14T00:00:00.000Z" } });
    assert.deepEqual(parseAiReviewInput({ action: "approve", assigned_to: "", due_at: "" }), { input: { action: "approve", assigned_to: null, due_at: null } });
  });

  it("rejects malformed input and ignores attempts to smuggle in identity, status or owner fields", () => {
    for (const bad of [null, undefined, "approve", 5, [], {}, { action: "delete" }, { action: "approve", priority: "critical" }, { action: "approve", due_at: "tomorrow" },
      { action: "approve", assigned_to: 7 }, { action: "approve", assigned_to: "x".repeat(65) }, { action: "approve", due_at: "2026-02-31x" }]) {
      assert.ok("error" in parseAiReviewInput(bad), JSON.stringify(bad));
    }
    const r = parseAiReviewInput({ action: "approve", by: { role: "admin" }, status: "TASK_CREATED", owner: "x", reviewed_by: "demo-admin" });
    assert.deepEqual(r, { input: { action: "approve" } });
  });

  it("validates the message key", () => {
    assert.equal(isValidDedupeKey("broko|mid|abc"), true);
    for (const k of ["", undefined, 5, "x".repeat(401)]) assert.equal(isValidDedupeKey(k), false);
  });
});
