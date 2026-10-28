// LOCAL ONLY. Executes 0008_chat_audit.proposed.sql on a local PostgreSQL (PGlite) that imitates Supabase's roles, and checks the
// rules the chat audit trail depends on. Never connects to any remote database. Does NOT prove the same on a real Supabase project.
//   npm install --no-save @electric-sql/pglite
//   node supabase/proposed/tests/0008_chat_audit.pglite.mjs
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { IDS, createEnv } from "./lib/pglite_env.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)); // supabase/
const env = await createEnv();
const { db, check, attempt, denied } = env;

const applied = await env.apply([`${root}migrations/0001_init.sql`, `${root}proposed/0008_chat_audit.proposed.sql`]);
if (applied) {
  await env.seedUsers();
  const ins = (who, actor, over = {}) => {
    const v = { intent: "pending_tasks", outcome: "answered", project_id: null, source_ids: ["tasks"], record_count: 3, has_evidence: true, used_model: false, latency_ms: 42, ...over };
    return attempt("authenticated", who, "insert into public.chat_audit (actor_id, intent, outcome, project_id, source_ids, record_count, has_evidence, used_model, latency_ms) values ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)",
      [actor, v.intent, v.outcome, v.project_id, v.source_ids, v.record_count, v.has_evidence, v.used_model, v.latency_ms]);
  };

  // ---- the shape is content-free by construction ----------------------------------------------------------------
  const cols = (await db.query("select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'chat_audit' order by 1")).rows;
  const textual = cols.filter((c) => c.data_type === "text" || c.data_type === "ARRAY" || c.data_type === "jsonb" || c.data_type === "character varying").map((c) => c.column_name).sort();
  check("the only text-like columns are intent, outcome and source_ids (no free text, no jsonb)", JSON.stringify(textual) === JSON.stringify(["intent", "outcome", "source_ids"]), textual.join(","));
  check("organization_id exists, reserved and nullable", cols.some((c) => c.column_name === "organization_id"));

  // ---- insert ---------------------------------------------------------------------------------------------------
  check("a member records a row as themself", (await ins(IDS.m1, IDS.m1)).ok);
  check("a member records an error row with no intent", (await ins(IDS.m1, IDS.m1, { intent: null, outcome: "error", source_ids: [], record_count: 0, has_evidence: false })).ok);
  check("an administrator records a row as themself", (await ins(IDS.admin, IDS.admin)).ok);
  check("a member cannot record a row as someone else", denied(await ins(IDS.m1, IDS.m2)));
  const ret = await attempt("authenticated", IDS.m1, "insert into public.chat_audit (actor_id, outcome) values ($1, 'answered') returning id", [IDS.m1]);
  check("a member cannot read a row back with RETURNING (so the app must not ask for it)", denied(ret), ret.msg);

  check("anon cannot record a row", denied(await attempt("anon", null, "insert into public.chat_audit (actor_id, outcome) values (null, 'answered')")));
  check("a row with no actor is refused (row level security)", denied(await attempt("authenticated", IDS.m1, "insert into public.chat_audit (actor_id, outcome) values (null, 'answered')")));
  for (const col of ["created_at", "organization_id", "id"]) {
    const r = await attempt("authenticated", IDS.m1, `insert into public.chat_audit (actor_id, outcome, ${col}) values ($1, 'answered', ${col === "created_at" ? "now() - interval '3 days'" : col === "id" ? "gen_random_uuid()" : "gen_random_uuid()"})`, [IDS.m1]);
    check(`a client cannot set ${col} (column privilege)`, denied(r), r.msg);
  }
  const bad = [
    ["an unknown intent", { intent: "tell_me_secrets" }],
    ["free text in intent", { intent: "what is Alice's salary?" }],
    ["an unknown outcome", { outcome: "great" }],
    ["free text in source_ids", { source_ids: ["tasks", "my private note"] }],
    ["more than 12 source ids", { source_ids: Array(13).fill("tasks") }],
    ["a negative record count", { record_count: -1 }],
    ["a negative latency", { latency_ms: -5 }],
    ["an absurd latency", { latency_ms: 600001 }],
  ];
  for (const [name, over] of bad) {
    const r = await ins(IDS.m1, IDS.m1, over);
    check(`the database refuses ${name}`, !r.ok && r.code === "23514", r.msg);
  }

  // ---- read -----------------------------------------------------------------------------------------------------
  const stored = (await db.query("select count(*)::int n from public.chat_audit")).rows[0].n;
  check("rows really are stored (so the empty member reads below are the policy, not an empty table)", stored >= 3, `stored=${stored}`);
  const m1 = await attempt("authenticated", IDS.m1, "select actor_id from public.chat_audit");
  check("a member reads NO rows, not even their own (admin-only read policy)", m1.ok && m1.rows.length === 0, m1.msg);
  const m1c = await attempt("authenticated", IDS.m1, "select count(*)::int n from public.chat_audit where actor_id = $1", [IDS.m1]);
  check("a member cannot count or filter their own rows either", m1c.ok && m1c.rows[0].n === 0, m1c.msg);
  const m2 = await attempt("authenticated", IDS.m2, "select id from public.chat_audit");
  check("another member also sees none", m2.ok && m2.rows.length === 0, m2.msg);
  const a = await attempt("authenticated", IDS.admin, "select actor_id from public.chat_audit");
  check("an administrator reads every row", a.ok && a.rows.length === stored, `${a.msg} read=${a.rows?.length} stored=${stored}`);
  check("anon cannot read the table", denied(await attempt("anon", null, "select id from public.chat_audit")));
  check("service_role holds no privilege on the table", denied(await attempt("service_role", null, "select id from public.chat_audit")));

  // ---- immutable ------------------------------------------------------------------------------------------------
  check("a member cannot update a row", denied(await attempt("authenticated", IDS.m1, "update public.chat_audit set outcome = 'answered'")));
  check("an administrator cannot update a row", denied(await attempt("authenticated", IDS.admin, "update public.chat_audit set outcome = 'answered'")));
  check("a member cannot delete a row", denied(await attempt("authenticated", IDS.m1, "delete from public.chat_audit")));
  check("an administrator cannot delete a row", denied(await attempt("authenticated", IDS.admin, "delete from public.chat_audit")));
  check("nobody can truncate it through the API", denied(await attempt("authenticated", IDS.admin, "truncate public.chat_audit")));
  check("the burst-cap function is SECURITY DEFINER (it must count rows the member cannot read)", (await db.query("select prosecdef from pg_proc where proname = 'chat_audit_burst_cap'")).rows[0].prosecdef === true);
  check("the burst-cap function is not callable by API roles", denied(await attempt("authenticated", IDS.m1, "select public.chat_audit_burst_cap()")));

  // ---- burst cap ------------------------------------------------------------------------------------------------
  await db.exec("select set_config('request.jwt.claim.sub', '', false)");
  const flood = await attempt("authenticated", IDS.m2, "insert into public.chat_audit (actor_id, outcome) select $1, 'answered' from generate_series(1, 120)", [IDS.m2]);
  check("120 rows in a minute are accepted", flood.ok, flood.msg);
  const over = await ins(IDS.m2, IDS.m2);
  check("the 121st row in a minute is refused by the burst cap", !over.ok && over.code === "54000", over.msg);
  check("the cap still fires although members cannot read the table (definer trigger counts the rows)", !over.ok && over.code === "54000", over.msg);
  check("the cap is per user (another member is unaffected)", (await ins(IDS.m1, IDS.m1)).ok);

  // ---- cap edge cases: bulk, multi-statement, forged actor, lock, maintenance, deleted user ---------------------------
  await db.exec("delete from public.chat_audit");
  const bulk = await attempt("authenticated", IDS.m1, "insert into public.chat_audit (actor_id, outcome) select $1, 'answered' from generate_series(1, 200)", [IDS.m1]);
  const afterBulk = (await db.query("select count(*)::int n from public.chat_audit")).rows[0].n;
  check("one bulk request of 200 rows is refused as a whole (nothing stored)", !bulk.ok && bulk.code === "54000" && afterBulk === 0, `${bulk.msg} stored=${afterBulk}`);
  await db.exec("set role authenticated"); await db.query("select set_config('request.jwt.claim.sub', $1, false)", [IDS.m1]);
  let split = "accepted";
  try {
    await db.exec("begin");
    await db.query("insert into public.chat_audit (actor_id, outcome) select $1, 'answered' from generate_series(1, 100)", [IDS.m1]);
    await db.query("insert into public.chat_audit (actor_id, outcome) select $1, 'answered' from generate_series(1, 100)", [IDS.m1]);
    await db.exec("commit");
  } catch { split = "refused"; await db.exec("rollback"); }
  // the lock is held for the rest of the transaction: visible while it is open
  await db.exec("begin");
  await db.query("insert into public.chat_audit (actor_id, outcome) values ($1, 'answered')", [IDS.m1]);
  const locks = (await db.query("select count(*)::int n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()")).rows[0].n;
  await db.exec("rollback");
  await db.exec("reset role"); await db.query("select set_config('request.jwt.claim.sub', '', false)");
  check("two statements in one transaction cannot exceed the cap together (100 + 100)", split === "refused");
  check("a user's insert holds a per-user advisory lock until the transaction ends (serializes concurrent requests)", locks === 1, `locks=${locks}`);
  const forged = await attempt("authenticated", IDS.m2, "insert into public.chat_audit (actor_id, outcome) values ($1, 'answered')", [IDS.m1]);
  check("a forged actor_id is still refused by row level security (and takes no lock: see the function guard)", denied(forged), forged.msg);
  const maint = await attempt("postgres", null, "insert into public.chat_audit (actor_id, outcome) select $1, 'answered' from generate_series(1, 150)", [IDS.m1]);
  check("a trusted maintenance insert (no JWT) is not capped", maint.ok, maint.msg);
  await db.exec("delete from public.chat_audit");
  await attempt("authenticated", IDS.m1, "insert into public.chat_audit (actor_id, outcome) values ($1, 'answered')", [IDS.m1]);
  await db.exec(`delete from auth.users where id = '${IDS.m1}'`);
  const orphan = (await db.query("select count(*)::int n from public.chat_audit where actor_id is null")).rows[0].n;
  check("deleting a user keeps their audit rows, with the actor cleared (no cascade loss)", orphan === 1, `orphans=${orphan}`);

  // Why the cap must be SECURITY DEFINER: as an invoker, it counts only rows the member can read, which is none (admin-only reads).
  const defn = (await db.query("select pg_get_functiondef('public.chat_audit_burst_cap()'::regprocedure) d")).rows[0].d;
  await db.exec("delete from public.chat_audit");
  await db.exec(defn.replace(/\s+SECURITY DEFINER/, ""));
  check("(mutation) the mutated function really is SECURITY INVOKER", (await db.query("select prosecdef from pg_proc where proname = 'chat_audit_burst_cap'")).rows[0].prosecdef === false);
  const flood2 = await attempt("authenticated", IDS.m2, "insert into public.chat_audit (actor_id, outcome) select $1, 'answered' from generate_series(1, 120)", [IDS.m2]);
  const extra = await attempt("authenticated", IDS.m2, "insert into public.chat_audit (actor_id, outcome) values ($1, 'answered')", [IDS.m2]);
  check("(mutation) an INVOKER cap is silently bypassed once members cannot read the table (this is why it is DEFINER)", flood2.ok && extra.ok, `${flood2.msg} ${extra.msg}`);
  await db.exec(defn);
  await db.exec("delete from public.chat_audit");
  check("(restored) the function is SECURITY DEFINER again", (await db.query("select prosecdef from pg_proc where proname = 'chat_audit_burst_cap'")).rows[0].prosecdef === true);

  // ---- the read-only catalog audit that is run in the SQL Editor must pass here, and must catch a regression ----------
  const audit = readFileSync(fileURLToPath(new URL("./0008_catalog_audit.proposed.sql", import.meta.url)), "utf8");
  const run = async () => { try { await db.exec(audit); return ""; } catch (e) { return String(e.message ?? e); } };
  check("the SQL Editor catalog audit passes on a correct install", (await run()) === "", await run());
  await db.exec("grant update (outcome) on public.chat_audit to authenticated");
  check("the catalog audit fails when authenticated can update a column", /update/i.test(await run()));
  await db.exec("revoke update (outcome) on public.chat_audit from authenticated");
  await db.exec("grant select on public.chat_audit to anon");
  check("the catalog audit fails when anon can read", /anon/.test(await run()));
  await db.exec("revoke select on public.chat_audit from anon");
  const original = (await db.query("select pg_get_functiondef('public.chat_audit_burst_cap()'::regprocedure) d")).rows[0].d;
  await db.exec(original.replace("perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('chat_audit:' || new.actor_id::text, 0));", ""));
  check("the catalog audit fails when the per-user lock is removed from the cap", /advisory lock/.test(await run()));
  await db.exec(original);
  check("the catalog audit passes again once restored", (await run()) === "", await run());
}

const ok = env.print("0008 chat audit (local PostgreSQL)");
process.exit(ok ? 0 : 1);
