// LOCAL ONLY. Executes the DRAFT 0012_knowledge_secret_check.proposed.sql (on top of 0001..0011) on a local PostgreSQL (PGlite) that imitates
// Supabase's roles, and checks that a direct API insert can no longer store the credential formats the database enforces. The same corpus
// (tests/fixtures/secret-corpus.json) is run against the JavaScript patterns by tests/knowledge-secret-drift.test.ts.
// Never connects to any remote database. Does NOT prove the same on a real Supabase project.
//   npm install --no-save @electric-sql/pglite
//   node supabase/proposed/tests/0012_knowledge_secret_check.pglite.mjs
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { IDS, createEnv } from "./lib/pglite_env.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)); // supabase/
const CORPUS = JSON.parse(readFileSync(`${root}../tests/fixtures/secret-corpus.json`, "utf8")).cases;
const CHAIN = [
  `${root}migrations/0001_init.sql`, `${root}proposed/0002_hardening.proposed.sql`, `${root}proposed/0006_profiles_privacy.proposed.sql`,
  `${root}proposed/0007_preconstruction.proposed.sql`, `${root}proposed/0008_chat_audit.proposed.sql`, `${root}proposed/0009_knowledge.proposed.sql`,
  `${root}proposed/0010_chat_audit_vocab.proposed.sql`, `${root}proposed/0011_knowledge_guards.proposed.sql`,
];
const F0012 = `${root}proposed/0012_knowledge_secret_check.proposed.sql`;
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

async function build(files) {
  const env = await createEnv();
  await env.db.exec(STORAGE);
  const applied = await env.apply(files);
  if (!applied) return { env, applied };
  await env.seedUsers();
  const { db, attempt } = env;
  const propose = (who, over = {}) => {
    const v = { kind: "procedure", scope: "organization", project_id: null, title: "Refund approvals", body: "Refunds over 500 need a second approver.", topic: null, source_ref: null, supersedes_id: null, ...over };
    return attempt("authenticated", who, "insert into public.knowledge_items (kind, scope, project_id, title, body, topic, author_id, source_type, source_ref, supersedes_id) values ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9) returning id, status",
      [v.kind, v.scope, v.project_id, v.title, v.body, v.topic, who, v.source_ref, v.supersedes_id]);
  };
  const review = (who, id, action, note = null) => attempt("authenticated", who, "select public.knowledge_review($1, $2, $3)", [id, action, note]);
  const ownerTry = async (sql, params = []) => { try { await db.query(sql, params); return { ok: true }; } catch (e) { return { ok: false, code: e.code, msg: String(e.message) }; } };
  return { env, applied, propose, review, ownerTry, db, attempt };
}

const textOf = (c) => c.parts.join("");
const KEY = "sk" + "-abcdefghijklmnop12345";

// ---- Part 1: BEFORE 0012 (0001..0011 only). Shows the defect exists, so the fix is proven to change something. ----
const before = await build(CHAIN);
if (before.applied) {
  const { env, propose } = before;
  const r = await propose(M1, { body: textOf(CORPUS.find((c) => c.name === "sk- style key")) });
  env.check("BEFORE 0012 (the defect): a member's direct insert can store an sk- style key", r.ok, r.msg);
  const j = await propose(M1, { body: textOf(CORPUS.find((c) => c.name === "jwt")) });
  env.check("BEFORE 0012 (the defect): ...and a JWT", j.ok, j.msg);
}

