import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SYNTHETIC_EMAILS, processMessage, reviewMessage, TaskSinkDenied } from "../src/lib/ai-brain";
import { ADMIN, FakeNotifier, MEMBER_A, MEMBER_B, makeDeps } from "./ai-brain-helpers";

const viewing = SYNTHETIC_EMAILS.viewingComplete;

describe("human review: ownership, server time and attribution", () => {
  it("keeps the rule-based SUGGESTION separate from the owner a human CONFIRMS", async () => {
    const { deps } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    assert.equal(record?.owner.user_id, MEMBER_A.id, "suggested by rule");
    assert.equal(record?.confirmed_owner, null, "nothing is confirmed before a human decides");
    const res = await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN, assigned_to: MEMBER_B.id });
    assert.equal(res.ok, true);
    const after = (await deps.store.get(record!.dedupe_key))!;
    assert.equal(after.owner.user_id, MEMBER_A.id, "the suggestion is never overwritten");
    assert.deepEqual([after.confirmed_owner?.user_id, after.confirmed_owner?.confirmed_by], [MEMBER_B.id, ADMIN.id]);
  });

  it("confirming the suggestion unchanged is recorded as a human confirmation, not as an AI decision", async () => {
    const { deps } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    const after = (await deps.store.get(record!.dedupe_key))!;
    assert.deepEqual([after.confirmed_owner?.user_id, after.confirmed_owner?.confirmed_by, after.reviewed_by], [MEMBER_A.id, ADMIN.id, ADMIN.id]);
  });

  it("stamps the decision with the server clock and the authenticated reviewer; a client cannot supply either", async () => {
    const { deps } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    const serverNow = new Date("2026-10-20T10:00:00.000Z").toISOString();
    // Extra fields a browser might smuggle in are not part of the decision type and are ignored.
    const smuggled = { action: "approve", by: ADMIN, reviewed_at: "1999-01-01T00:00:00.000Z", reviewed_by: "someone-else" } as unknown as Parameters<typeof reviewMessage>[2];
    await reviewMessage(deps, record!.dedupe_key, smuggled);
    const after = (await deps.store.get(record!.dedupe_key))!;
    assert.deepEqual([after.reviewed_by, after.reviewed_at], [ADMIN.id, serverNow]);
  });

  it("a rejection records the reviewer and time and keeps the source reference and analysis", async () => {
    const { deps } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    await reviewMessage(deps, record!.dedupe_key, { action: "reject", by: ADMIN });
    const after = (await deps.store.get(record!.dedupe_key))!;
    assert.deepEqual([after.status, after.reviewed_by, after.confirmed_owner], ["REJECTED", ADMIN.id, null]);
    assert.ok(after.reviewed_at);
    assert.deepEqual([after.source_message_id, after.mailbox_ref, after.dedupe_key], [record!.source_message_id, record!.mailbox_ref, record!.dedupe_key]);
    assert.equal(after.analysis?.intent, "viewing_request");
  });

  it("a refused review and a failed task creation leave no reviewer, time or confirmed owner behind", async () => {
    const { deps, sink } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: MEMBER_A });
    sink.createTask = async () => { throw new TaskSinkDenied("denied"); };
    await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    const after = (await deps.store.get(record!.dedupe_key))!;
    assert.equal(after.status, "REVIEW_REQUIRED", "a failed task creation returns the item to review");
    assert.deepEqual([after.reviewed_by, after.reviewed_at, after.confirmed_owner, after.task_id], [null, null, null, null], "a decision that did not take effect is not recorded");
  });
});

describe("audit of decisions: never reported before they take effect", () => {
  it("an approval is audited only after the task exists; a failed creation produces a failure event, not an 'approved' one", async () => {
    const { deps, audit, sink } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    sink.createTask = async () => { throw new TaskSinkDenied("denied"); };
    const res = await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    assert.equal(res.ok, false);
    assert.ok(!audit.events.some((e) => e.decision === "approved"), "no approval event for a decision that did not take effect");
    assert.ok(audit.events.some((e) => e.event_type === "workflow_failed" && e.error_category === "task_creation_denied"));
  });

  it("a decision succeeds even when its audit event cannot be saved, and the gap is reported rather than hidden", async () => {
    const { deps, audit, sink } = makeDeps({ notifier: new FakeNotifier() });
    const { record } = await processMessage(deps, viewing);
    audit.failing = true;
    const res = await reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN });
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.audit_ok, false);
    assert.equal(sink.tasks.size, 1, "the task was still created exactly once");
    audit.failing = false;
    const rej = await reviewMessage(deps, (await processMessage(deps, SYNTHETIC_EMAILS.invoice)).record!.dedupe_key, { action: "reject", by: ADMIN });
    assert.equal(rej.ok && rej.audit_ok, true);
  });

  it("repeated and concurrent approvals create one task and one approval event", async () => {
    const { deps, audit, sink } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    const results = await Promise.all([1, 2, 3, 4].map(() => reviewMessage(deps, record!.dedupe_key, { action: "approve", by: ADMIN })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(sink.tasks.size, 1);
    assert.equal(audit.events.filter((e) => e.decision === "approved").length, 1);
  });

  it("members cannot approve or reject, and leave no trace", async () => {
    const { deps, audit, sink } = makeDeps();
    const { record } = await processMessage(deps, viewing);
    const before = audit.events.length;
    for (const action of ["approve", "reject"] as const) {
      const r = await reviewMessage(deps, record!.dedupe_key, { action, by: MEMBER_A });
      assert.equal(r.ok === false && r.error, "forbidden");
    }
    assert.equal(audit.events.length, before);
    assert.equal(sink.calls, 0);
    assert.equal((await deps.store.get(record!.dedupe_key))?.reviewed_by, null);
  });
});
