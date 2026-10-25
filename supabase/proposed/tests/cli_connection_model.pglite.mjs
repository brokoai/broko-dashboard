// LOCAL ONLY. Applies the migrations the way the Supabase CLI connects, using facts READ from the dev project (broko-dev):
//   cli_login_postgres is a member of postgres with SET but NOT INHERIT, is not a superuser and has NO CREATE on schema public.
// It checks, for every file, that: it applies; objects end up owned by postgres; the session role afterwards equals the role
// before; and the CLI's own history insert (queued after the file in the same batch) still works.
// Two scenarios, because the CLI's exact behaviour is not confirmed: it does / does not issue SET SESSION ROLE postgres itself.
//   npm install --no-save @electric-sql/pglite
//   node supabase/proposed/tests/cli_connection_model.pglite.mjs [file ...]     (default: 0001..0006 in order)
// Not covered by this emulation: PostgREST/GoTrue, the real `postgres` role being a non-superuser (PGlite's is a superuser, so a
// missing privilege for postgres itself would be hidden), and pooler behaviour. Never connects to any remote database.
import { fileURLToPath } from "node:url";
import { createEnv } from "./lib/pglite_env.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const files = process.argv.length > 2 ? process.argv.slice(2) : [
  `${root}migrations/0001_init.sql`, `${root}proposed/0002_hardening.proposed.sql`, `${root}proposed/0003_ai_brain.proposed.sql`,
  `${root}proposed/0004_ai_jobs.proposed.sql`, `${root}proposed/0005_default_privileges.proposed.sql`, `${root}proposed/0006_profiles_privacy.proposed.sql`,
];
let failures = 0;
for (const cliSetsRole of [false, true]) {
  const env = await createEnv({ applyAs: "cli_login_postgres" });
  const ok = await env.apply(files, { cliSetsRole, history: true });
  if (ok) {
    const rows = (await env.db.query(`select c.relname n, c.relowner::regrole::text o, c.relkind k from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r','S','v','i')`)).rows;
    env.check(`every public table/index/sequence is owned by postgres (${rows.length} objects)`, rows.every((r) => r.o === "postgres"), JSON.stringify(rows.filter((r) => r.o !== "postgres").slice(0, 3)));
    const fns = (await env.db.query(`select p.proname n, p.proowner::regrole::text o from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname <> 'rls_auto_enable'`)).rows;
    env.check(`every public function is owned by postgres (${fns.length} functions)`, fns.every((r) => r.o === "postgres"), JSON.stringify(fns.filter((r) => r.o !== "postgres").slice(0, 3)));
    const trg = (await env.db.query(`select count(*)::int n from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = 'users' and not t.tgisinternal`)).rows[0].n;
    env.check("the profile trigger on auth.users was created (needs TRIGGER on a table owned by supabase_auth_admin)", trg === 1, `${trg}`);
  }
  if (!env.print(`CLI model — ${cliSetsRole ? "CLI pre-sets SET SESSION ROLE postgres" : "CLI does NOT pre-set the role"}`)) failures++;
}
process.exit(failures ? 1 : 0);
