// LOCAL ONLY. Executes 0013_org_memory.proposed.sql on a local PostgreSQL (PGlite) that imitates Supabase's roles, and checks the rules the
// persistent organizational memory depends on. Never connects to any remote database.
// Does NOT prove the same on a real Supabase project (PostgREST, real sessions and GoTrue are not involved).
//   node supabase/proposed/tests/0013_org_memory.pglite.mjs
import { fileURLToPath } from "node:url";
import { IDS, createEnv } from "./lib/pglite_env.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)); // supabase/
const env = await createEnv();
const { db, check, attempt, denied } = env;

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
  `${root}proposed/0013_org_memory.proposed.sql`,
]);
if (applied) {
  await env.seedUsers();
  const A = IDS.admin, M1 = IDS.m1;
  const as = (who, sql, params = []) => attempt("authenticated", who, sql, params);

  const upsertDoc = (who, over = {}) => {
    const v = { source: "page-1", title: "Weekly sync", content: "Priya will send the checklist by Friday.", hash: "h1", ...over };
    return as(who, "select public.org_memory_upsert_doc('notion', 'ws', $1, 'https://notion.so/x', $2, 'page', $3, $4::jsonb, '{\"complete\":true}'::jsonb, $5, null::timestamptz, null) as r",
      [v.source, v.title, v.content, JSON.stringify([{ id: "S1", kind: "text", text: v.content }]), v.hash]);
  };
  const docId = async (source = "page-1") => (await db.query("select id from public.org_source_docs where source_id = $1", [source])).rows[0]?.id;
  const upsertEntity = (who, doc, over = {}) => {
    const v = { stable: "stable-0001", type: "task", name: "Send checklist", desc: "Priya sends the checklist.", evidence: ["S1"], basis: "explicit", conf: "high", owner: "Priya", team: null, due: "Friday", unknowns: [], ...over };
    return as(who, "select public.org_memory_upsert_entity($1::uuid, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12::text[]) as r",
      [doc, v.stable, v.type, v.name, v.desc, v.evidence, v.basis, v.conf, v.owner, v.team, v.due, v.unknowns]);
  };
  const ent = async (stable = "stable-0001") => (await db.query("select * from public.org_entities where stable_id = $1", [stable])).rows[0];

  // ---- who may write -----------------------------------------------------------------------------------------------
  const denyDoc = await upsertDoc(M1);
  check("a member cannot write a source document (function refuses)", denied(denyDoc), denyDoc.msg);
  check("anon cannot call the write functions", denied(await attempt("anon", null, "select public.org_memory_upsert_doc('notion','ws','p','u','t','page','c','[]','{}','h',null,null)")));
  check("no API role can insert a document directly (administrators included)", denied(await as(A, "insert into public.org_source_docs (provider, workspace_id, source_id, title) values ('notion','ws','x','t')")));
  check("no API role can update or delete a document directly", denied(await as(A, "update public.org_source_docs set title = 'x'")) && denied(await as(A, "delete from public.org_source_docs")));
  check("service_role holds no privilege on the tables", denied(await attempt("service_role", null, "select id from public.org_source_docs")) && denied(await attempt("service_role", null, "select id from public.org_entities")));

  // ---- L0: created / unchanged / changed ----------------------------------------------------------------------------
  const c1 = await upsertDoc(A);
  check("an administrator stores a document: 'created'", c1.ok && c1.rows[0].r === "created", c1.msg);
  const c2 = await upsertDoc(A);
  check("the same content again is 'unchanged' and creates no second row", c2.ok && c2.rows[0].r === "unchanged" && (await db.query("select count(*)::int n from public.org_source_docs")).rows[0].n === 1, c2.msg);
  const D = await docId();
  await as(A, "select public.org_memory_mark_extracted($1::uuid, 'h1', null)", [D]);
  check("extraction is recorded against the content hash", (await db.query("select extracted_hash from public.org_source_docs where id = $1", [D])).rows[0].extracted_hash === "h1");
  const c3 = await upsertDoc(A, { content: "Priya will send the checklist by Monday.", hash: "h2" });
  check("changed content is detected ('changed') and the old extraction hash no longer matches", c3.ok && c3.rows[0].r === "changed" && (await db.query("select extracted_hash <> content_hash as stale from public.org_source_docs where id = $1", [D])).rows[0].stale === true, c3.msg);
  check("an unknown extraction error code is refused", !(await as(A, "select public.org_memory_mark_extracted($1::uuid, 'h2', 'raw error text')", [D])).ok);

  // ---- failures: a fixed vocabulary, counted ------------------------------------------------------------------------
  check("a raw error string is refused as a failure code", !(await as(A, "select public.org_memory_record_failure('notion','ws','page-2','Other','https://notion.so/y','secret_token_abc')")).ok);
  await as(A, "select public.org_memory_record_failure('notion','ws','page-2','Other','https://notion.so/y','rate_limited')");
  await as(A, "select public.org_memory_record_failure('notion','ws','page-2','Other','https://notion.so/y','timeout')");
  const f = (await db.query("select sync_status, attempts, last_error, content from public.org_source_docs where source_id = 'page-2'")).rows[0];
  check("a failed source keeps a counter, the last fixed code and no content", f?.sync_status === "failed" && f.attempts === 2 && f.last_error === "timeout" && f.content === "", JSON.stringify(f));

  // ---- L1: create, idempotent, proposed update ----------------------------------------------------------------------
  const e1 = await upsertEntity(A, D);
  check("an extracted record is created as 'proposed'", e1.ok && e1.rows[0].r === "created" && (await ent()).review_status === "proposed", e1.msg);
  check("the same extraction again changes nothing", (await upsertEntity(A, D)).rows[0].r === "unchanged");
  check("a member cannot write a record", denied(await upsertEntity(M1, D, { stable: "stable-0002" })));
  check("an inferred record cannot be 'high' confidence (constraint)", !(await upsertEntity(A, D, { stable: "stable-0003", basis: "inferred", conf: "high" })).ok);
  check("a record with basis 'unknown' cannot carry an owner (constraint)", !(await upsertEntity(A, D, { stable: "stable-0004", basis: "unknown", conf: "low", owner: "Priya" })).ok);
  check("a record without evidence is refused (constraint)", !(await upsertEntity(A, D, { stable: "stable-0005", evidence: [] })).ok);
  const e2 = await upsertEntity(A, D, { due: "Monday" });
  check("a proposed record is updated in place by a new extraction", e2.rows?.[0]?.r === "updated" && (await ent()).due === "Monday", e2.msg);

  // ---- review: members cannot, approval is final, nothing is silently overwritten -----------------------------------
  const E = (await ent()).id;
  check("a member cannot review", denied(await as(M1, "select public.org_memory_review($1::uuid, 'approve', null)", [E])));
  check("an administrator approves: status 'reviewed'", (await as(A, "select public.org_memory_review($1::uuid, 'approve', 'ok')", [E])).ok && (await ent()).review_status === "reviewed");
  check("approving twice is refused", !(await as(A, "select public.org_memory_review($1::uuid, 'approve', null)", [E])).ok);
  const e3 = await upsertEntity(A, D, { due: "Tuesday", desc: "Priya sends the checklist on Tuesday." });
  const after = await ent();
  check("a different extraction does NOT overwrite a reviewed record: it is staled with a pending revision", e3.rows?.[0]?.r === "staled" && after.stale === true && after.due === "Monday" && after.pending_revision?.due === "Tuesday", e3.msg);
  check("accepting the revision applies it and clears the stale flag", (await as(A, "select public.org_memory_review($1::uuid, 'accept_revision', 'newer notes')", [E])).ok && (await ent()).due === "Tuesday" && (await ent()).stale === false);
  check("the review history is kept and readable by an administrator only",
    (await as(A, "select count(*)::int n from public.org_entity_events")).rows[0].n === 2 && (await as(M1, "select count(*)::int n from public.org_entity_events")).rows[0].n === 0);
  check("the history cannot be written directly", denied(await as(A, "insert into public.org_entity_events (entity_id, action) values ($1, 'approve')", [E])));

  // ---- rejection sticks -----------------------------------------------------------------------------------------------
  await upsertEntity(A, D, { stable: "stable-0006", name: "Old risk", type: "risk", desc: "A risk.", owner: null, due: null, basis: "extracted", conf: "medium", unknowns: ["owner"] });
  const R = (await ent("stable-0006")).id;
  await as(A, "select public.org_memory_review($1::uuid, 'reject', 'not a risk')", [R]);
  check("a re-extraction does not bring a rejected record back", (await upsertEntity(A, D, { stable: "stable-0006", type: "risk", desc: "A different risk text.", owner: null, due: null, basis: "extracted", conf: "medium", unknowns: ["owner"] })).rows[0].r === "unchanged" && (await ent("stable-0006")).review_status === "rejected");

  // ---- records the source no longer states are staled, not deleted ---------------------------------------------------
  await upsertEntity(A, D, { stable: "stable-0007", name: "Dropped item", type: "task", desc: "Something no longer stated.", owner: null, due: null, basis: "extracted", conf: "medium", unknowns: ["owner", "due"] });
  const n = await as(A, "select public.org_memory_stale_missing($1::uuid, $2::text[]) as n", [D, ["stable-0001"]]);
  check("records missing from the newest extraction are marked stale, not deleted (rejected ones are left alone)", n.ok && Number(n.rows[0].n) === 1 && (await ent("stable-0007")).stale === true && (await ent("stable-0006")).stale === false, n.msg);

  // ---- promotion goes through the Knowledge workflow ------------------------------------------------------------------
  const K = await as(A, "insert into public.knowledge_items (kind, scope, project_id, title, body, topic, author_id, source_type, source_ref) values ('decision','organization',null,'Checklist owner','Priya owns the checklist.',null,$1,'manual','Notion: Weekly sync') returning id, status", [A]);
  check("a Knowledge proposal starts as PROPOSED (existing path)", K.ok && K.rows[0].status === "proposed", K.msg);
  check("an unreviewed (proposed) record cannot be marked as promoted", !(await as(A, "select public.org_memory_mark_promotion($1::uuid, $2::uuid)", [R, K.rows?.[0]?.id])).ok);
  check("a reviewed, current record can be marked as proposed to Knowledge", (await as(A, "select public.org_memory_mark_promotion($1::uuid, $2::uuid)", [E, K.rows?.[0]?.id])).ok && (await ent()).review_status === "promotion_proposed");
  check("the memory function never approves the Knowledge item", (await db.query("select status from public.knowledge_items where id = $1", [K.rows?.[0]?.id])).rows[0].status === "proposed");

  // ---- ingestion runs: one at a time, administrators only, counts only ----------------------------------------------------
  check("a member cannot start an ingestion run", denied(await as(M1, "select public.org_memory_run_start() as id")));
  check("anon cannot start an ingestion run", denied(await attempt("anon", null, "select public.org_memory_run_start()")));
  const r1 = await as(A, "select public.org_memory_run_start() as id");
  check("an administrator takes the ingestion slot", r1.ok && !!r1.rows[0].id, r1.msg);
  const r2 = await as(A, "select public.org_memory_run_start() as id");
  check("a second concurrent run is refused (55P03)", !r2.ok && r2.code === "55P03", r2.msg);
  check("a member cannot finish someone else's run", denied(await as(M1, "select public.org_memory_run_finish($1::uuid, 'ok', '{}'::jsonb)", [r1.rows?.[0]?.id])));
  check("an unknown run status is refused", !(await as(A, "select public.org_memory_run_finish($1::uuid, 'weird', '{}'::jsonb)", [r1.rows?.[0]?.id])).ok);
  check("finishing records the counts and frees the slot", (await as(A, "select public.org_memory_run_finish($1::uuid, 'ok', '{\"created\":2}'::jsonb)", [r1.rows?.[0]?.id])).ok && (await as(A, "select public.org_memory_run_start() as id")).ok);
  check("a run cannot be finished twice", !(await as(A, "select public.org_memory_run_finish($1::uuid, 'ok', '{}'::jsonb)", [r1.rows?.[0]?.id])).ok);
  await db.exec("update public.org_ingest_runs set started_at = now() - interval '30 minutes' where finished_at is null");
  const r3 = await as(A, "select public.org_memory_run_start() as id");
  check("a run abandoned for 15+ minutes is closed as failed and the slot can be taken again", r3.ok && (await db.query("select count(*)::int n from public.org_ingest_runs where status = 'failed'")).rows[0].n === 1, r3.msg);
  check("runs are readable by administrators only; no direct writes", (await as(A, "select count(*)::int n from public.org_ingest_runs")).rows[0].n >= 3 && (await as(M1, "select count(*)::int n from public.org_ingest_runs")).rows[0].n === 0 && denied(await as(A, "insert into public.org_ingest_runs (status) values ('ok')")));

  // ---- reads ---------------------------------------------------------------------------------------------------------
  check("an administrator reads documents and records", (await as(A, "select count(*)::int n from public.org_source_docs")).rows[0].n >= 2 && (await as(A, "select count(*)::int n from public.org_entities")).rows[0].n >= 2);
  check("a member reads no document and no record", (await as(M1, "select count(*)::int n from public.org_source_docs")).rows[0].n === 0 && (await as(M1, "select count(*)::int n from public.org_entities")).rows[0].n === 0);
  check("anon reads nothing", denied(await attempt("anon", null, "select id from public.org_entities")));
}
process.exit(env.print("0013 organizational memory") ? 0 : 1);
