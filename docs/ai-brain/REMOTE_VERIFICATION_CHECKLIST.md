# Remote Supabase verification checklist (FUTURE; requires explicit approval)

**Status: nothing in this file has been done.** No SQL has been run against any remote database, no migration has been applied, no
Supabase setting has been changed. This is a procedure for a *separate*, explicitly approved step. Every box below is unchecked
and must stay so until the person who owns the project says "go" for that specific step.

Related: `docs/SUPABASE_SECURITY_STATUS.md`, `docs/SUPABASE_CLI_ROLE_MODEL.md`, `docs/ai-brain/INTEGRATION.md`.

## 0. What is and is not proven today

| Claim | Evidence | Real PostgreSQL, two sessions? |
| --- | --- | --- |
| SQL syntax, privileges, RLS, job id contract, audit value checks, upgrade path | PGlite scripts (single in-process connection) and static text pins | No |
| `FOR UPDATE SKIP LOCKED` stops two workers claiming one job | Pinned in SQL text; two real connections on a **local** PostgreSQL 18.4 (2026-10-25, see section 8): passed, and the test fails when the control is removed | Local only; **not Supabase** |
| Approval row lock gives one task per approval | Same local run: one task, loser gets 55000. Without the row lock the loser gets 23505 instead; the partial unique index on `tasks(source, external_reference)` (0002) is what prevents the duplicate | Local only; **not Supabase** |
| Stale lease cannot overwrite a newer claim (fence on owner + attempt) | Single-session test, plus the same local two-connection run: stale complete returned false | Local only; **not Supabase** |
| Behaviour on Supabase's real roles, extensions, default privileges | Modelled in PGlite from read-only catalog queries of `broko-dev` | **No, unverified** |

## 1. Target identity (stop if any item fails)

- [ ] Written approval from the project owner naming the project, the migration files and the order below.
- [ ] Target is **`broko-dev`, project ref `olngcbgkxbceqpikcyxk`**, and nothing else. The other project in the organisation
      (`esjloyhgipkdmdnvoiut`, shown as "brokoai's Project") is **forbidden**.
- [ ] Confirm identity from the dashboard URL and Project Settings, not from a local file: the ref in the URL is `olngcbgkxbceqpikcyxk`.
- [ ] A disposable *branch* or a freshly created scratch project is preferred over `broko-dev` itself; if `broko-dev` is used, it
      holds no data anyone needs (confirm with the owner).
- [ ] Credentials are supplied by the owner for this step only; never pasted into files, chat or logs.

## 2. Files and order

| Order | File | Notes |
| --- | --- | --- |
| 1 | `supabase/migrations/0001_init.sql` | Already the baseline; includes last-admin guard changes. |
| 2 | `supabase/proposed/0002_hardening.proposed.sql` | Apply with 0001 as one reviewed unit. |
| 3 (optional) | `supabase/proposed/0006_profiles_privacy.proposed.sql` | Independent. |
| 4 (optional) | `supabase/proposed/0005_default_privileges.proposed.sql` | Optional hardening; see its header. |
| 5, only with the AI Inbox integration | `supabase/proposed/0003_ai_brain.proposed.sql`, then `0004_ai_jobs.proposed.sql` | **Marked NOT APPROVED FOR APPLICATION.** Do not apply them for any other reason. |

Exact file hashes to record before applying: `sha256sum` of each file above, written into the approval note.

## 3. Preflight (read-only)

Run in the SQL editor of the **target** project only (read-only statements):

```sql
select current_database(), current_user, version();
select rolname, rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname in ('postgres','authenticated','anon','service_role');
select n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) owner
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v') order by 1,2;
select * from supabase_migrations.schema_migrations order by version;   -- what is already applied
select count(*) from public.profiles; select count(*) from public.tasks;  -- know what data exists
```

- [ ] Output matches expectations recorded in `docs/SUPABASE_CLI_ROLE_MODEL.md`; any difference stops the procedure.
- [ ] Take note of the CLI login role the migration tool uses (`cli_login_postgres` pattern; set role to `postgres`, restore).

## 4. Backup and rollback

- [ ] Backup exists and was restored once somewhere disposable (a dashboard backup or `pg_dump` taken by the owner), or the target is
      confirmed empty/disposable.
- [ ] Rollback is written down per file before applying: dropping the objects the file creates (functions, triggers, tables) and
      restoring changed grants from the catalog snapshot in section 3. Migrations 0003/0004 add objects only; 0001/0002 change
      guards and grants, so the section 5 snapshot is the rollback reference.
- [ ] Apply each file in its own step, running section 5 after each.

## 5. Catalog queries to run after applying (read-only; save the output)

```sql
-- table privileges for the API roles (expect no TRUNCATE/TRIGGER/REFERENCES, and no write access beyond the design)
select grantee, table_schema, table_name, string_agg(privilege_type, ',' order by privilege_type)
  from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
  group by 1,2,3 order by 3,1;

-- RLS on every public table, forced where designed
select relname, relrowsecurity, relforcerowsecurity from pg_class
  where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1;
select schemaname, tablename, policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' order by 2,3;

-- function owner, security type, pinned search_path, and who may EXECUTE
select p.oid::regprocedure as fn, pg_get_userbyid(p.proowner) as owner,
       case p.prosecdef when true then 'SECURITY DEFINER' else 'SECURITY INVOKER' end as sec,
       p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon_x,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
       has_function_privilege('service_role', p.oid, 'execute') as svc_x
  from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1;

-- default privileges that would expose future objects
select * from pg_default_acl;
-- extensions (none expected from these migrations)
select extname, extnamespace::regnamespace from pg_extension;
```

