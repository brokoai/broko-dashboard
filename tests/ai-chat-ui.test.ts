import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { MAX_MESSAGE_CHARS } from "../src/lib/ai-brain/chat";
import type { ChatReply } from "../src/lib/ai-brain/chat";
import { MAX_TURNS, chatReducer, initialChatState, retryText, safeHref, type ChatState } from "../src/lib/chat-state";

const reply = (over: Partial<ChatReply> = {}): ChatReply => ({
  intent: "pending_tasks", mode: "live", text: "You have 1 pending task.", sections: [], sources: [], grounding: { facts: 1, sources_used: ["tasks"], not_covered: [], evidence: true }, generated_at: "2026-10-25T12:00:00Z", ...over,
});
const HELPER = new URL("./chat-render-helper.tsx", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
type Case = { kind: "reply" | "turn" | "launcher"; props: Record<string, unknown> };
/** Renders components in a child process (react-dom/server cannot load under the react-server condition the suite runs with). */
function render(...cases: Case[]): string[] {
  const env = { ...process.env, NODE_OPTIONS: "" };
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", HELPER], { input: JSON.stringify(cases), env, encoding: "utf8" })) as string[];
}
const run = (s: ChatState, ...actions: Parameters<typeof chatReducer>[1][]) => actions.reduce(chatReducer, s);

describe("chat state: button, panel, send, clear", () => {
  it("opens and closes the panel", () => {
    const o = run(initialChatState, { type: "open" });
    assert.equal(o.open, true);
    assert.equal(run(o, { type: "close" }).open, false);
  });

  it("send adds the user turn and sets loading; the reply clears loading and adds the answer", () => {
    const s1 = run(initialChatState, { type: "send", text: "  What needs my attention?  " });
    assert.equal(s1.pending, true);
    assert.deepEqual(s1.turns.map((t) => t.role), ["user"]);
    assert.equal(s1.turns[0].role === "user" && s1.turns[0].content, "What needs my attention?");
    const s2 = run(s1, { type: "reply", reply: reply(), epoch: 0 });
    assert.equal(s2.pending, false);
    assert.deepEqual(s2.turns.map((t) => t.role), ["user", "assistant"]);
  });

  it("an error ends loading and is shown as an error turn", () => {
    const s = run(initialChatState, { type: "send", text: "hi" }, { type: "error", message: "nope", epoch: 0 });
    assert.equal(s.pending, false);
    assert.equal(s.turns[1].role, "error");
  });

  it("ignores empty, over-long and concurrent sends", () => {
    assert.equal(run(initialChatState, { type: "send", text: "   " }), initialChatState);
    assert.equal(run(initialChatState, { type: "send", text: "x".repeat(MAX_MESSAGE_CHARS + 1) }), initialChatState);
    const busy = run(initialChatState, { type: "send", text: "one" });
    assert.equal(run(busy, { type: "send", text: "two" }), busy);
  });

  it("clear empties the conversation and drops an answer that arrives later", () => {
    const asked = run(initialChatState, { type: "send", text: "one" });
    const cleared = run(asked, { type: "clear" });
    assert.deepEqual(cleared.turns, []);
    assert.equal(cleared.pending, false);
    assert.equal(run(cleared, { type: "reply", reply: reply(), epoch: 0 }).turns.length, 0, "stale answer is dropped");
    // a new question after the clear is not confused with the old one
    const again = run(cleared, { type: "send", text: "two" });
    assert.equal(run(again, { type: "reply", reply: reply(), epoch: 0 }).turns.length, 1);
    assert.equal(run(again, { type: "reply", reply: reply(), epoch: 1 }).turns.length, 2);
  });

  it("retry re-asks the question behind a trailing error, without duplicating the question", () => {
    const failed = run(initialChatState, { type: "send", text: "What happened today?" }, { type: "error", message: "down", epoch: 0 });
    assert.equal(retryText(failed), "What happened today?");
    const again = run(failed, { type: "retry" });
    assert.equal(again.pending, true);
    assert.deepEqual(again.turns.map((t) => t.role), ["user"]);
    const done = run(again, { type: "reply", reply: reply(), epoch: 0 });
    assert.deepEqual(done.turns.map((t) => t.role), ["user", "assistant"]);
  });

  it("retry is a no-op unless the last turn is an error that follows a question", () => {
    assert.equal(retryText(initialChatState), null);
    assert.equal(run(initialChatState, { type: "retry" }), initialChatState);
    const ok = run(initialChatState, { type: "send", text: "hi" }, { type: "reply", reply: reply(), epoch: 0 });
    assert.equal(retryText(ok), null);
    assert.equal(run(ok, { type: "retry" }), ok);
    const busy = run(initialChatState, { type: "send", text: "hi" });
    assert.equal(run(busy, { type: "retry" }), busy);
  });

  it("keeps only the most recent turns (memory bound) with unique ids", () => {
    let s = initialChatState;
    for (let i = 0; i < MAX_TURNS + 10; i++) s = run(s, { type: "send", text: `q${i}` }, { type: "reply", reply: reply(), epoch: 0 });
    assert.equal(s.turns.length, MAX_TURNS);
    assert.equal(new Set(s.turns.map((t) => t.id)).size, MAX_TURNS);
  });
});

describe("chat UI rendering", () => {
  const rv = (r: ChatReply): Case => ({ kind: "reply", props: { reply: r } });
  const html = render(
    { kind: "launcher", props: {} },
    rv(reply({ sections: [{ heading: "Overdue (1)", items: [{ text: "<img src=x onerror=alert(1)> **bold**", href: "/tasks/t1" }] }] })),
    rv(reply({ sections: [{ items: [{ text: "a", href: "https://evil.example" }, { text: "b", href: "//evil.example" }, { text: "c", href: "javascript:alert(1)" }] }] })),
    rv(reply({ sources: [
      { id: "tasks", label: "Tasks", state: "live", detail: "All tasks", count: 3 },
      { id: "activity", label: "Activity feed", state: "stale", detail: "Newest event is more than 24 hours old" },
      { id: "email", label: "Email", state: "unavailable", reason: "not_connected", detail: "Not connected." },
      { id: "ai_inbox", label: "AI Inbox", state: "demo", detail: "Built-in sample emails" },
    ] })),
    rv(reply({ intent: "action_request", approval: { required: true, executed: false, action: "assign_task", label: "Assign a task", permitted: false, reason: "Only administrators can assign tasks to other people.", where: { label: "Open Tasks", href: "/tasks" } } })),
    rv(reply({ sections: [{ items: [{ text: "x", flagged: true }] }] })),
    { kind: "turn", props: { turn: { id: 1, role: "error", content: "Could not reach" } } },
    rv(reply()),
    rv(reply({ intent: "clarify", text: "Which do you mean?", clarification: { question: "Which do you mean?", options: ["What needs my attention?", "What happened today?"] } })),
    rv(reply({ mode: "demo", grounding: { facts: 3, sources_used: ["tasks", "ai_inbox"], not_covered: ["email"], evidence: true }, sections: [{ kind: "missing", heading: "Not checked", text: "Email: Not connected." }] })),
    rv(reply({ grounding: { facts: 0, sources_used: [], not_covered: ["tasks"], evidence: false } })),
  );

  it("the closed widget is a labelled round button with dialog semantics and nothing else", () => {
    assert.match(html[0], /aria-label="Open Broko AI assistant"/);
    assert.match(html[0], /aria-haspopup="dialog"/);
    assert.match(html[0], /rounded-full/);
    assert.doesNotMatch(html[0], /role="dialog"/);
  });

  it("renders replies as text: markup in record titles is escaped, never executed", () => {
    assert.doesNotMatch(html[1], /<img/);
    assert.match(html[1], /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html[1], /<strong>bold/);
    assert.match(html[1], /href="\/tasks\/t1"/);
  });

  it("drops non-internal links", () => {
    assert.doesNotMatch(html[2], /evil\.example|javascript:/);
    assert.equal(safeHref("/inbox"), "/inbox");
    assert.equal(safeHref("/tasks/abc-1"), "/tasks/abc-1");
    assert.equal(safeHref("https://x"), undefined);
    assert.equal(safeHref(undefined), undefined);
  });

  it("shows source states (live / demo / possibly out of date / unavailable) and the reason", () => {
    for (const label of ["Live", "Possibly out of date", "Unavailable", "Demo data", "Not connected\."]) assert.match(html[3], new RegExp(label));
  });

  it("an action request shows 'not executed' with the place a human does it", () => {
    assert.match(html[4], /Approval required\. Not executed\./);
    assert.match(html[4], /href="\/tasks"/);
    assert.match(html[4], /you are not permitted/);
    assert.match(html[4], /Only administrators can assign tasks/);
  });

  it("flagged records are labelled as data", () => {
    assert.match(html[5], /treated as data/);
  });

  it("error turns use an alert role", () => {
    assert.match(html[6], /role="alert"/);
  });

  it("a clarifying question shows the options to choose from", () => {
    assert.match(html[8], /Did you mean/);
    assert.match(html[8], /What needs my attention\?/);
  });

  it("states what the answer rests on, labels demo data, and shows what was not checked", () => {
    assert.match(html[9], /Demo data\. Based on 3 records from tasks, ai inbox/);
    assert.match(html[9], /Not checked/);
    assert.match(html[9], /Email: Not connected\./);
  });

  it("does not claim a basis when nothing was retrieved", () => {
    assert.doesNotMatch(html[10], /Based on/);
  });

  it("empty reply sections and sources render without crashing", () => {
    assert.match(html[7], /You have 1 pending task\./);
  });
});

describe("chat UI: long user messages cannot widen the sheet (found on a 375px viewport)", () => {
  it("the user bubble can shrink below its content and breaks unbroken words anywhere", () => {
    const [html] = render({ kind: "turn", props: { turn: { id: 1, role: "user", content: "x".repeat(300) } } });
    assert.match(html, /min-w-0/);
    assert.match(html, /max-w-full/);
    assert.match(html, /\[overflow-wrap:anywhere\]/);
  });
});