// ---- Part 2: AFTER 0012. ----
const w = await build([...CHAIN, F0012]);
const { env } = w;
const { check, attempt, denied } = env;
if (w.applied) {
  const { propose, review, ownerTry, db } = w;
  const status = async (id) => (await db.query("select status from public.knowledge_items where id = $1", [id])).rows[0]?.status;
  const count = async () => Number((await db.query("select count(*) n from public.knowledge_items")).rows[0].n);

  // 1. the shared corpus, through a MEMBER session (the direct API path)
  for (const c of CORPUS) {
    const text = textOf(c);
    const n0 = await count();
    const r = await propose(M1, { body: text });
    if (c.db === null) {
      check(`corpus: accepted - ${c.name}`, r.ok, `${r.code} ${r.msg}`);
    } else {
      const m = String(r.msg ?? "");
      const quiet = !m.includes(text.slice(0, 24)) && !m.includes(text.slice(-24));
      check(`corpus: refused with 23514 naming only the pattern (${c.db}) - ${c.name}`, !r.ok && r.code === "23514" && m.includes(`(${c.db})`) && quiet, `${r.code} ${m}`);
      check(`corpus: nothing was stored - ${c.name}`, (await count()) === n0);
    }
  }

  // 2. every checked field, and every role
  check("a key in the TITLE is refused", (await propose(M1, { title: `Key ${KEY}` })).code === "23514");
  check("a key in the SOURCE NOTE is refused", (await propose(M1, { source_ref: `memo ${KEY}` })).code === "23514");
  check("a key in the body of an ADMINISTRATOR's proposal is refused", (await propose(A, { body: `Key ${KEY} for billing` })).code === "23514");
  const ownerInsert = await ownerTry("insert into public.knowledge_items (kind, scope, title, body, author_id) values ('decision','organization','Owner insert', $1, $2)", [`Key ${KEY} for billing`, M1]);
  check("the table owner (postgres) is refused too: no trusted-path bypass", !ownerInsert.ok && ownerInsert.code === "23514", ownerInsert.msg);
  const svc = await attempt("service_role", null, "insert into public.knowledge_items (kind, scope, title, body, author_id) values ('decision','organization','Service insert', $1, $2)", [`Key ${KEY} for billing`, M1]);
  check("service_role still cannot insert at all (no privilege) - unchanged by 0012", denied(svc), `${svc.code} ${svc.msg}`);

  // 3. updates
  const clean = (await propose(M1, { title: "Clean item", body: "Nothing sensitive in this body at all." })).rows[0].id;
  const upd = await ownerTry("update public.knowledge_items set body = $1 where id = $2", [`Key ${KEY} for billing`, clean]);
  check("an owner-level UPDATE that writes a key into the body is refused", !upd.ok && upd.code === "23514", upd.msg);
  check("...and the stored text is unchanged", (await db.query("select body from public.knowledge_items where id = $1", [clean])).rows[0].body === "Nothing sensitive in this body at all.");
  const other = await ownerTry("update public.knowledge_items set review_note = 'ok' where id = $1", [clean]);
  check("an UPDATE of a column the trigger does not watch is not affected", other.ok, other.msg);

  // 4. the rest of the knowledge flow still works
  check("a clean proposal is approved by an administrator as before", (await review(A, clean, "approve", "ok")).ok && (await status(clean)) === "approved");
  check("redaction (0011) still works: its placeholder text is not a secret", (await attempt("authenticated", A, "select public.knowledge_redact($1, 'other')", [clean])).ok && (await status(clean)) === "expired");
  check("a normal insert still succeeds and writes its history row", (await propose(M2, { title: "Burst test", body: "A normal body used to test the other triggers." })).ok
    && Number((await db.query("select count(*) n from public.knowledge_events where action = 'submitted'")).rows[0].n) >= 1);

  // Targets for the note tests are inserted as the table owner (auth.uid() is null, so the 30/min submission cap does not apply).
  const seed = async (title, extra = {}) => (await db.query("insert into public.knowledge_items (kind, scope, title, body, topic, author_id, supersedes_id) values ('procedure','organization',$1,'A clean body for the review note tests.',$2,$3,$4) returning id", [title, extra.topic ?? null, M2, extra.supersedes_id ?? null])).rows[0].id;
  // 4b. administrator review notes (knowledge_review is the only writer; the triggers see every path)
  const noteState = async (id) => (await db.query("select status, review_note, reviewed_by from public.knowledge_items where id = $1", [id])).rows[0];
  const eventCount = async (id) => Number((await db.query("select count(*) n from public.knowledge_events where item_id = $1", [id])).rows[0].n);
  const p1 = (await seed("Note target one"));
  const okNote = await review(A, p1, "approve", "Checked with finance: approvals over 500 need two people. Ref sk-style naming is fine here.");
  check("a normal administrative note is accepted (even text that merely mentions a key prefix)", okNote.ok && (await status(p1)) === "approved", `${okNote.code} ${okNote.msg}`);
  const p2 = (await seed("Note target two"));
  const ev2 = await eventCount(p2);
  const badNote = await review(A, p2, "approve", `Use ${KEY} for billing`);
  check("a credential in an approval note is refused with 23514 and the pattern id only", !badNote.ok && badNote.code === "23514" && String(badNote.msg).includes("(api_key_prefix)") && !String(badNote.msg).includes(KEY.slice(3, 15)), `${badNote.code} ${badNote.msg}`);
  const s2 = await noteState(p2);
  check("...the item is still proposed, with no note, no reviewer, and no extra history row", s2.status === "proposed" && s2.review_note === null && s2.reviewed_by === null && (await eventCount(p2)) === ev2);
  const rej = await review(A, p2, "reject", `Rejected: leaked ${KEY}`);
  check("a credential in a rejection note is refused too", !rej.ok && rej.code === "23514" && (await status(p2)) === "proposed", `${rej.code} ${rej.msg}`);
  const okRej = await review(A, p2, "reject", "Duplicate of an existing procedure.");
  check("a normal rejection note still works", okRej.ok && (await status(p2)) === "rejected");
  const p3 = (await seed("Note target three"));
  await review(A, p3, "approve", null);
  const badExp = await review(A, p3, "expire", `old key ${KEY}`);
  check("a credential in an expire note is refused and the item stays approved", !badExp.ok && badExp.code === "23514" && (await status(p3)) === "approved", `${badExp.code} ${badExp.msg}`);
  for (const c of CORPUS.filter((x) => x.db !== null)) {
    const t = textOf(c);
    const r = await review(A, (await seed(`Corpus note ${c.name}`.slice(0, 60))), "reject", t);
    check(`review note corpus: refused (${c.db}) - ${c.name}`, !r.ok && r.code === "23514" && String(r.msg).includes(`(${c.db})`), `${r.code} ${r.msg}`);
  }
  const zw = await review(A, (await seed("Zero width note")), "reject", "sk-abcdefghij" + String.fromCharCode(0x200b) + "klmnopqrstuv");
  check("a zero-width character does not hide a key in a review note", !zw.ok && zw.code === "23514", `${zw.code} ${zw.msg}`);
  const mnote = await review(M1, p3, "expire", "member trying");
  check("a member still cannot review at all (permissions unchanged)", !mnote.ok && mnote.code === "42501", `${mnote.code} ${mnote.msg}`);
  // direct writes cannot slip a secret into the item note or the history note
  const dItem = await ownerTry("update public.knowledge_items set review_note = $1 where id = $2", [`Use ${KEY} for billing`, p3]);
  check("a direct owner-level UPDATE of review_note to a key is refused", !dItem.ok && dItem.code === "23514", dItem.msg);
  const dEv = await ownerTry("update public.knowledge_events set note = $1 where item_id = $2", [`Use ${KEY} for billing`, p3]);
  check("a direct owner-level UPDATE of a history note to a key is refused", !dEv.ok && dEv.code === "23514", dEv.msg);
  const dIns = await ownerTry("insert into public.knowledge_events (item_id, actor_id, action, from_status, to_status, note) values ($1, $2, 'approved', 'proposed', 'approved', $3)", [p3, A, `Use ${KEY} for billing`]);
  check("a direct owner-level INSERT of a history row with a key is refused", !dIns.ok && dIns.code === "23514", dIns.msg);
  for (const role of ["authenticated", "anon", "service_role"]) {
    const w1 = await attempt(role, role === "authenticated" ? A : null, "update public.knowledge_items set review_note = $1 where id = $2", [`Use ${KEY} for billing`, p3]);
    const w2 = await attempt(role, role === "authenticated" ? A : null, "insert into public.knowledge_events (item_id, actor_id, action, note) values ($1, $2, 'approved', $3)", [p3, A, `Use ${KEY} for billing`]);
    check(`${role} has no direct write path to either note (refused by privilege, not only by the screen)`, denied(w1) && denied(w2), `${w1.code} / ${w2.code}`);
  }
  check("redaction still works on an item with a note (placeholder text is not a secret)", (await attempt("authenticated", A, "select public.knowledge_redact($1, 'secret')", [p1])).ok);

  // 4b2. existing-data compatibility: a row stored BEFORE 0012 that already holds a secret (simulated by disabling the trigger for one insert)
  await db.exec("alter table public.knowledge_items disable trigger knowledge_items_secret_guard");
  const legacy = (await db.query("insert into public.knowledge_items (kind, scope, title, body, author_id) values ('procedure','organization','Legacy item', $1, $2) returning id", [`Key ${KEY} for billing`, M2])).rows[0].id;
  await db.exec("alter table public.knowledge_items enable trigger knowledge_items_secret_guard");
  const legRej = await review(A, legacy, "reject", "Contains a credential.");
  check("a legacy proposal that already holds a secret cannot be approved or rejected (the row is re-checked); it stays proposed", !legRej.ok && legRej.code === "23514" && (await status(legacy)) === "proposed", `${legRej.code} ${legRej.msg}`);
  const legRed = await attempt("authenticated", A, "select public.knowledge_redact($1, 'secret')", [legacy]);
  check("...and the administrator removes it with knowledge_redact, which writes only clean text", legRed.ok && (await status(legacy)) === "rejected", `${legRed.code} ${legRed.msg}`);

  // 4c. strict replacement matching (0011) is unchanged by 0012
  const base = (await propose(M2, { title: "Parking rules", body: "Staff park in lot B.", topic: "parking" })).rows[0].id;
  await review(A, base, "approve", null);
  const diff = (await propose(M2, { title: "Parking rules v2", body: "Staff park in lot C.", topic: "visitors", supersedes_id: base }));
  check("a replacement with a different topic is still refused", !diff.ok, `${diff.code} ${diff.msg}`);
  const same = (await propose(M2, { title: "Parking rules v2", body: "Staff park in lot C.", topic: "parking", supersedes_id: base })).rows[0]?.id;
  check("a same-topic replacement is still accepted and approving it retires the original", !!same && (await review(A, same, "approve", "Updated.")).ok && (await status(base)) === "superseded" && (await status(same)) === "approved");

  // 5. privileges: nobody can call the detector or the guard
  for (const role of ["authenticated", "anon", "service_role"]) {
    const who = role === "authenticated" ? M1 : null;
    check(`${role} cannot execute the detector`, denied(await attempt(role, who, "select public.knowledge_secret_signal('x')")));
    check(`${role} cannot execute the guard function directly`, !(await attempt(role, who, "select public.knowledge_secret_guard()")).ok);
    check(`${role} cannot execute the history guard function directly`, !(await attempt(role, who, "select public.knowledge_events_secret_guard()")).ok);
  }

  // 6. idempotent, and the role after the file is the role before it
  let again = null;
  try { await db.exec(readFileSync(F0012, "utf8")); } catch (e) { again = String(e.message).slice(0, 140); }
  check("running 0012 a second time succeeds (idempotent)", again === null, again);
  check("...and the role after the file is the role before it", (await db.query("select current_user u")).rows[0].u === "postgres");
  check("...and there is still exactly one secret-guard trigger", Number((await db.query("select count(*) n from pg_trigger where tgname = 'knowledge_items_secret_guard' and not tgisinternal")).rows[0].n) === 1);

  // 7. catalog audits and mutations
  const read = (n) => readFileSync(`${root}proposed/tests/${n}`, "utf8");
  const run = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return String(e.message).slice(0, 160); } };
  const a09 = read("0009_catalog_audit.proposed.sql"), a11 = read("0011_catalog_audit.proposed.sql"), a12 = read("0012_catalog_audit.proposed.sql");
  const r09 = await run(a09), r11 = await run(a11), r12 = await run(a12);
  check("the 0009 catalog audit still passes after 0012", r09 === null, r09);
  check("the 0011 catalog audit still passes after 0012", r11 === null, r11);
  check("the 0012 catalog audit passes on a correctly applied schema", r12 === null, r12);
  const REINSTALL = readFileSync(F0012, "utf8");
  const mutations = [
    ["disable the trigger", "alter table public.knowledge_items disable trigger knowledge_items_secret_guard", "alter table public.knowledge_items enable trigger knowledge_items_secret_guard"],
    ["let authenticated execute the detector", "grant execute on function public.knowledge_secret_signal(text) to authenticated", "revoke execute on function public.knowledge_secret_signal(text) from authenticated"],
    ["let anon execute the guard", "grant execute on function public.knowledge_secret_guard() to anon", "revoke execute on function public.knowledge_secret_guard() from anon"],
    ["make the guard SECURITY INVOKER", "alter function public.knowledge_secret_guard() security invoker", "alter function public.knowledge_secret_guard() security definer"],
    ["clear the guard search_path", "alter function public.knowledge_secret_guard() reset search_path", "alter function public.knowledge_secret_guard() set search_path = ''"],
    ["disable the history trigger", "alter table public.knowledge_events disable trigger knowledge_events_secret_guard", "alter table public.knowledge_events enable trigger knowledge_events_secret_guard"],
    ["let anon execute the history guard", "grant execute on function public.knowledge_events_secret_guard() to anon", "revoke execute on function public.knowledge_events_secret_guard() from anon"],
    ["drop review_note from the item trigger", "create or replace trigger knowledge_items_secret_guard before insert or update of title, body, topic, source_ref on public.knowledge_items for each row execute function public.knowledge_secret_guard()", null],
    ["make the trigger insert-only", "create or replace trigger knowledge_items_secret_guard before insert on public.knowledge_items for each row execute function public.knowledge_secret_guard()", null],
    ["make the trigger watch only the body", "create or replace trigger knowledge_items_secret_guard before insert or update of body on public.knowledge_items for each row execute function public.knowledge_secret_guard()", null],
    ["replace the detector with one that finds nothing", "create or replace function public.knowledge_secret_signal(p_text text) returns text language sql immutable set search_path = '' as $f$ select null::text $f$", null],
    ["weaken the detector so zero-width characters evade it", "create or replace function public.knowledge_secret_signal(p_text text) returns text language sql immutable set search_path = '' as $f$ select case when p_text ~ '(^|[^A-Za-z0-9_])(sk|pk|rk)-[A-Za-z0-9_-]{16,}' then 'api_key_prefix' else null end $f$", null],
  ];
  for (const [name, bad, fix] of mutations) {
    const e1 = await run(bad);
    if (e1) { check(`mutation setup failed: ${name}`, false, e1); continue; }
    const msg = await run(a12);
    check(`the 0012 catalog audit FAILS when someone breaks it: ${name}`, msg !== null && msg.includes("FAILED"), msg ?? "audit still passed");
    const e2 = await run(fix ?? REINSTALL);
    if (e2) check(`mutation restore failed: ${name}`, false, e2);
  }
  const rEnd = await run(a12);
  check("the 0012 catalog audit passes again after every mutation is reverted", rEnd === null, rEnd);
  check("...and a review note with a key is still refused after the restores", !(await review(A, (await seed("After restore")), "reject", `x ${KEY}`)).ok);
  check("...and the detector still refuses a key after the restores", (await propose(M1, { body: `Key ${KEY} for billing` })).code === "23514");
}
const okA = before.env.print("0012 secret check, BEFORE state (local PGlite)");
const okB = env.print("0012 knowledge secret check (local PGlite)");
process.exitCode = okA && okB ? 0 : 1;