Expected: every `SECURITY DEFINER` function has `proconfig` containing `search_path=""` and an owner of `postgres`;
`ai_*` functions are executable only by the roles listed in the RPC table of `INTEGRATION.md` (`anon` never); no API role holds
TRUNCATE on any table; `ai_jobs` is not readable by `anon`/`authenticated`.

- [ ] Output reviewed by a person against these expectations; deviations recorded, not "fixed on the fly".

## 6. Post-apply SQL regression tests

Read the header of each script first. `0001_privileges` is read-only (SELECTs inside DO blocks). `0004_rls_and_jobs` **creates users and
rows inside one transaction that it rolls back**, so run it only on an isolated database, never a shared one:

- [ ] `supabase/proposed/tests/0001_privileges.proposed.sql` (after 0001 + 0002)
- [ ] `supabase/proposed/tests/0004_rls_and_jobs.proposed.sql` (only if 0003/0004 were applied)

A failing statement raises an exception naming the check. Do not continue to the next file after a failure.

## 7. Two-session concurrency procedure (the part never verified)

Needs two independent connections to the same disposable database (two `psql` windows, or two SQL editor tabs *with separate
connections*; the Supabase SQL editor may share a pool, so use `psql` against the direct connection string supplied by the owner).
Use synthetic rows only, in a database that holds nothing real.

**A. Two workers, one job (`ai_claim_job` + SKIP LOCKED)**

1. Session 1 (service role context): `select public.ai_enqueue_job('synthetic','box','two-session-1');` note the returned 12-hex id.
2. Session 1: `begin; select * from public.ai_claim_job('worker-1', 60);` and **leave the transaction open**.
3. Session 2: `select * from public.ai_claim_job('worker-2', 60);`
4. Expected: session 2 returns **zero rows immediately** (it did not wait and did not take the same job). With a second job
   enqueued first, it should instead return that other job.
5. Session 1: `commit;` Then in either session: `select status, lease_owner, attempts from public.ai_jobs where correlation_id = '<id>';`
   Expected `processing`, `worker-1`, `1`.
6. Failure signal: session 2 returns the same row, or blocks until session 1 commits.

**B. Two approvals, one task (`ai_approve_message` row lock)**

1. Prepare one `NEEDS_REVIEW` message and note its `review_id`.
2. Session 1 as an administrator: `begin; select public.ai_approve_message('<review_id>', 'Task', null, null, null, null);` leave open.
3. Session 2 as an administrator: run the same call. Expected: it **waits** on the row lock.
4. Session 1: `commit;` Session 2 then fails with SQLSTATE 55000 ("message is not awaiting review"), not a second task.
5. Check: `select count(*) from public.tasks where source = 'email' and external_reference = '<expected reference>';` Expected `1`.
6. Failure signal: two tasks, or session 2 does not wait.

**C. Stale lease cannot overwrite a newer claim**

1. Enqueue a job; session 1 claims it with the smallest allowed lease (`ai_claim_job('worker-1', 10)`; below 10 s is refused),
   or set `lease_expires_at` into the past on the **disposable** row only.
2. After expiry, session 2 claims it (`attempts` becomes 2).
3. Session 1 reports with its old attempt: `ai_complete_job('<id>', 'worker-1', 1, null, 'NO_ACTION', false)`. Expected `false`.
4. Session 2 reports with attempt 2. Expected `true`.

- [ ] A passed   - [ ] B passed   - [ ] C passed   (record output, date, and which database)

## 8. Local PostgreSQL run (done once, 2026-10-25; Supabase itself still not done)

A disposable local PostgreSQL 18.4 (portable binaries from the `embedded-postgres` npm package, in a temporary directory, bound to
127.0.0.1, deleted afterwards) ran scenarios A, B and C below with real concurrent connections, plus 8-way races and negative controls
(SQL with SKIP LOCKED or the approval row lock removed). All passed with the SQL as written. The harness was a throwaway script and is
not in this repository. Limits: the roles and `auth.uid()` are local imitations of Supabase's, PostgreSQL 18 is newer than what
Supabase runs, and nothing about PostgREST, GoTrue or real default privileges is established. No `psql`, Docker or WSL exists on this machine.

To repeat it by hand, or on a different local server (PostgreSQL 15+ with `psql`, or Docker Desktop with `supabase start`): create a scratch database, create the roles `anon`, `authenticated`, `service_role`
(`nologin`), apply 0001, 0002, 0003, 0004 in order as a superuser, and follow section 7 with two `psql` windows.
PGlite cannot substitute: it is one in-process connection, so the scripts list the lock/skip-locked controls as BLIND.

## 9. Sign-off

Only the project owner closes this out. If any step fails, stop, record the failure, and do not retry against a different project.
