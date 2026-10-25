import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CachingClassifier, FallbackClassifier, LlmClassifier, RuleBasedClassifier, SYNTHETIC_EMAILS, SYNTHETIC_NOW,
  loadAiBrainConfig, normalizeEmail, processMessage, selectClassifier, type LlmTransport,
} from "../src/lib/ai-brain";
import { DEMO_FIXTURES } from "../src/lib/backend/demo/ai-inbox";
import { createDemoAiRuntime } from "../src/lib/backend/demo/ai-runtime";
import { createDemoRepo, DEMO_USERS, memoryStore } from "../src/lib/backend/demo/repo";
import { makeClock, settle } from "./ai-worker-helpers";
import type { AiInboxView } from "../src/lib/backend/types";
import type { AiMessageView } from "../src/lib/ai-brain";
import { makeDeps } from "./ai-brain-helpers";

const [admin, memberA] = DEMO_USERS;
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const SECRET = "sk-ant-TEST-ONLY-NOT-A-REAL-KEY";

/** A fake model: valid, schema-conformant output for any email (no network). */
const analysisFor = (prompt: string) => ({
  requires_action: !/won the lottery/i.test(prompt), intent: /viewing/i.test(prompt) ? "viewing_request" : /won the lottery/i.test(prompt) ? "spam_or_irrelevant" : "other",
  summary: "Model summary", requested_action: "Follow up", urgency: "normal", urgency_evidence: null, confidence: 0.9,
  contact: { name: null, email: null, phone: null }, property_reference: null, requested_date: null, missing_information: [], risk_flags: [],
  proposed_task: { title: "Follow up with sender", description: "x" }, clarification_question: null,
});
function fakeModel(over: (prompt: string) => unknown = analysisFor) {
  const state = { calls: 0 };
  const transport: LlmTransport = async ({ user }) => { state.calls++; return JSON.stringify(over(user)); };
  return { transport, state };
}
const cfg = (env: Record<string, string> = {}) => loadAiBrainConfig({ BROKO_AI_CLASSIFIER: "llm", ANTHROPIC_API_KEY: SECRET, ...env });
const msg = (k: keyof typeof SYNTHETIC_EMAILS = "viewingComplete") => normalizeEmail(SYNTHETIC_EMAILS[k], { now: SYNTHETIC_NOW }).message;

describe("classifier selection is explicit and safe by default", () => {
  it("defaults to the rule-based classifier and calls no model", () => {
    const sel = selectClassifier(loadAiBrainConfig({}));
    assert.deepEqual([sel.mode, sel.model, sel.note], ["rules", null, null]);
    assert.equal(selectClassifier(loadAiBrainConfig({ ANTHROPIC_API_KEY: SECRET })).mode, "rules", "a key alone does not switch the model on");
  });

  it("an invalid mode value is ignored (strictest behaviour) and reported without echoing it", () => {
    const c = loadAiBrainConfig({ BROKO_AI_CLASSIFIER: "gpt-everything", ANTHROPIC_API_KEY: SECRET });
    assert.equal(c.classifier, "rules");
    assert.ok(c.problems.length === 1 && !c.problems.join(" ").includes("gpt-everything"));
  });

  it("requesting the model without a key falls back to rules and says so", () => {
    const sel = selectClassifier(loadAiBrainConfig({ BROKO_AI_CLASSIFIER: "llm" }));
    assert.equal(sel.mode, "rules");
    assert.match(sel.note ?? "", /no API key is configured/);
  });

  it("model mode needs both settings, names the model, and never exposes the key", () => {
    const sel = selectClassifier(cfg({ BROKO_AI_MODEL: "claude-haiku-5-5" }));
    assert.deepEqual([sel.mode, sel.model], ["llm", "claude-haiku-5-5"]);
    assert.ok(!JSON.stringify({ ...sel, classifier: sel.classifier.name }).includes(SECRET));
  });
});

