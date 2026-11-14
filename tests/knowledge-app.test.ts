import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Static guards for the app layer (pages, server actions, components). The behaviour behind them is covered by knowledge.test.ts;
// these pin the wiring that must not regress: authenticate first, no client-supplied identity, admin-only controls, no raw chat in feedback.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ACTIONS = read("src/app/(app)/knowledge/actions.ts");
const PAGE = read("src/app/(app)/knowledge/page.tsx");
const LIB = read("src/app/(app)/knowledge/_lib.ts");
const FEEDBACK = read("src/components/knowledge/answer-feedback.tsx");
const FORM = read("src/components/knowledge/submission-form.tsx");
const REVIEW = read("src/components/knowledge/review-controls.tsx");
const SERVICE = read("src/lib/knowledge/service.ts");

describe("knowledge server actions", () => {
  it("every exported action authenticates through the session before doing anything", () => {
    const chunks = ACTIONS.split("export async function ").slice(1);
    assert.equal(chunks.length, 4);
    for (const c of chunks) {
      const name = c.slice(0, c.indexOf("("));
      const body = c.slice(c.indexOf("{\n") + 2).trimStart();
      assert.ok(body.startsWith("const ctx = await knowledgeContext();"), `${name} must authenticate first`);

    }
  });

  it("the context comes from the server session, and takes no argument from the request", () => {
    assert.match(LIB, /await requireUser\(\)/);
    assert.match(LIB, /export async function knowledgeContext\(\)/);
    assert.ok(!/service_role|SERVICE_ROLE|createAdmin/i.test(LIB + ACTIONS + PAGE), "no service-role shortcut");
  });

  it("actions pass the raw payload to the strict, tested service and never read role, user or status from it", () => {
    assert.ok(!/formData|FormData|role|user_id|author_id|status/.test(ACTIONS.replace(/\/\/.*$/gm, "")), "the actions must not interpret identity fields");
    assert.match(SERVICE, /canReview\(ctx\.user\)/);
  });

  it("unexpected errors become a generic sentence; only UserFacingError text reaches the browser", () => {
    assert.match(ACTIONS, /instanceof UserFacingError/);
    assert.match(ACTIONS, /console\.error\("\[knowledge\]", e\)/);
  });
});

describe("knowledge page and components", () => {
  it("loads the review queue, history and feedback totals only for administrators", () => {
    assert.match(PAGE, /const admin = canReview\(ctx\.user\)/);
    for (const call of ["repo.listQueue()", "repo.feedbackSummary()", "repo.listAll("]) {
      const idx = PAGE.indexOf(call);
      assert.ok(idx > 0 && PAGE.slice(Math.max(0, idx - 90), idx).includes("admin ?"), `${call} must be behind the admin check`);
    }
    assert.match(PAGE, /\{admin && \(\s*<Card title=\{`Awaiting review/);
    assert.match(PAGE, /writable && admin && <ReviewControls/);
  });

  it("hides the submission form in the demo and says nothing was saved", () => {
    assert.match(PAGE, /\{writable && \(\s*<Card title=\{replaces/);
    assert.match(read("src/app/(app)/knowledge/layout.tsx"), /Nothing you do here is saved/);
  });

  it("the form previews before saving and states that the result is a proposal", () => {
    assert.match(FORM, /previewKnowledgeAction/);
    assert.match(FORM, /Submit for review/);
    assert.match(FORM, /You will see exactly what is sent before anything is saved/);
    assert.ok(!/author_id|reviewed_|status:|name="status"|\bstatus\b[^=]/.test(FORM.replace(/role="status"/g, "")), "the form has no status/author/reviewer fields");
  });

  it("review controls require a reason to reject and are labelled for assistive tech", () => {
    assert.match(REVIEW, /Please give a reason before rejecting/);
    assert.match(REVIEW, /htmlFor=\{noteId\}/);
    assert.match(REVIEW, /role="alert"/);
  });

  it("feedback sends metadata only: a rating, a fixed reason, the intent and the source ids", () => {
    const call = /sendFeedbackAction\(\{([^}]*)\}\)/.exec(FEEDBACK)?.[1] ?? "";
    assert.deepEqual(call.split(",").map((s) => s.trim().split(":")[0].trim()).sort(), ["intent", "rating", "reason", "source_ids"]);
    assert.ok(!/reply\.(text|sections)|turn\.content|message|question/.test(FEEDBACK.replace(/\/\*[\s\S]*?\*\//g, "")), "never reads the answer text or the question");
    assert.match(FEEDBACK, /Feedback is not saved in the demo/);
    assert.match(FEEDBACK, /aria-label="This answer was useful"/);
  });

  it("the navigation shows Knowledge to every signed-in user (reading and proposing are open; review controls are admin-only on the page)", () => {
    assert.match(read("src/components/app-shell.tsx"), /href: "\/knowledge", label: "Knowledge"/);
  });

  it("no connector, sync or import button is offered anywhere in the knowledge UI", () => {
    const all = [PAGE, FORM, REVIEW, FEEDBACK, read("src/components/knowledge/item-card.tsx")].join("\n");
    assert.ok(!/OneDrive|SharePoint|Google Drive|Outlook|Gmail|Notion|Sync now|Connect /i.test(all));
  });

  it("the migration files stay out of supabase/migrations until promoted (their applied status is in docs/MIGRATION_STATUS.md; the headers inside the applied files are intentionally unchanged)", () => {
    assert.ok(!existsSync(new URL("../supabase/migrations/0009_knowledge.sql", import.meta.url)));
    assert.ok(existsSync(new URL("../supabase/proposed/0009_knowledge.proposed.sql", import.meta.url)));
    assert.ok(existsSync(new URL("../supabase/proposed/0010_chat_audit_vocab.proposed.sql", import.meta.url)));
  });
});
