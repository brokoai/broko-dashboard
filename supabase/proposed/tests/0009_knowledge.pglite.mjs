// LOCAL ONLY. Executes 0009_knowledge.proposed.sql and 0010_chat_audit_vocab.proposed.sql on a local PostgreSQL (PGlite) that imitates
// Supabase's roles, and checks the rules the governed knowledge store depends on. Never connects to any remote database.
// Does NOT prove the same on a real Supabase project (PostgREST, real sessions and GoTrue are not involved).
//   npm install --no-save @electric-sql/pglite
//   node supabase/proposed/tests/0009_knowledge.pglite.mjs
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { IDS, createEnv } from "./lib/pglite_env.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)); // supabase/
const env = await createEnv();
const { db, check, attempt, denied } = env;

// Minimal stand-in for Supabase Storage (0007's storage policies need these two tables).
await db.exec(`
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null references storage.buckets (id), name text not null);
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant select on storage.buckets to authenticated;
`);

const applied = await env.apply([
  `${root}migrations/0001_init.sql`,
  `${root}proposed/0002_hardening.proposed.sql`,
  `${root}proposed/0006_profiles_privacy.proposed.sql`,
  `${root}proposed/0007_preconstruction.proposed.sql`,
  `${root}proposed/0008_chat_audit.proposed.sql`,
  `${root}proposed/0009_knowledge.proposed.sql`,
  `${root}proposed/0010_chat_audit_vocab.proposed.sql`,
]);
if (applied) {
  await env.seedUsers();
  const A = IDS.admin, M1 = IDS.m1, M2 = IDS.m2;

  // ---- fixtures ----------------------------------------------------------------------------------------------------
  const proj = await attempt("authenticated", A, "insert into public.precon_projects (name, created_by) values ('Harbour', $1) returning id", [A]);
  const arch = await attempt("authenticated", A, "insert into public.precon_projects (name, created_by) values ('Old', $1) returning id", [A]);
  const P = proj.rows?.[0]?.id, PA = arch.rows?.[0]?.id;
  check("fixtures: an active project exists", !!P, proj.msg);
  await attempt("authenticated", A, "update public.precon_projects set archived_at = now() where id = $1", [PA]);

  const propose = (who, over = {}) => {
    const v = { kind: "procedure", scope: "organization", project_id: null, title: "Refund approvals", body: "Refunds over 500 need a second approver.", topic: "refunds", source_type: "manual", source_ref: null, supersedes_id: null, expires_at: null, author: who, ...over };
    return attempt("authenticated", who, "insert into public.knowledge_items (kind, scope, project_id, title, body, topic, author_id, source_type, source_ref, supersedes_id, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, status",
      [v.kind, v.scope, v.project_id, v.title, v.body, v.topic, v.author, v.source_type, v.source_ref, v.supersedes_id, v.expires_at]);
  };
  const review = (who, id, action, note = null) => attempt("authenticated", who, "select public.knowledge_review($1, $2, $3)", [id, action, note]);
  const status = async (id) => (await db.query("select status from public.knowledge_items where id = $1", [id])).rows[0]?.status;
  const visible = async (who, id) => (await attempt("authenticated", who, "select id from public.knowledge_items where id = $1", [id])).rows?.length === 1;

  // ---- shape: content-free feedback, no free text where none is meant -----------------------------------------------
  const fbCols = (await db.query("select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'answer_feedback'")).rows;
  const textual = fbCols.filter((c) => ["text", "ARRAY", "jsonb", "character varying"].includes(c.data_type)).map((c) => c.column_name).sort();
  check("answer_feedback has no free-text column (rating, reason, intent, source_ids only)", JSON.stringify(textual) === JSON.stringify(["intent", "rating", "reason", "source_ids"]), textual.join(","));

  // ---- submit: only as yourself, only as a proposal -----------------------------------------------------------------
  const s1 = await propose(M1);
  check("a member proposes an item as themself, and it is 'proposed'", s1.ok && s1.rows[0].status === "proposed", s1.msg);
  const K1 = s1.rows?.[0]?.id;
  check("a member cannot submit as someone else", denied(await propose(M1, { author: M2 })));
  check("anon cannot submit", denied(await attempt("anon", null, "insert into public.knowledge_items (kind, scope, title, body) values ('procedure','organization','abc','abcdefghij')")));
  check("service_role holds no privilege on the table", denied(await attempt("service_role", null, "select id from public.knowledge_items")));
  for (const col of ["status", "reviewed_by", "reviewed_at", "review_note", "created_at", "effective_from", "updated_at", "organization_id", "id"]) {
    const val = { status: "'approved'", reviewed_by: `'${M1}'`, reviewed_at: "now()", review_note: "'ok'", created_at: "now()", effective_from: "now()", updated_at: "now()", organization_id: "gen_random_uuid()", id: "gen_random_uuid()" }[col];
    const r = await attempt("authenticated", M1, `insert into public.knowledge_items (kind, scope, title, body, author_id, ${col}) values ('procedure','organization','Forged','Forged body text here.', $1, ${val})`, [M1]);
    check(`a client cannot set ${col} on insert (column privilege)`, denied(r), r.msg);
  }
  const ev1 = (await db.query("select action, to_status from public.knowledge_events where item_id = $1", [K1])).rows;
  check("a submission writes its 'submitted' history row", ev1.length === 1 && ev1[0].action === "submitted" && ev1[0].to_status === "proposed", JSON.stringify(ev1));

  // ---- shape constraints ------------------------------------------------------------------------------------------------
  const badRows = [
    ["a project item with no project", { scope: "project", project_id: null }],
    ["an organization item that names a project", { scope: "organization", project_id: P }],
    ["a project note with organization scope", { kind: "project_note", scope: "organization" }],
    ["a correction typed as manual", { kind: "correction", source_type: "manual" }],
    ["a manual item typed as correction", { kind: "procedure", source_type: "correction" }],
    ["a title that is too short", { title: "ab" }],
    ["a body that is too short", { body: "short" }],
    ["a body over 2000 characters", { body: "x".repeat(2001) }],
    ["an unknown kind", { kind: "gossip" }],
    ["a topic with spaces or capitals", { topic: "Refund Rules" }],
    ["an expiry in the past of effective_from", { expires_at: "2000-01-01T00:00:00Z" }],
  ];
  for (const [name, over] of badRows) {
    const r = await propose(M1, over);
    check(`the database refuses ${name}`, !r.ok && (r.code === "23514" || denied(r)), `${r.code} ${r.msg}`);
  }
  check("a project note on a visible project is accepted", (await propose(M1, { kind: "project_note", scope: "project", project_id: P, title: "Harbour parking", body: "Parking is included with penthouses.", topic: "parking" })).ok);
  check("project knowledge on an archived project is refused for a member (project not visible)", denied(await propose(M1, { scope: "project", project_id: PA, kind: "decision", title: "Old thing", body: "A decision on an archived project." })));
  check("project knowledge on a project that does not exist is refused", denied(await propose(M1, { scope: "project", project_id: "00000000-0000-0000-0000-0000000000ff", kind: "decision", title: "Ghost project", body: "A decision on nothing at all." })));

  // ---- read visibility ------------------------------------------------------------------------------------------------
  check("the author reads their own proposal", await visible(M1, K1));
  check("another member does NOT read someone else's proposal", !(await visible(M2, K1)));
  check("an administrator reads every proposal", await visible(A, K1));
  check("anon reads nothing", denied(await attempt("anon", null, "select id from public.knowledge_items")));

  // ---- review: administrators only, through the function --------------------------------------------------------------
  check("a member cannot approve their own proposal", denied(await review(M1, K1, "approve")));
  check("a member cannot approve someone else's proposal", denied(await review(M2, K1, "approve")));
  check("anon cannot call the review function", denied(await attempt("anon", null, "select public.knowledge_review($1, 'approve', null)", [K1])));
  check("service_role cannot call the review function", denied(await attempt("service_role", null, "select public.knowledge_review($1, 'approve', null)", [K1])));
  check("the proposal is still 'proposed' after those refusals", (await status(K1)) === "proposed");
  for (const [who, name] of [[M1, "the author"], [A, "an administrator"]]) {
    for (const stmt of ["update public.knowledge_items set status = 'approved'", "delete from public.knowledge_items", "truncate public.knowledge_items"]) {
      const r = await attempt("authenticated", who, `${stmt}${stmt.startsWith("truncate") ? "" : " where id = $1"}`, stmt.startsWith("truncate") ? [] : [K1]);
      check(`${name} cannot run: ${stmt.split(" ").slice(0, 3).join(" ")} (no privilege)`, denied(r), r.msg);
    }
  }
  check("a member cannot write the history directly", denied(await attempt("authenticated", M1, "insert into public.knowledge_events (item_id, action, to_status) values ($1, 'approved', 'approved')", [K1])));
  check("a member cannot read the history", (await attempt("authenticated", M1, "select id from public.knowledge_events")).rows?.length === 0);
  check("an administrator reads the history", (await attempt("authenticated", A, "select id from public.knowledge_events")).rows?.length >= 1);

  check("rejecting without a reason is refused", !(await review(A, K1, "reject")).ok);
  check("an unknown action is refused", !(await review(A, K1, "delete")).ok);
  check("expiring a proposed item is refused (only approved items expire)", !(await review(A, K1, "expire")).ok);
  check("a missing item is refused", !(await review(A, "00000000-0000-0000-0000-0000000000ee", "approve")).ok);
  check("an administrator approves the proposal", (await review(A, K1, "approve", "Matches policy")).ok);
  check("the item is now 'approved' with the reviewer and time recorded", (await db.query("select status, reviewed_by, reviewed_at is not null r, review_note from public.knowledge_items where id = $1", [K1])).rows.some((x) => x.status === "approved" && x.reviewed_by === A && x.r && x.review_note === "Matches policy"));
  check("approving twice is refused (not proposed any more)", !(await review(A, K1, "approve")).ok);
  check("rejecting an approved item is refused", !(await review(A, K1, "reject", "no")).ok);

  // ---- approved items: visible to members, and only while current -------------------------------------------------
  check("another member now reads the approved organization item", await visible(M2, K1));
  const rejR = await propose(M1, { title: "Bad idea", body: "Skip the second approver entirely.", topic: "refunds" }); const rej = rejR.rows[0].id;
  check("an administrator rejects with a reason", (await review(A, rej, "reject", "Contradicts policy")).ok);
  check("a rejected item stays visible to its author", await visible(M1, rej));
  check("a rejected item is invisible to other members", !(await visible(M2, rej)));
  const exp = (await propose(M1, { title: "Short lived", body: "This will be approved then expired.", topic: "temp" })).rows[0].id;
  await review(A, exp, "approve");
  check("an administrator expires an approved item", (await review(A, exp, "expire", "No longer true")).ok);
  check("an expired item is invisible to other members", !(await visible(M2, exp)));
  check("expiring keeps the original approver and approval time on the item", (await db.query("select status, reviewed_by from public.knowledge_items where id = $1", [exp])).rows.some((x) => x.status === "expired" && x.reviewed_by === A));
  const notYet = (await propose(M1, { title: "Past expiry", body: "Approved first, then its expiry passes.", topic: "past", expires_at: new Date(Date.now() + 1500).toISOString() })).rows[0].id;
  await review(A, notYet, "approve");
  check("an approved item before its expiry is visible to others", await visible(M2, notYet));
  await new Promise((r) => setTimeout(r, 2000));
  check("after its expiry time passes, the database stops showing it to others even though the status is still 'approved'", !(await visible(M2, notYet)) && (await status(notYet)) === "approved");

  // ---- project scope --------------------------------------------------------------------------------------------------
  const pn = (await propose(M1, { kind: "project_note", scope: "project", project_id: P, title: "Harbour deposits", body: "Deposits are held in trust until closing.", topic: "deposits" })).rows[0].id;
  await review(A, pn, "approve");
  check("a member reads an approved note for a visible project", await visible(M2, pn));
  await attempt("authenticated", A, "update public.precon_projects set archived_at = now() where id = $1", [P]);
  check("when the project is archived the approved note disappears for members (project not visible)", !(await visible(M2, pn)));
  check("...but the administrator still reads it", await visible(A, pn));
  check("...and the author still reads their own submission", await visible(M1, pn));
  await attempt("authenticated", A, "update public.precon_projects set archived_at = null where id = $1", [P]);
  check("the project row cannot be deleted while knowledge refers to it (restrict)", !(await attempt("postgres", null, "delete from public.precon_projects where id = $1", [P])).ok);

  // ---- supersession ---------------------------------------------------------------------------------------------------
  check("a replacement may only name an approved item", !(await propose(M2, { supersedes_id: rej, title: "Replace rej", body: "Tries to replace a rejected item." })).ok);
  const rep = await propose(M2, { supersedes_id: K1, title: "Refund approvals v2", body: "Refunds over 1000 need a second approver.", topic: "refunds" });
  check("a member proposes a replacement for an approved item", rep.ok, rep.msg);
  const R = rep.rows?.[0]?.id;
  check("the replaced item is untouched until approval", (await status(K1)) === "approved");
  check("approving the replacement succeeds", (await review(A, R, "approve", "Updated threshold")).ok);
  check("the old item became 'superseded' in the same step and the new one is approved", (await status(K1)) === "superseded" && (await status(R)) === "approved");
  check("both transitions are in the history", (await db.query("select action from public.knowledge_events where item_id = $1 order by created_at, id", [K1])).rows.map((x) => x.action).join(",").includes("superseded"));
  check("a superseded item is invisible to other members", !(await visible(M2, K1)));

  // ---- feedback: metadata only ----------------------------------------------------------------------------------------
  const fb = (who, over = {}) => {
    const v = { actor: who, rating: "not_useful", reason: "wrong", intent: "knowledge", source_ids: ["knowledge"], ...over };
    return attempt("authenticated", who, "insert into public.answer_feedback (actor_id, rating, reason, intent, source_ids) values ($1,$2,$3,$4,$5::text[])", [v.actor, v.rating, v.reason, v.intent, v.source_ids]);
  };
  check("a member records feedback as themself", (await fb(M1)).ok);
  check("a member cannot record feedback as someone else", denied(await fb(M1, { actor: M2 })));
  check("feedback with an unknown rating is refused", !(await fb(M1, { rating: "meh" })).ok);
  check("feedback with free text in reason is refused", !(await fb(M1, { reason: "the answer about Alice was wrong" })).ok);
  check("feedback with free text in source_ids is refused", !(await fb(M1, { source_ids: ["my private note"] })).ok);
  check("a member cannot read feedback (admin-only), not even their own", (await attempt("authenticated", M1, "select id from public.answer_feedback")).rows?.length === 0);
  check("an administrator reads feedback", (await attempt("authenticated", A, "select id from public.answer_feedback")).rows?.length >= 1);
  check("nobody can update or delete feedback", denied(await attempt("authenticated", A, "update public.answer_feedback set rating = 'useful'")) && denied(await attempt("authenticated", A, "delete from public.answer_feedback")));
  check("anon cannot record feedback", denied(await attempt("anon", null, "insert into public.answer_feedback (actor_id, rating) values (null, 'useful')")));

  // ---- burst caps (safety net) ----------------------------------------------------------------------------------------
  let capped = null;
  for (let i = 0; i < 70 && !capped; i++) { const r = await fb(M2, { reason: "other" }); if (!r.ok) capped = r; }
  check("the database caps feedback bursts per user (60/min)", capped && capped.code === "54000", capped?.msg);
  check("the cap is per user (another member is unaffected)", (await fb(M1)).ok);
  let capK = null;
  for (let i = 0; i < 40 && !capK; i++) { const r = await propose(A, { title: `Burst item ${i}`, body: "A burst of submissions from one person.", topic: null }); if (!r.ok) capK = r; }
  check("the database caps submission bursts per user (30/min)", capK && capK.code === "54000", capK?.msg);

  // ---- 0010: the chat audit vocabulary ----------------------------------------------------------------------------------
  const audit = (who, intent, sources) => attempt("authenticated", who, "insert into public.chat_audit (actor_id, intent, outcome, source_ids) values ($1, $2, 'answered', $3::text[])", [who, intent, sources]);
  check("0010: the chat audit accepts the 'knowledge' intent and source", (await audit(M1, "knowledge", ["knowledge"])).ok);
  check("0010: every value valid before 0010 is still valid", (await audit(M1, "preconstruction", ["preconstruction", "tasks"])).ok && (await audit(M1, "help", [])).ok);
  check("0010: 13 source ids are allowed, 14 are not", (await audit(M1, "summary", ["tasks", "activity", "notifications", "ai_inbox", "integrations", "email", "teams", "whatsapp", "calendar", "crm", "documents", "preconstruction", "knowledge"])).ok && !(await audit(M1, "summary", Array(14).fill("tasks"))).ok);
  check("0010: unknown values are still refused", !(await audit(M1, "tell_me_secrets", [])).ok && !(await audit(M1, "help", ["my note"])).ok);
  const cons = (await db.query("select conname from pg_constraint where conrelid = 'public.chat_audit'::regclass and contype = 'c' and conname in ('chat_audit_intent_check','chat_audit_source_ids_check') order by 1")).rows.map((x) => x.conname);
  check("0010: the two re-created constraints carry stable names", cons.length === 2, cons.join(","));

  // ---- the read-only catalog audit passes, and fails when the rules are broken -------------------------------------------
  const catalog = readFileSync(`${root}proposed/tests/0009_catalog_audit.proposed.sql`, "utf8");
  const runAudit = async () => { try { await db.exec(catalog); return null; } catch (e) { return String(e.message).slice(0, 120); } };
  const base = await runAudit();
  check("the read-only catalog audit passes on a correctly applied schema", base === null, base);
  const mutations = [
    ["grant UPDATE to authenticated", "grant update on public.knowledge_items to authenticated", "revoke update on public.knowledge_items from authenticated"],
    ["grant DELETE to authenticated", "grant delete on public.knowledge_items to authenticated", "revoke delete on public.knowledge_items from authenticated"],
    ["grant status insert to authenticated", "grant insert (status) on public.knowledge_items to authenticated", "revoke insert (status) on public.knowledge_items from authenticated"],
    ["grant reviewed_by insert to authenticated", "grant insert (reviewed_by) on public.knowledge_items to authenticated", "revoke insert (reviewed_by) on public.knowledge_items from authenticated"],
    ["grant select to anon", "grant select on public.knowledge_items to anon", "revoke select on public.knowledge_items from anon"],
    ["grant select on events to service_role", "grant select on public.knowledge_events to service_role", "revoke select on public.knowledge_events from service_role"],
    ["let authenticated insert history directly", "grant insert on public.knowledge_events to authenticated", "revoke insert on public.knowledge_events from authenticated"],
    ["grant TRUNCATE on feedback", "grant truncate on public.answer_feedback to authenticated", "revoke truncate on public.answer_feedback from authenticated"],
    ["disable RLS on knowledge_items", "alter table public.knowledge_items disable row level security", "alter table public.knowledge_items enable row level security"],
    ["force RLS on answer_feedback", "alter table public.answer_feedback force row level security", "alter table public.answer_feedback no force row level security"],
    ["let anon execute the review function", "grant execute on function public.knowledge_review(uuid,text,text) to anon", "revoke execute on function public.knowledge_review(uuid,text,text) from anon"],
    ["let authenticated execute a trigger function", "grant execute on function public.knowledge_log_submitted() to authenticated", "revoke execute on function public.knowledge_log_submitted() from authenticated"],
    ["make the review function SECURITY INVOKER", "alter function public.knowledge_review(uuid,text,text) security invoker", "alter function public.knowledge_review(uuid,text,text) security definer"],
    ["clear the review function search_path", "alter function public.knowledge_review(uuid,text,text) reset search_path", "alter function public.knowledge_review(uuid,text,text) set search_path = ''"],
    ["add a free-text column to feedback", "alter table public.answer_feedback add column note text", "alter table public.answer_feedback drop column note"],
    ["add a free-text column to the chat audit", "alter table public.chat_audit add column note text", "alter table public.chat_audit drop column note"],
    ["drop the burst-cap trigger", "drop trigger knowledge_items_burst_cap on public.knowledge_items", "create trigger knowledge_items_burst_cap before insert on public.knowledge_items for each row execute function public.knowledge_items_burst_cap()"],
    ["let members read every row", "drop policy knowledge_items_read on public.knowledge_items; create policy knowledge_items_read on public.knowledge_items for select to authenticated using (true)",
      "drop policy knowledge_items_read on public.knowledge_items; create policy knowledge_items_read on public.knowledge_items for select to authenticated using (public.is_admin() or author_id = auth.uid() or (status = 'approved' and effective_from <= now() and (expires_at is null or expires_at > now()) and (scope = 'organization' or exists (select 1 from public.precon_projects p where p.id = project_id))))"],
    ["let members read feedback", "drop policy answer_feedback_read on public.answer_feedback; create policy answer_feedback_read on public.answer_feedback for select to authenticated using (true)",
      "drop policy answer_feedback_read on public.answer_feedback; create policy answer_feedback_read on public.answer_feedback for select to authenticated using (public.is_admin())"],
  ];
  for (const [name, bad, fix] of mutations) {
    try { await db.exec(bad); } catch (e) { check(`mutation setup failed: ${name}`, false, String(e.message).slice(0, 100)); continue; }
    const msg = await runAudit();
    check(`the catalog audit FAILS when someone breaks it: ${name}`, msg !== null && msg.startsWith("FAILED"), msg ?? "audit still passed");
    try { await db.exec(fix); } catch (e) { check(`mutation restore failed: ${name}`, false, String(e.message).slice(0, 100)); }
  }
  const after = await runAudit();
  check("the catalog audit passes again after every mutation is reverted", after === null, after);
}
process.exitCode = env.print("0009 knowledge + 0010 chat audit vocabulary (local PGlite)") ? 0 : 1;
