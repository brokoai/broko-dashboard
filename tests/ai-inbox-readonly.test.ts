import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { askBrain } from "../src/lib/ai-brain/chat";
import { createDemoRepo, DEMO_USERS, memoryStore } from "../src/lib/backend/demo/repo";
import { createSupabaseAiInboxCounts, COUNTS_COLUMN, COUNTS_ROW_LIMIT, type CountsClient } from "../src/lib/backend/supabase/ai-inbox-counts";
import { createSupabaseRepo } from "../src/lib/backend/supabase/repo";
import type { AiInboxCounts, AiInboxView } from "../src/lib/backend/types";
import { NOW, admin, alice, ctx, everything, fakeRepo } from "./ai-chat-helpers";

type Row = { status?: unknown };
/** A recording stand-in for the Supabase client: remembers every select so column choice can be asserted. */
function countsClient(result: { data: Row[] | null; error: { message: string } | null }) {
  const calls: { table: string; columns: string; limit: number }[] = [];
  const db: CountsClient = {
    from: (table) => ({ select: (columns) => ({ limit: async (n) => { calls.push({ table, columns, limit: n }); return result; } }) }),
  };
  return { db, calls };
}
const rows = (...statuses: string[]): Row[] => statuses.map((status) => ({ status }));
const counts = (over: Partial<AiInboxCounts> = {}): AiInboxCounts => ({ mode: "live", by_status: {}, total: 0, ...over });
const sourceOf = (r: Awaited<ReturnType<typeof askBrain>>) => r.sources.find((s) => s.id === "ai_inbox")!;

