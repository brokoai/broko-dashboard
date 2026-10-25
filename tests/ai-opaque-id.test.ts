import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { RuleBasedClassifier, isValidReviewId, reviewIdFor, toMessageView, type AiMessageView, type ProcessedMessage } from "../src/lib/ai-brain";
import { createDemoAiRuntime } from "../src/lib/backend/demo/ai-runtime";
import { createDemoRepo, DEMO_USERS, memoryStore } from "../src/lib/backend/demo/repo";
import { jobId, jobKey } from "../src/lib/ai-brain/jobs";
import { sourceRef } from "../src/lib/ai-brain/task-mapping";
import { makeClock } from "./ai-worker-helpers";

/**
 * The browser never receives, and never sends, a provider reference. It sees an opaque `review_id` and an explicit allow-list
 * of fields. Everything here runs against the in-memory demo backend (synthetic data, no mailbox).
 */
const [admin, memberA] = DEMO_USERS;
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const FORBIDDEN_KEYS = ["dedupe_key", "provider", "source_message_id", "internet_message_id", "mailbox_ref", "excerpt", "grounding_notes", "created_at", "updated_at"];

function setup() {
  const selection = { classifier: new RuleBasedClassifier(), mode: "rules" as const, model: null, note: null };
  const rt = createDemoAiRuntime(selection, { now: makeClock().now, jitter: () => 1 });
  const store = memoryStore();
  const repo = (u: typeof admin) => createDemoRepo(u, store, () => NOW, { classifier: selection, runtime: rt }).aiInbox!;
  return { rt, repo };
}
const find = (v: { messages: AiMessageView[] }, re: RegExp) => v.messages.find((m) => re.test(m.subject))!;

describe("reviewIdFor", () => {
  it("is deterministic, a valid UUID, distinct per message and does not contain the key", () => {
    const a = reviewIdFor("broko|mid|abc"), b = reviewIdFor("broko|mid|abd");
    assert.equal(reviewIdFor("broko|mid|abc"), a);
    assert.notEqual(a, b);
    assert.ok(isValidReviewId(a) && isValidReviewId(b));
    assert.ok(!a.includes("abc") && !a.includes("broko"));
  });
  it("does not carry any part of the key: keys with a long common prefix share no segment of their ids", () => {
    const ids = Array.from({ length: 24 }, (_, i) => reviewIdFor(`broko|tenant|synthetic|mailbox-one|message-${i}`).split("-"));
    for (const seg of [0, 4]) { // the 32-bit and 48-bit segments: a repeat among 24 digests would be a defect, not chance
      assert.equal(new Set(ids.map((p) => p[seg])).size, ids.length, `segment ${seg} repeats across messages with a shared prefix (the id is not a one-way digest of the whole key)`);
    }
  });
  it("is not the workflow id, and does not embed it", () => {
    const k = "broko|mid|abc";
    assert.ok(!reviewIdFor(k).replaceAll("-", "").includes(sourceRef(k)));
  });
  it("accepts only canonical lower-case UUIDs", () => {
    assert.equal(isValidReviewId(reviewIdFor("x")), true);
    for (const v of ["", "nope", reviewIdFor("x").toUpperCase(), `${reviewIdFor("x")}\n`, reviewIdFor("x").replaceAll("-", ""), 5, null, undefined, {}]) assert.equal(isValidReviewId(v), false);
  });
});