describe("model with rule-based fallback", () => {
  const rules = new RuleBasedClassifier();
  const build = (transport: LlmTransport, now = () => 0, cooldownMs = 1000) => new FallbackClassifier(new LlmClassifier(transport, "llm:test"), rules, { now, cooldownMs });

  it("uses the model when its output is valid", async () => {
    const r = await build(fakeModel().transport).analyzeDetailed(msg());
    assert.deepEqual(r.info, { name: "llm:test", mode: "llm", fallback_reason: null });
  });

  it("falls back, and says why, when the model returns invalid JSON", async () => {
    const r = await build(async () => "I'm sorry, I can't help with that.").analyzeDetailed(msg());
    assert.deepEqual([r.info.mode, r.info.fallback_reason], ["rules", "model_output_invalid"]);
  });

  it("falls back when the JSON breaks the schema, including attempts to name an owner or approve", async () => {
    for (const bad of [{ ...analysisFor("viewing"), owner_id: "demo-admin" }, { ...analysisFor("viewing"), approved: true }, { ...analysisFor("viewing"), intent: "hack" }, { ...analysisFor("viewing"), confidence: 9 }]) {
      const r = await build(fakeModel(() => bad).transport).analyzeDetailed(msg());
      assert.equal(r.info.fallback_reason, "model_output_invalid", JSON.stringify(bad).slice(0, 40));
      assert.equal(r.info.mode, "rules");
    }
  });

  it("falls back on an API failure without leaking the key or the error text, then skips the model during the cooldown", async () => {
    let t = 0, calls = 0;
    const c = build(async () => { calls++; throw new Error(`401 x-api-key ${SECRET}`); }, () => t, 1000);
    const a = await c.analyzeDetailed(msg());
    assert.equal(a.info.fallback_reason, "model_unavailable");
    assert.ok(!JSON.stringify(a).includes(SECRET));
    await c.analyzeDetailed(msg("invoice"));
    assert.equal(calls, 1, "no further calls during the cooldown");
    t = 1500;
    await c.analyzeDetailed(msg("spam"));
    assert.equal(calls, 2, "the model is tried again after the cooldown");
  });

  it("an invalid answer is not an outage: the next message still gets the model", async () => {
    let calls = 0;
    const c = build(async () => { calls++; return "nope"; });
    await c.analyzeDetailed(msg()); await c.analyzeDetailed(msg("invoice"));
    assert.equal(calls, 2);
  });

  it("the pipeline records which classifier produced each analysis", async () => {
    const h = makeDeps({ classifier: build(async () => "garbage") });
    const r = await processMessage(h.deps, SYNTHETIC_EMAILS.viewingComplete);
    assert.deepEqual(r.record?.classifier, { name: "rule-based", mode: "rules", fallback_reason: "model_output_invalid" });
    assert.equal(r.record?.status, "REVIEW_REQUIRED", "a fallback result still needs a human");
    const plain = await processMessage(makeDeps().deps, SYNTHETIC_EMAILS.viewingComplete);
    assert.equal(plain.record?.classifier?.mode, "rules");
    assert.equal(plain.record?.classifier?.fallback_reason, null);
  });
});

describe("result cache", () => {
  it("does not repeat a paid call for the same message content, and is bounded", async () => {
    const f = fakeModel();
    let t = 0;
    const c = new CachingClassifier(new FallbackClassifier(new LlmClassifier(f.transport, "m")), { now: () => t, ttlMs: 1000, max: 2 });
    await c.analyze(msg()); await c.analyze(msg());
    assert.equal(f.state.calls, 1);
    await c.analyze(msg("invoice")); await c.analyze(msg("legal")); // evicts the oldest
    await c.analyze(msg());
    assert.equal(f.state.calls, 4);
    t = 5000; await c.analyze(msg());
    assert.equal(f.state.calls, 5, "expired entries are refreshed");
  });
});