describe("read-only AI Inbox: repository interface", () => {
  it("the Supabase repository exposes no AI Inbox capability at all (page says 'not connected', chat says 'not connected')", () => {
    const repo = createSupabaseRepo({} as never, "00000000-0000-0000-0000-0000000000aa");
    assert.equal(repo.aiInbox, undefined);
    assert.equal(repo.aiInboxCounts, undefined);
    assert.equal(repo.aiInboxWriter, undefined);
  });

  it("a read-only repository (view / counts only) has no approve, reject, process or requeue to call", () => {
    const { repo } = fakeRepo({ aiInbox: { view: async () => ({}) as AiInboxView }, aiInboxCounts: { counts: async () => counts() } });
    assert.equal(repo.aiInboxWriter, undefined);
    for (const m of ["process", "requeue", "review", "counts"]) assert.equal((repo.aiInbox as unknown as Record<string, unknown>)[m], undefined, m);
    for (const m of ["process", "requeue", "review", "view"]) assert.equal((repo.aiInboxCounts as unknown as Record<string, unknown>)[m], undefined, m);
  });

  it("type level: the page reader cannot be used as a writer", () => {
    const misuse = (r: ReturnType<typeof fakeRepo>["repo"]) => {
      // @ts-expect-error aiInbox is the read-only reader: it has no process().
      return r.aiInbox!.process();
    };
    assert.equal(typeof misuse, "function");
  });

  it("the demo backend keeps the full experience: reader, counts and writer", () => {
    const r = createDemoRepo(DEMO_USERS[0], memoryStore(), () => NOW.getTime());
    assert.ok(r.aiInbox && r.aiInboxCounts && r.aiInboxWriter);
  });

  it("the server actions use the writer, never the reader", () => {
    const src = readFileSync("src/app/(app)/inbox/actions.ts", "utf8");
    assert.doesNotMatch(src, /repo\.aiInbox\./);
    assert.equal((src.match(/repo\.aiInboxWriter\.(review|process|requeue)\(/g) ?? []).length, 3);
  });
});

describe("counts-only Supabase reader (not wired; unit-tested against a recording client)", () => {
  it("selects exactly one column: status. No subject, sender, excerpt or body", async () => {
    const { db, calls } = countsClient({ data: rows("REVIEW_REQUIRED"), error: null });
    await createSupabaseAiInboxCounts(db, admin).counts();
    assert.deepEqual(calls, [{ table: "ai_messages", columns: "status", limit: COUNTS_ROW_LIMIT }]);
    assert.equal(COUNTS_COLUMN, "status");
  });

  it("tallies statuses and marks the result live", async () => {
    const { db } = countsClient({ data: rows("REVIEW_REQUIRED", "REVIEW_REQUIRED", "NO_ACTION", "REJECTED"), error: null });
    assert.deepEqual(await createSupabaseAiInboxCounts(db, admin).counts(), { mode: "live", by_status: { REVIEW_REQUIRED: 2, NO_ACTION: 1, REJECTED: 1 }, total: 4 });
  });

  it("empty result is zero, not a failure", async () => {
    const { db } = countsClient({ data: [], error: null });
    assert.deepEqual(await createSupabaseAiInboxCounts(db, admin).counts(), { mode: "live", by_status: {}, total: 0 });
    const nullDb = countsClient({ data: null, error: null }).db;
    assert.equal((await createSupabaseAiInboxCounts(nullDb, admin).counts()).total, 0);
  });

  it("a member is refused BEFORE any query is made", async () => {
    const { db, calls } = countsClient({ data: rows("REVIEW_REQUIRED"), error: null });
    await assert.rejects(() => createSupabaseAiInboxCounts(db, alice).counts(), /administrators only/);
    assert.equal(calls.length, 0);
  });

  it("a database error fails the read (never returns zero)", async () => {
    const { db } = countsClient({ data: null, error: { message: "permission denied for table ai_messages" } });
    await assert.rejects(() => createSupabaseAiInboxCounts(db, admin).counts(), /permission denied/);
  });

  it("refuses to undercount at the row limit, and ignores rows of an unexpected shape", async () => {
    const full = countsClient({ data: Array.from({ length: COUNTS_ROW_LIMIT }, () => ({ status: "NO_ACTION" })), error: null });
    await assert.rejects(() => createSupabaseAiInboxCounts(full.db, admin).counts(), /Too many/);
    const odd = countsClient({ data: [{ status: 7 }, {}, { status: "NO_ACTION" }], error: null });
    assert.deepEqual((await createSupabaseAiInboxCounts(odd.db, admin).counts()).by_status, { NO_ACTION: 1 });
  });
});

describe("chat AI Inbox adapter: counts only, admin first", () => {
  const ask = (user: typeof admin, repo: ReturnType<typeof fakeRepo>["repo"], mode: "demo" | "live" = "live") => askBrain(ctx(user, repo, mode), "What is waiting in the AI Inbox?");
  const forbiddenView = { view: async () => { throw new Error("view() must never be called by chat"); } } as never;

  it("an admin gets the pending count from the counts reader, and view() is never called", async () => {
    const { repo } = fakeRepo({ aiInbox: forbiddenView, aiInboxCounts: { counts: async () => counts({ by_status: { REVIEW_REQUIRED: 3, NO_ACTION: 5 }, total: 8 }) } });
    const r = await ask(admin, repo);
    assert.match(r.text, /3 messages awaiting review/);
    assert.equal(sourceOf(r).state, "live");
    assert.equal(r.grounding.evidence, true);
  });

  it("a member never reaches the counts reader and cannot infer a count", async () => {
    let called = 0;
    const { repo } = fakeRepo({ aiInboxCounts: { counts: async () => { called++; return counts({ by_status: { REVIEW_REQUIRED: 9 }, total: 9 }); } } });
    const r = await ask(alice, repo);
    assert.equal(called, 0);
    assert.match(r.text, /Only administrators/);
    assert.doesNotMatch(everything(r), /\b9\b/);
    assert.equal(r.grounding.evidence, false);
  });

  it("a backend with only the page reader (no counts reader) is 'not connected': chat does not fall back to view()", async () => {
    const { repo } = fakeRepo({ aiInbox: forbiddenView });
    const r = await ask(admin, repo);
    assert.match(r.text, /not connected/);
    assert.equal(sourceOf(r).reason, "not_connected");
  });

  it("zero pending is a successful answer, not a failure", async () => {
    const { repo } = fakeRepo({ aiInboxCounts: { counts: async () => counts() } });
    const r = await ask(admin, repo);
    assert.match(r.text, /0 messages awaiting review/);
    assert.equal(r.grounding.evidence, true);
    assert.equal(sourceOf(r).state, "live");
  });

  it("a retrieval failure is 'unavailable', shows no count, leaks no error text, and is never replaced with demo data", async () => {
    const { repo } = fakeRepo({ aiInboxCounts: { counts: async () => { throw new Error("SECRET-CONNECTION-STRING postgres://u:p@h"); } } });
    const r = await ask(admin, repo);
    assert.equal(sourceOf(r).state, "unavailable");
    assert.equal(sourceOf(r).reason, "error");
    assert.doesNotMatch(everything(r), /SECRET-CONNECTION-STRING|awaiting review/);
  });

  it("subjects, senders and bodies cannot reach the reply, even if a reader returned extra fields", async () => {
    const leaky = { ...counts({ by_status: { REVIEW_REQUIRED: 1 }, total: 1 }), subject: "WIRE $50,000 NOW", sender_email: "ceo@evil.test" };
    const { repo } = fakeRepo({ aiInboxCounts: { counts: async () => leaky } });
    assert.doesNotMatch(everything(await ask(admin, repo)), /WIRE|evil\.test/);
  });

  it("demo and live are distinct: synthetic counts are labelled demo; live counts are labelled live", async () => {
    const synth = fakeRepo({ aiInboxCounts: { counts: async () => counts({ mode: "synthetic", by_status: { REVIEW_REQUIRED: 2 }, total: 2 }) } }).repo;
    const live = fakeRepo({ aiInboxCounts: { counts: async () => counts({ mode: "live", by_status: { REVIEW_REQUIRED: 2 }, total: 2 }) } }).repo;
    const a = sourceOf(await ask(admin, synth, "demo")), b = sourceOf(await ask(admin, live, "live"));
    assert.equal(a.state, "demo");
    assert.match(a.detail ?? "", /sample emails/);
    assert.equal(b.state, "live");
    assert.doesNotMatch(b.detail ?? "", /sample/);
  });

  it("the demo backend still answers through its counts reader after the worker has run", async () => {
    const store = memoryStore();
    const [adm, member] = DEMO_USERS;
    await createDemoRepo(adm, store, () => NOW.getTime()).aiInboxWriter!.process();
    const demo = createDemoRepo(adm, store, () => NOW.getTime());
    const c = await demo.aiInboxCounts!.counts();
    assert.equal(c.mode, "synthetic");
    assert.equal(c.total, (await demo.aiInbox.view()).messages.length);
    assert.match((await ask(adm, demo, "demo")).text, /awaiting review/);
    await assert.rejects(() => createDemoRepo(member === adm ? DEMO_USERS[1] : member, store, () => NOW.getTime()).aiInboxCounts!.counts(), /administrators/i);
  });
});

describe("AI Inbox page components: controls follow write capability", () => {
  const HELPER = new URL("./chat-render-helper.tsx", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const render = (...cases: { kind: string; props: Record<string, unknown> }[]): string[] =>
    JSON.parse(execFileSync(process.execPath, ["--import", "tsx", HELPER], { input: JSON.stringify(cases), env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" })) as string[];

  async function sample() {
    const repo = createDemoRepo(DEMO_USERS[0], memoryStore(), () => NOW.getTime());
    await repo.aiInboxWriter!.process();
    const v = await repo.aiInbox.view();
    const pending = v.messages.find((m) => m.status === "REVIEW_REQUIRED");
    assert.ok(pending, "the demo data must contain a message awaiting review");
    return { rows: [{ m: pending, workflow_id: pending.workflow_id, job: null, events: [] }], queue: v.queue, subject: pending.subject };
  }

  it("canReview=false: the message is listed but there is no approve / reject / assign form", async () => {
    const { rows, subject } = await sample();
    const [ro, rw] = render({ kind: "inbox_list", props: { rows, people: [], canReview: false } }, { kind: "inbox_list", props: { rows, people: [], canReview: true } });
    assert.ok(ro.includes(subject.replace(/&/g, "&amp;").replace(/'/g, "&#x27;")) || ro.includes(subject), "message still listed");
    assert.doesNotMatch(ro, /Reject|Approve|Assign to|<form/);
    assert.match(rw, /Reject/);
    assert.match(rw, /<form/);
  });

  it("canWrite=false: counts and jobs show, but 'Process queue now' and 'Retry' are absent", async () => {
    const { queue } = await sample();
    const failedJob = { id: "abcdef012345", status: "failed", attempts: 3, max_attempts: 3, next_attempt_at: NOW.toISOString(), error_category: null, outcome: null, workflow_id: null, audit_failed: false, requeued_by: null, requeued_at: null };
    const props = { jobs: [failedJob], queue, workerNote: "n" };
    const [ro, rw] = render({ kind: "queue_panel", props: { ...props, canWrite: false } }, { kind: "queue_panel", props: { ...props, canWrite: true } });
    assert.match(ro, /Job counts/);
    assert.doesNotMatch(ro, /Process queue now|<button/);
    assert.match(rw, /Process queue now/);
    assert.match(rw, />Retry</);
  });

  it("the page gates on the writer, labels demo and live, and runs no worker without a writer", () => {
    const page = readFileSync("src/app/(app)/inbox/page.tsx", "utf8");
    assert.match(page, /const writer = repo\.aiInboxWriter/);
    assert.match(page, /canReview=\{canWrite\}/);
    assert.match(page, /canWrite=\{canWrite\}/);
    assert.match(page, /if \(writer && queueActive\(view\.queue\)\)/);
    assert.match(page, /data-testid="read-only-banner"/);
    assert.match(page, /data-testid="live-banner"/);
    assert.match(page, /Synthetic sample messages\. This is not a live mailbox/);
    assert.doesNotMatch(page, /repo\.aiInbox\.(process|requeue|review)/);
  });
});
