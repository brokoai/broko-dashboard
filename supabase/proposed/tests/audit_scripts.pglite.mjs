// LOCAL ONLY. Regression tests for the two read-only SQL Editor audit scripts (0001_privileges.proposed.sql and
// 0007_catalog_audit.proposed.sql) against the migration order that is actually on broko-dev: 0001, 0002, 0006, 0007.
// Never connects to any remote database.
//   npm install --no-save @electric-sql/pglite
//   node supabase/proposed/tests/audit_scripts.pglite.mjs
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createEnv } from "./lib/pglite_env.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url)); // supabase/
const env = await createEnv();
const { db, check } = env;

await db.exec(`
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null references storage.buckets (id), name text not null);
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant select on storage.buckets to authenticated;
`);

const applied = await env.apply([`${root}migrations/0001_init.sql`, `${root}proposed/0002_hardening.proposed.sql`, `${root}proposed/0006_profiles_privacy.proposed.sql`, `${root}proposed/0007_preconstruction.proposed.sql`]);
if (applied) {
  const priv = readFileSync(`${here}0001_privileges.proposed.sql`, "utf8");
  const bucket = readFileSync(`${here}0007_catalog_audit.proposed.sql`, "utf8");
  const run = async (sql) => { try { await db.exec(sql); return ""; } catch (e) { return String(e.message ?? e); } };

  // ---- 0001 audit on the dev-project state (0006 applied: profiles is column-restricted, 0007 adds policies of its own) ----
  check("0001 audit passes with 0002 + 0006 + 0007 applied (profiles column-restricted, extra policies present)", (await run(priv)) === "", await run(priv));
  await db.exec("grant select (email) on public.profiles to authenticated");
  check("0001 audit fails when 0006's column restriction leaks email", /email/.test(await run(priv)));
  await db.exec("revoke select (email) on public.profiles from authenticated");
  await db.exec("revoke select (role) on public.profiles from authenticated");
  check("0001 audit fails when authenticated can read neither the table nor the profiles columns", /cannot read profiles/.test(await run(priv)));
  await db.exec("grant select (role) on public.profiles to authenticated");
  await db.exec("revoke select on public.tasks from authenticated");
  check("0001 audit still fails when another table loses its read privilege", /cannot read tasks/.test(await run(priv)));
  await db.exec("grant select on public.tasks to authenticated");
  await db.exec("create policy extra_tasks on public.tasks for select to authenticated using (true)");
  check("0001 audit still fails when a policy is added to a 0001 table", /expected 11 policies/.test(await run(priv)));
  await db.exec("drop policy extra_tasks on public.tasks");
  check("0001 audit passes again once restored", (await run(priv)) === "");

  // ---- 0007 audit: the MIME check must apply to the precon-files bucket only ----
  check("0007 audit passes on a correct install", (await run(bucket)) === "", await run(bucket));
  await db.exec("insert into storage.buckets (id, name, allowed_mime_types) values ('other', 'other', array['text/html'])");
  check("0007 audit ignores another bucket that allows text/html (the precedence bug)", (await run(bucket)) === "", await run(bucket));
  await db.exec("delete from storage.buckets where id = 'other'");
  await db.exec("update storage.buckets set allowed_mime_types = allowed_mime_types || array['text/html'] where id = 'precon-files'");
  check("0007 audit fails when precon-files allows text/html", /svg or html/.test(await run(bucket)));
  await db.exec("update storage.buckets set allowed_mime_types = array_remove(allowed_mime_types, 'text/html') || array['image/svg+xml'] where id = 'precon-files'");
  check("0007 audit fails when precon-files allows svg", /svg or html/.test(await run(bucket)));
}

const ok = env.print("audit scripts vs the broko-dev migration order (local PostgreSQL)");
process.exit(ok ? 0 : 1);