describe("browser-facing view model", () => {
  it("exposes exactly the allow-listed fields and none of the provider or mailbox identifiers", async () => {
    const { rt, repo } = setup();
    await repo(admin).process();
    const v = await repo(admin).view();
    assert.ok(v.messages.length > 0);
    const raw: ProcessedMessage[] = await rt.records.list(100);
    const allowed = Object.keys(toMessageView(raw[0])).sort();
    for (const m of v.messages) {
      assert.deepEqual(Object.keys(m).sort(), allowed);
      for (const k of FORBIDDEN_KEYS) assert.equal(k in m, false, `view model has ${k}`);
    }
    // No identifying VALUE appears anywhere in the serialized view, including nested objects.
    const json = JSON.stringify(v);
    for (const r of raw) {
      for (const secret of [r.dedupe_key, r.source_message_id, r.internet_message_id, r.mailbox_ref]) {
        if (secret) assert.equal(json.includes(secret), false, `view leaks ${secret}`);
      }
    }
    assert.ok(v.messages.every((m) => isValidReviewId(m.review_id)));
    assert.equal(new Set(v.messages.map((m) => m.review_id)).size, v.messages.length, "review ids are unique");
  });

  it("allow-list: a new field on the stored record is NOT exposed until added to the view on purpose", () => {
    const rec = {
      review_id: reviewIdFor("k"), dedupe_key: "k", grounding_notes: ["note"], owner: { user_id: null, rule_id: "r", reason: "why" }, classifier: null,
      sender_name: null, sender_email: "a@example.test", subject: "s", received_at: "2026-01-01T00:00:00.000Z", status: "REVIEW_REQUIRED", analysis: null, risk_flags: [],
      confirmed_owner: null, review_reasons: [], proposed_priority: null, proposed_due_at: null, task_id: null, notification: { attempted: false, sent: false, detail: "" },
      reviewed_by: null, reviewed_at: null, error: null, extra_future_field: "SECRET",
    } as unknown as ProcessedMessage;
    const view = toMessageView(rec);
    assert.equal(JSON.stringify(view).includes("SECRET"), false);
    assert.equal("rule_id" in view.owner, false);
    assert.equal(view.grounding_removed, 1);
  });

  it("a view's workflow id still matches its job, so the page can pair them", async () => {
    const { repo } = setup();
    await repo(admin).process();
    const v = await repo(admin).view();
    for (const m of v.messages) assert.ok(v.jobs.some((j) => j.workflow_id === m.workflow_id), m.workflow_id);
  });
});

describe("approval by opaque id", () => {
  it("approves by review id, once", async () => {
    const { repo } = setup();
    await repo(admin).process();
    const id = find(await repo(admin).view(), /BR-1042/).review_id;
    assert.equal((await repo(admin).review(id, { action: "approve" })).ok, true);
    const again = await repo(admin).review(id, { action: "approve" });
    assert.equal(again.ok === false && again.error, "not_reviewable");
  });

  it("the dedupe key, workflow id, source id and an unknown well-formed uuid are NOT accepted as handles", async () => {
    const { rt, repo } = setup();
    await repo(admin).process();
    const rec = (await rt.records.list(100)).find((r) => /BR-1042/.test(r.subject))!;
    const handles = [rec.dedupe_key, sourceRef(rec.dedupe_key), rec.source_message_id, reviewIdFor("a different message")];
    for (const handle of handles) {
      const r = await repo(admin).review(handle, { action: "approve" });
      assert.equal(r.ok === false && r.error, "not_found", handle);
    }
    assert.equal(find(await repo(admin).view(), /BR-1042/).status, "REVIEW_REQUIRED", "nothing was approved through the wrong handles");
  });

  it("a member is refused before the id is looked up (no existence oracle)", async () => {
    const { repo } = setup();
    await repo(admin).process();
    const id = find(await repo(admin).view(), /BR-1042/).review_id;
    const real = await repo(memberA).review(id, { action: "approve" });
    const fake = await repo(memberA).review(reviewIdFor("nothing"), { action: "approve" });
    assert.deepEqual([real.ok === false && real.error, fake.ok === false && fake.error], ["forbidden", "forbidden"]);
    assert.equal(real.ok === false && real.message, fake.ok === false && fake.message);
  });
});

describe("canonical job key", () => {
  it("is a JSON array, so a delimiter inside a field cannot make two different references collide", () => {
    const a = { provider: "synthetic" as const, mailbox_ref: "a|b", source_message_id: "c" };
    const b = { provider: "synthetic" as const, mailbox_ref: "a", source_message_id: "b|c" };
    assert.notEqual(jobKey(a), jobKey(b));
    assert.notEqual(jobId(a), jobId(b));
    assert.equal(jobKey(a), '["synthetic","a|b","c"]');
    assert.deepEqual(JSON.parse(jobKey(b)), ["synthetic", "a", "b|c"]);
  });
});

describe("browser-facing source files do not name provider identifiers", () => {
  for (const file of ["src/components/ai-inbox-list.tsx", "src/app/(app)/inbox/page.tsx", "src/app/(app)/inbox/actions.ts"]) {
    it(file, () => {
      const text = readFileSync(file, "utf8");
      for (const word of ["dedupe_key", "source_message_id", "internet_message_id", "mailbox_ref", "ProcessedMessage"]) {
        assert.equal(text.includes(word), false, `${file} mentions ${word}`);
      }
    });
  }
});