describe("AI Inbox with the model classifier (fake transport; no network)", () => {
  const find = (v: AiInboxView, re: RegExp): AiMessageView => v.messages.find((m) => re.test(m.subject))!;
  const setup = async (over?: (p: string) => unknown, env?: Record<string, string>) => {
    const f = fakeModel(over);
    const selection = selectClassifier(cfg(env), { transport: f.transport });
    const store = memoryStore();
    const inbox = (u: typeof admin) => createDemoRepo(u, store, () => NOW, { classifier: selection }).aiInbox!;
    await inbox(admin).process(); // the background worker classifies; the page only reads
    return { f, inbox, store, selection };
  };

  it("states the active mode, classifies each unique message once, and does not classify the duplicate delivery", async () => {
    const { f, inbox } = await setup();
    const v = await inbox(admin).view();
    assert.deepEqual(v.classifier, { mode: "llm", model: "claude-haiku-5-5", note: null });
    assert.equal(f.state.calls, DEMO_FIXTURES.length - 1, "one model call per unique message");
    assert.equal(v.duplicates_suppressed, 1);
    assert.ok(v.messages.every((m) => m.classifier?.mode === "llm" && m.classifier.fallback_reason === null));
    const calls = f.state.calls;
    await inbox(admin).view();
    assert.equal(f.state.calls, calls, "a repeat page view makes no further model calls");
  });

  it("model output cannot create tasks or approve: everything still waits for a person", async () => {
    const { inbox, store } = await setup();
    const v = await inbox(admin).view();
    assert.ok(v.messages.every((m) => !["TASK_CREATED", "NOTIFICATION_SENT", "APPROVED"].includes(m.status)));
    assert.equal((await createDemoRepo(admin, store, () => NOW).listTasks()).filter((t) => t.source === "email").length, 0);
  });

  it("owners come from the configured rules, even when the model tries to name one", async () => {
    const hijack = (p: string) => ({ ...analysisFor(p), owner_id: "demo-admin", assigned_to: "demo-admin", approved: true });
    const { inbox } = await setup(hijack);
    const v = await inbox(admin).view();
    const viewing = find(v, /BR-1042/);
    assert.equal(viewing.classifier?.fallback_reason, "model_output_invalid");
    assert.equal(viewing.owner.user_id, memberA.id);
    assert.ok(viewing.owner.reason.length > 0 && !("rule_id" in viewing.owner), "the rule id is internal configuration and not exposed");
    assert.equal(viewing.status, "REVIEW_REQUIRED");
  });

  it("when the model API is down, jobs retry with backoff, then fall back to the rules visibly; the API is not hammered", async () => {
    const f = { calls: 0 };
    const selection = selectClassifier(cfg(), { transport: async () => { f.calls++; throw new Error(`down ${SECRET}`); } });
    const clock = makeClock();
    const rt = createDemoAiRuntime(selection, { now: clock.now, jitter: () => 1, config: { backoffBaseMs: 1_000, backoffCapMs: 1_000, modelCooldownMs: 500 } });
    const repo = createDemoRepo(admin, memoryStore(), () => NOW, { classifier: selection, runtime: rt }).aiInbox!;
    await repo.view();
    await rt.drain();
    const mid = await repo.view();
    assert.equal(mid.messages.length, 0, "nothing is classified yet: the jobs are waiting to retry");
    assert.ok(mid.jobs.every((j) => j.status === "retry_wait" || j.status === "queued"));
    await settle(rt, clock);
    const v = await repo.view();
    assert.equal(v.classifier.mode, "llm");
    assert.ok(v.messages.length > 0 && v.messages.every((m) => m.classifier?.fallback_reason === "model_unavailable" && m.classifier.mode === "rules"));
    assert.ok(v.messages.every((m) => m.status === "REVIEW_REQUIRED" || m.status === "NO_ACTION"), "a fallback result is never an approval");
    assert.ok(v.queue.failed === 0 && v.queue.completed === DEMO_FIXTURES.length);
    assert.ok(!JSON.stringify(v).includes(SECRET));
    assert.ok(f.calls < DEMO_FIXTURES.length, `the shared circuit breaker stops every job hitting a dead API (${f.calls} calls)`);
  });

  it("the prompt-injection email stays flagged for review even when the model 'cooperates'", async () => {
    const { inbox } = await setup();
    const m = find(await inbox(admin).view(), /Quick question/);
    assert.equal(m.status, "REVIEW_REQUIRED");
    assert.ok(m.risk_flags.includes("prompt_injection_suspected"));
  });

  it("approval still works end to end and is applied to the right message despite concurrent classification", async () => {
    const { inbox, store } = await setup();
    const key = find(await inbox(admin).view(), /BR-1042/).review_id;
    assert.equal((await inbox(admin).review(key, { action: "approve" })).ok, true);
    assert.equal((await inbox(admin).review(key, { action: "approve" })).ok, false, "a second approval is refused");
    const tasks = (await createDemoRepo(admin, store, () => NOW).listTasks()).filter((t) => t.source === "email");
    assert.equal(tasks.length, 1);
    const after = await inbox(admin).view();
    assert.equal(find(after, /BR-1042/).status, "TASK_CREATED");
    assert.equal(after.messages.filter((m) => m.status === "TASK_CREATED").length, 1);
  });

  it("rejection works in model mode", async () => {
    const { inbox } = await setup();
    const key = find(await inbox(admin).view(), /Invoice 8841/).review_id;
    assert.equal((await inbox(admin).review(key, { action: "reject" })).ok, true);
    assert.equal(find(await inbox(admin).view(), /Invoice 8841/).status, "REJECTED");
  });

  it("members cannot trigger classification, processing, requeue or reviews: zero model calls", async () => {
    const f = fakeModel();
    const selection = selectClassifier(cfg(), { transport: f.transport });
    const repo = createDemoRepo(memberA, memoryStore(), () => NOW, { classifier: selection }).aiInbox!;
    await assert.rejects(repo.view());
    await assert.rejects(repo.process());
    await assert.rejects(repo.requeue("x"));
    const r = await repo.review("broko|mid|viewing-1@example.test", { action: "approve" });
    assert.equal(r.ok === false && r.error, "forbidden");
    assert.equal(f.state.calls, 0);
  });

  it("rule-based mode (default) makes no model calls and says so", async () => {
    const f = fakeModel();
    const selection = selectClassifier(loadAiBrainConfig({ ANTHROPIC_API_KEY: SECRET }), { transport: f.transport });
    const repo = createDemoRepo(admin, memoryStore(), () => NOW, { classifier: selection }).aiInbox!;
    await repo.process();
    const v = await repo.view();
    assert.deepEqual(v.classifier, { mode: "rules", model: null, note: null });
    assert.equal(f.state.calls, 0);
    assert.ok(v.messages.every((m) => m.classifier?.mode === "rules"));
  });
});
