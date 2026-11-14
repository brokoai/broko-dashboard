// LOCAL ONLY. Executes the DRAFT 0011_knowledge_guards.proposed.sql (on top of 0001..0010) on a local PostgreSQL (PGlite) that imitates
// Supabase's roles, and checks the two fixes it makes: replacements must match in scope and project, and administrators can remove the
// content of an item. Never connects to any remote database. Does NOT prove the same on a real Supabase project.
//   npm install --no-save @electric-sql/pglite
//   node supabase/proposed/tests/0011_knowledge_guards.pglite.mjs
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { IDS, createEnv } from "./lib/pglite_env.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)); // supabase/
const CHAIN = [
  `${root}migrations/0001_init.sql`, `${root}proposed/0002_hardening.proposed.sql`, `${root}proposed/0006_profiles_privacy.proposed.sql`,
  `${root}proposed/0007_preconstruction.proposed.sql`, `${root}proposed/0008_chat_audit.proposed.sql`, `${root}proposed/0009_knowledge.proposed.sql`,
  `${root}proposed/0010_chat_audit_vocab.proposed.sql`,
];
const F0011 = `${root}proposed/0011_knowledge_guards.proposed.sql`;
const STORAGE = `
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null references storage.buckets (id), name text not null);
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant select on storage.buckets to authenticated;
`;
const A = IDS.admin, M1 = IDS.m1, M2 = IDS.m2;

/** Builds one local database and returns the helpers the scenarios share. */
async function build(files) {
  const env = await createEnv();
  await env.db.exec(STORAGE);
  const applied = await env.apply(files);
  if (!applied) return { env, applied };
  await env.seedUsers();
  const { db, attempt } = env;
  const mkProject = async (name) => (await attempt("authenticated", A, "insert into public.precon_projects (name, created_by) values ($1, $2) returning id", [name, A])).rows?.[0]?.id;
  const propose = (who, over = {}) => {
    const v = { kind: "procedure", scope: "organization", project_id: null, title: "Refund approvals", body: "Refunds over 500 need a second approver.", topic: null, source_type: "manual", source_ref: null, supersedes_id: null, expires_at: null, author: who, ...over };
    if (v.kind === "correction") v.source_type = "correction";
    return attempt("authenticated", who, "insert into public.knowledge_items (kind, scope, project_id, title, body, topic, author_id, source_type, source_ref, supersedes_id, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, status",
      [v.kind, v.scope, v.project_id, v.title, v.body, v.topic, v.author, v.source_type, v.source_ref, v.supersedes_id, v.expires_at]);
  };
  const review = (who, id, action, note = null) => attempt("authenticated", who, "select public.knowledge_review($1, $2, $3)", [id, action, note]);
  const approved = async (over) => { const r = await propose(M1, over); const id = r.rows?.[0]?.id; if (id) await review(A, id, "approve"); return id; };
  const status = async (id) => (await db.query("select status from public.knowledge_items where id = $1", [id])).rows[0]?.status;
  const visible = async (who, id) => (await attempt("authenticated", who, "select id from public.knowledge_items where id = $1", [id])).rows?.length === 1;
  return { env, applied, mkProject, propose, review, approved, status, visible };
}

// ===================================================================================================================
// Part 1: BEFORE 0011 (0001..0010 only). Shows the defect exists, so the fix is proven to change something.
// ===================================================================================================================
const before = await build(CHAIN);
{
  const { check } = before.env;
  if (before.applied) {
    const { attempt } = before.env;
    const P = await before.mkProject("Harbour");
    const orgItem = await before.approved({ title: "Company refund rule", body: "Refunds over 500 need a second approver." });
    const mismatch = await before.propose(M2, { kind: "project_note", scope: "project", project_id: P, supersedes_id: orgItem, title: "Harbour note", body: "A project note that names an organization item." });
    check("BEFORE 0011 (the defect): a project proposal may name an organization-wide item as the one to replace", mismatch.ok, mismatch.msg);
    if (mismatch.ok) {
      await before.review(A, mismatch.rows[0].id, "approve");
      check("BEFORE 0011 (the defect): approving it silently retires the organization-wide item", (await before.status(orgItem)) === "superseded");
    }
    check("BEFORE 0011: the redaction function does not exist yet", !(await attempt("authenticated", A, "select public.knowledge_redact(gen_random_uuid(), 'secret')")).ok);
  }
}

// ===================================================================================================================
// Part 2: AFTER 0011.
// ===================================================================================================================
const w = await build([...CHAIN, F0011]);
const { env } = w;
const { db, check, attempt, denied } = env;
if (w.applied) {
  const { propose, review, approved, status, visible, mkProject } = w;
  const P1 = await mkProject("Harbour"), P2 = await mkProject("Marina"), PX = await mkProject("Old");
  check("fixtures: three projects exist", !!P1 && !!P2 && !!PX);
  await attempt("authenticated", A, "update public.precon_projects set archived_at = now() where id = $1", [PX]);
  const note = (id, over = {}) => ({ kind: "project_note", scope: "project", project_id: P1, supersedes_id: id, title: "Replacement note", body: "A replacement written by a member.", ...over });

  // ---- 1. a replacement must match in scope and project (insert policy) -----------------------------------------------
  const org = await approved({ title: "Company refund rule", body: "Refunds over 500 need a second approver." });
  const pn1 = await approved({ kind: "project_note", scope: "project", project_id: P1, title: "Harbour parking", body: "Parking is included with penthouses." });
  check("fixtures: an approved organization item and an approved project note exist", (await status(org)) === "approved" && (await status(pn1)) === "approved");

  check("an organization proposal may replace an organization item", (await propose(M2, { supersedes_id: org, title: "Refund rule v2", body: "Refunds over 1000 need a second approver." })).ok);
  check("a project proposal may replace a note of the SAME project", (await propose(M2, note(pn1))).ok);
  check("a project proposal may NOT replace an organization item", denied(await propose(M2, note(org))));
  check("an organization proposal may NOT replace a project note", denied(await propose(M2, { supersedes_id: pn1, title: "Org over project", body: "Tries to replace a project note." })));
  check("a proposal for project 2 may NOT replace a note of project 1", denied(await propose(M2, note(pn1, { project_id: P2 }))));
  check("a replacement may still only name an APPROVED item", denied(await propose(M2, { supersedes_id: (await propose(M1, { title: "Still proposed", body: "Nobody approved this one yet." })).rows[0].id, title: "Replace proposed", body: "Names an item that is not approved." })));
  check("a replacement may not name an item that does not exist", denied(await propose(M2, { supersedes_id: "00000000-0000-0000-0000-0000000000ee", title: "Replace ghost", body: "Names an item that does not exist." })));

  // ---- 2. approval time: a mismatched row that got past the policy is still refused, and nothing changes ---------------
  const sneaky = (await db.query("insert into public.knowledge_items (kind, scope, project_id, title, body, author_id, supersedes_id) values ('decision','organization',null,'Sneaky replacement','Inserted by the owner to bypass the policy.', $1, $2) returning id", [M1, pn1])).rows[0].id;
  const refused = await review(A, sneaky, "approve");
  check("approving a replacement of another scope/project is refused with a check violation (23514)", !refused.ok && refused.code === "23514", `${refused.code} ${refused.msg}`);
  check("...and the item it named is still approved, the proposal still proposed", (await status(pn1)) === "approved" && (await status(sneaky)) === "proposed");
  check("...and no 'superseded' history row was written for it", (await db.query("select 1 from public.knowledge_events where item_id = $1 and action = 'superseded'", [pn1])).rows.length === 0);
  check("the administrator can still reject it", (await review(A, sneaky, "reject", "Does not match the item it names")).ok);
  const good = (await propose(M2, note(pn1, { title: "Harbour parking v2", body: "Parking costs extra for non-penthouse units." }))).rows[0].id;
  check("a matching replacement is approved and retires its target in the same step", (await review(A, good, "approve", "Updated")).ok && (await status(pn1)) === "superseded" && (await status(good)) === "approved");
  const orgRep = (await propose(M2, { supersedes_id: org, title: "Refund rule v3", body: "Refunds over 2000 need a second approver." })).rows[0].id;
  check("an organization replacement still works as before", (await review(A, orgRep, "approve")).ok && (await status(org)) === "superseded");

  // ---- 2b. topic: a replacement must also carry the same topic (null-safe) ----------------------------------------------
  const tRule = await approved({ title: "Refund limits", body: "Refunds over 500 need a second approver.", topic: "refund-limits" });
  const tPlain = await approved({ title: "Office hours", body: "The office opens at nine in the morning." });
  const tProj = await approved({ kind: "project_note", scope: "project", project_id: P1, title: "Harbour deposits", body: "Deposits are ten percent at signing.", topic: "deposits" });
  const rep = (id, over = {}) => propose(M2, { supersedes_id: id, title: "Topic replacement", body: "A replacement used to test topic matching.", ...over });
  check("a replacement with the SAME topic is accepted", (await rep(tRule, { topic: "refund-limits" })).ok);
  check("a replacement with a DIFFERENT topic is refused by the policy", denied(await rep(tRule, { topic: "refund-process" })));
  check("a replacement with NO topic cannot replace an item that has one", denied(await rep(tRule, { topic: null })));
  check("a replacement WITH a topic cannot replace an item that has none", denied(await rep(tPlain, { topic: "office-hours" })));
  check("two items without a topic match each other", (await rep(tPlain, { topic: null })).ok);
  check("a project replacement of the same project but another topic is refused", denied(await propose(M2, note(tProj, { topic: "parking" }))));
  check("a project replacement of the same project and topic is accepted", (await propose(M2, note(tProj, { topic: "deposits" }))).ok);
  const sneakyTopic = (await db.query("insert into public.knowledge_items (kind, scope, project_id, title, body, topic, author_id, supersedes_id) values ('procedure','organization',null,'Sneaky topic','Inserted by the owner to bypass the policy.', 'refund-process', $1, $2) returning id", [M1, tRule])).rows[0].id;
  const topicRefused = await review(A, sneakyTopic, "approve");
  check("approving a replacement with another topic is refused (23514) and says why", !topicRefused.ok && topicRefused.code === "23514" && /topic/.test(topicRefused.msg), `${topicRefused.code} ${topicRefused.msg}`);
  check("...nothing changed: the target is still approved, no 'superseded' history row exists", (await status(tRule)) === "approved" && (await status(sneakyTopic)) === "proposed"
    && (await db.query("select 1 from public.knowledge_events where item_id = $1 and action = 'superseded'", [tRule])).rows.length === 0);
  check("an anonymous caller cannot execute the replacement helper", denied(await attempt("anon", null, "select public.knowledge_can_replace($1, 'organization', null, 'refund-limits')", [tRule])));
  const topicOk = (await rep(tRule, { topic: "refund-limits", title: "Refund limits v2", body: "Refunds over 1000 need a second approver." })).rows[0].id;
  check("a matching topic is approved and retires its target", (await review(A, topicOk, "approve")).ok && (await status(tRule)) === "superseded");

  // ---- 3. redaction: who may call it, and what it does ---------------------------------------------------------------
  const red = (who, id, reason = "secret") => attempt("authenticated", who, "select public.knowledge_redact($1, $2)", [id, reason]);
  const MARK = "hunter2-TOPSECRET";
  const s1 = (await propose(M1, { title: `Wifi ${MARK}`, body: `The wifi password is ${MARK} for the office.`, topic: "wifi", source_ref: `sticky note ${MARK}` })).rows[0].id;
  const s2 = await approved({ title: "Alarm code", body: `The alarm code is ${MARK} until further notice.`, topic: "alarm", source_ref: `memo ${MARK}` });
  await db.query("update public.knowledge_events set note = $2 where item_id = $1 and action = 'approved'", [s2, `Approved, but it contains ${MARK}`]);
  const s3 = (await propose(M1, { title: `Rejected ${MARK}`, body: `A rejected proposal that contains ${MARK} too.` })).rows[0].id;
  await review(A, s3, "reject", `Rejected because of ${MARK}`);
  const s4 = await approved({ title: `Old rule ${MARK}`, body: `An old rule that contains ${MARK} in the body.` });
  const s4rep = (await propose(M2, { supersedes_id: s4, title: "New rule", body: "The new rule replaces the old one cleanly." })).rows[0].id;
  await review(A, s4rep, "approve");
  const countRows = async () => Number((await db.query("select count(*) n from public.knowledge_items")).rows[0].n);
  const countEvents = async () => Number((await db.query("select count(*) n from public.knowledge_events")).rows[0].n);
  const leaked = async () => Number((await db.query(`select (select count(*) from public.knowledge_items where concat_ws(' ', title, body, topic, source_ref, review_note) like '%${MARK}%')
    + (select count(*) from public.knowledge_events where note like '%${MARK}%') n`)).rows[0].n);
  check("fixtures: the marker is stored in items and in history notes", (await leaked()) >= 4);
  check("fixtures: a rejected and a superseded item exist", (await status(s3)) === "rejected" && (await status(s4)) === "superseded");

  for (const [who, name] of [[M1, "the author of the item"], [M2, "another member"]]) check(`${name} cannot remove content`, denied(await red(who, s1)));
  check("anon cannot call the removal function", denied(await attempt("anon", null, "select public.knowledge_redact($1, 'secret')", [s1])));
  check("service_role cannot call the removal function", denied(await attempt("service_role", null, "select public.knowledge_redact($1, 'secret')", [s1])));
  check("nothing changed after those refusals", (await leaked()) >= 4 && (await status(s1)) === "proposed");
  for (const bad of [null, "", "because", "SECRET", "secret; drop table x"]) check(`an unknown reason is refused: ${JSON.stringify(bad)}`, (await red(A, s1, bad)).code === "22023");
  check("a missing item is refused (P0002)", (await red(A, "00000000-0000-0000-0000-0000000000ee")).code === "P0002");

  const rows0 = await countRows(), events0 = await countEvents();
  check("an administrator removes the content of a PROPOSED item", (await red(A, s1)).ok);
  const r1 = (await db.query("select title, body, topic, source_ref, review_note, status, redacted_at is not null as gone, reviewed_by from public.knowledge_items where id = $1", [s1])).rows[0];
  check("...title and body are fixed text, topic, source and note are cleared", r1.title === "[Removed]" && r1.body.startsWith("The content of this item was removed") && r1.topic === null && r1.source_ref === null && r1.review_note === null, JSON.stringify(r1));
  check("...a proposed item becomes 'rejected', is marked removed and shows who removed it", r1.status === "rejected" && r1.gone && r1.reviewed_by === A);
  check("...it can never be approved afterwards", !(await review(A, s1, "approve")).ok);
  check("...its author still sees the item, now with the placeholder text", (await visible(M1, s1)) && (await db.query("select title from public.knowledge_items where id = $1", [s1])).rows[0].title === "[Removed]");

  check("an administrator removes the content of an APPROVED item", (await red(A, s2, "personal_data")).ok);
  const r2 = (await db.query("select status, review_note, reviewed_by, redacted_at is not null as gone from public.knowledge_items where id = $1", [s2])).rows[0];
  check("...it stops being used (expired), keeps the original approver, and is marked removed", r2.status === "expired" && r2.reviewed_by === A && r2.gone && r2.review_note === null, JSON.stringify(r2));
  check("...other members can no longer read it", !(await visible(M2, s2)));
  check("a rejected item is cleaned and stays rejected", (await red(A, s3, "other")).ok && (await status(s3)) === "rejected");
  check("a superseded item is cleaned and stays superseded", (await red(A, s4, "incorrect")).ok && (await status(s4)) === "superseded");
  check("removing twice is refused (55000)", (await red(A, s1)).code === "55000");

  const ev = (await db.query("select action, note from public.knowledge_events where item_id = $1 order by created_at, id", [s2])).rows;
  check("history keeps who and what happened, with no free text: the old notes are gone and one fixed 'redacted' row exists",
    ev.some((e) => e.action === "redacted" && e.note === "Content removed (personal data)") && ev.every((e) => e.action === "redacted" || e.note === null), JSON.stringify(ev));
  check("NOWHERE in the knowledge tables does the removed text remain", (await leaked()) === 0, `${await leaked()} rows still contain it`);
  check("no row was deleted; exactly four 'redacted' history rows were added", (await countRows()) === rows0 && (await countEvents()) === events0 + 4, `${rows0}->${await countRows()} / ${events0}->${await countEvents()}`);
  check("other items are untouched", (await status(good)) === "approved" && (await status(orgRep)) === "approved");
  check("the history vocabulary refuses unknown actions", !(await db.query("insert into public.knowledge_events (item_id, action, to_status) values ($1, 'wiped', 'expired')", [s1]).then(() => true, () => false)));
  for (const stmt of ["update public.knowledge_items set title = 'x'", "delete from public.knowledge_items", "update public.knowledge_items set redacted_at = null"]) {
    check(`an administrator still cannot run: ${stmt} (no privilege)`, denied(await attempt("authenticated", A, stmt)));
  }

  // ---- 3b. failure cases and boundaries around redaction (Phase 2 additions) -----------------------------------------------
  check("a missing (NULL) id is refused (P0002)", (await red(A, null)).code === "P0002");
  check("a redacted item cannot be expired afterwards (55000)", (await review(A, s2, "expire")).code === "55000");
  check("a member cannot set redacted_at when proposing (no column privilege)", denied(await attempt("authenticated", M1,
    "insert into public.knowledge_items (kind, scope, title, body, author_id, redacted_at) values ('decision','organization','Forged mark','A member tries to pre-mark the item.', $1, now())", [M1])));
  check("a proposal cannot name a redacted (expired) item as the one to replace", denied(await propose(M2, { supersedes_id: s2, title: "Replace removed", body: "Names an item whose content was removed." })));
  const keep = await approved({ title: "Keep my note", body: "This item must be untouched by other removals." });
  await db.query("update public.knowledge_events set note = 'reviewer note to keep' where item_id = $1 and action = 'approved'", [keep]);
  const target = await approved({ title: "Soon removed", body: "This item will be removed while a replacement is pending." });
  const pending = (await propose(M2, { supersedes_id: target, title: "Pending replacement", body: "A replacement proposed before the target was removed." })).rows[0].id;
  check("redacting the target of a pending replacement works", (await red(A, target, "incorrect")).ok && (await status(target)) === "expired");
  check("...approving the pending replacement afterwards succeeds and does not supersede the removed item", (await review(A, pending, "approve")).ok
    && (await status(pending)) === "approved" && (await status(target)) === "expired"
    && (await db.query("select 1 from public.knowledge_events where item_id = $1 and action = 'superseded'", [target])).rows.length === 0);
  check("removing other items did not touch this item's history note", (await db.query("select note from public.knowledge_events where item_id = $1 and action = 'approved'", [keep])).rows[0]?.note === "reviewer note to keep");
  check("the removal history row for each reason uses fixed text", (await db.query("select count(*) n from public.knowledge_events where action = 'redacted' and note !~ '^Content removed [(](secret|personal data|incorrect|other)[)]$'")).rows[0].n == 0);

  // ---- 4. 0011 can be run twice, and leaves the same state ------------------------------------------------------------
  let again = null;
  try { await db.exec(readFileSync(F0011, "utf8")); } catch (e) { again = String(e.message).slice(0, 140); }
  check("running 0011 a second time succeeds (idempotent)", again === null, again);
  check("...and the role after the file is the role before it", (await db.query("select current_user u")).rows[0].u === "postgres");

  // ---- 5. the read-only catalog audits ---------------------------------------------------------------------------------
  const audit09 = readFileSync(`${root}proposed/tests/0009_catalog_audit.proposed.sql`, "utf8");
  const audit11 = readFileSync(`${root}proposed/tests/0011_catalog_audit.proposed.sql`, "utf8");
  const run = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return String(e.message).slice(0, 140); } };
  check("the 0009 catalog audit still passes after 0011", (await run(audit09)) === null, await run(audit09));
  check("the 0011 catalog audit passes on a correctly applied schema", (await run(audit11)) === null, await run(audit11));
  const POLICY_NEW = "alter policy knowledge_items_insert on public.knowledge_items with check (author_id = auth.uid() and status = 'proposed' and reviewed_by is null and reviewed_at is null and review_note is null and (scope = 'organization' or exists (select 1 from public.precon_projects p where p.id = project_id)) and (supersedes_id is null or public.knowledge_can_replace(supersedes_id, scope, project_id, topic)))";
  const POLICY_OLD = "alter policy knowledge_items_insert on public.knowledge_items with check (author_id = auth.uid() and status = 'proposed' and reviewed_by is null and reviewed_at is null and review_note is null and (scope = 'organization' or exists (select 1 from public.precon_projects p where p.id = project_id)) and (supersedes_id is null or public.knowledge_replaceable(supersedes_id)))";
  const ACTION_OK = "alter table public.knowledge_events add constraint knowledge_events_action_check check (action in ('submitted','approved','rejected','expired','superseded','redacted'))";
  const mutations = [
    ["let anon execute the removal function", "grant execute on function public.knowledge_redact(uuid,text) to anon", "revoke execute on function public.knowledge_redact(uuid,text) from anon"],
    ["let service_role execute the removal function", "grant execute on function public.knowledge_redact(uuid,text) to service_role", "revoke execute on function public.knowledge_redact(uuid,text) from service_role"],
    ["make the removal function SECURITY INVOKER", "alter function public.knowledge_redact(uuid,text) security invoker", "alter function public.knowledge_redact(uuid,text) security definer"],
    ["clear the removal function search_path", "alter function public.knowledge_redact(uuid,text) reset search_path", "alter function public.knowledge_redact(uuid,text) set search_path = ''"],
    ["make the replacement helper SECURITY INVOKER", "alter function public.knowledge_can_replace(uuid,text,uuid,text) security invoker", "alter function public.knowledge_can_replace(uuid,text,uuid,text) security definer"],
    ["let authenticated write redacted_at", "grant update (redacted_at) on public.knowledge_items to authenticated", "revoke update (redacted_at) on public.knowledge_items from authenticated"],
    ["grant DELETE on the items table", "grant delete on public.knowledge_items to authenticated", "revoke delete on public.knowledge_items from authenticated"],
    ["go back to the 0009 insert policy (no scope match)", POLICY_OLD, POLICY_NEW],
    ["remove 'redacted' from the history vocabulary", "alter table public.knowledge_events drop constraint knowledge_events_action_check; alter table public.knowledge_events add constraint knowledge_events_action_check check (action in ('submitted','approved','rejected','expired','superseded')) not valid",
      `alter table public.knowledge_events drop constraint knowledge_events_action_check; ${ACTION_OK}`],
  ];
  for (const [name, bad, fix] of mutations) {
    try { await db.exec(bad); } catch (e) { check(`mutation setup failed: ${name}`, false, String(e.message).slice(0, 100)); continue; }
    const msg = await run(audit11);
    check(`the 0011 catalog audit FAILS when someone breaks it: ${name}`, msg !== null && msg.startsWith("FAILED"), msg ?? "audit still passed");
    try { await db.exec(fix); } catch (e) { check(`mutation restore failed: ${name}`, false, String(e.message).slice(0, 100)); }
  }
  check("the 0011 catalog audit passes again after every mutation is reverted", (await run(audit11)) === null, await run(audit11));
}
const okA = before.env.print("0011 guards, BEFORE state (local PGlite)");
const okB = env.print("0011 knowledge guards (local PGlite)");
process.exitCode = okA && okB ? 0 : 1;
