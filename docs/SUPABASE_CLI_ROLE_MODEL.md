# Supabase CLI role model: why `SET ROLE postgres`, and what it means

Status: analysis of the **dev project** `broko-dev` (`olngcbgkxbceqpikcyxk`) from read-only catalog queries, plus local tests on
PostgreSQL. Nothing here was applied to any remote database. Where something is not confirmed it says so.

## Facts read from broko-dev (read-only)

| Fact | Value | Why it matters |
| --- | --- | --- |
| Login role used by `supabase db push --linked` | `cli_login_postgres`, temporary (`valid until` about an hour after creation) | It is created by the CLI through the Management API each run. |
| Its membership of `postgres` | member, **`inherit = false`**, **`set = true`** | It does **not** inherit `postgres`'s privileges. It can only act as `postgres` after `SET ROLE postgres`. |
| Its attributes | not superuser, no `createrole`, no `bypassrls` | Weak on its own. |
| `CREATE` on schema `public` | **no** (`postgres` has it) | As itself it cannot create a single object in `public`. |
| `TRIGGER` on `auth.users` | **no** for the login role, **yes** for `postgres` (table owned by `supabase_auth_admin`) | The profile trigger in `0001` can only be created as `postgres`. |
| `postgres` role | not superuser; `createrole`, **`bypassrls`**, owns the database and `public` | Anything it owns runs with RLS bypass when `SECURITY DEFINER`. |
| Pooler in `supabase/.temp/pooler-url` | port **5432** (Supavisor **session** mode) | Session settings such as `SET ROLE` persist for the connection. Transaction mode (6543) would not guarantee that. |
| Default privileges in `public` | for role `postgres`: tables `arwdDxtm`, sequences `rwU`, functions `X` granted to `anon`, `authenticated`, `service_role` | See `supabase/proposed/0005_default_privileges.proposed.sql`. |

**Not confirmed:** whether the CLI itself issues `SET SESSION ROLE postgres` right after connecting. The binary contains that string,
but I could not attribute it to the `db push` path. Both behaviours are tested locally, and the migrations are correct under either.

## What this means for the migrations

1. A migration **must run as `postgres`**. Without `SET ROLE postgres` it cannot create tables or functions in `public`, cannot create
   the extension, and cannot create the trigger on `auth.users`. (Tested: the pre-hardening `0001` fails with "permission denied" when
   the CLI does not switch roles itself.)
2. Objects created while the session role is `postgres` are **owned by `postgres`**, a permanent role. Objects created by the temporary
   login role would be owned by it, and would also miss the default grants that Supabase attaches to `postgres`-created objects.
3. **A bare `RESET ROLE` at the end of a file is dangerous.** It returns to the *session user* (the login role). The CLI queues its
   migration-history insert after the file in the same batch; as the login role that insert fails, and the whole file rolls back.
   (Reproduced locally: "permission denied" on the history insert after `0001` with the earlier `reset role`.)
4. Therefore every migration (`0001`–`0006`) now:
   - saves the current role: `select set_config('broko.prev_role', current_user, false);`
   - runs `set role postgres;` before any DDL
   - restores the saved role in a final `do $$ ... execute format('set role %I', ...) $$;`

   This is correct whether the CLI had already switched to `postgres` (the role is restored to `postgres`), had not (restored to the
   login role), or the file runs in the dashboard SQL editor (already `postgres`). A failure rolls back the whole file, including the `SET`.

## Security implications of `SET ROLE postgres`

- **No new capability.** The Management API deliberately grants the login role `SET` on `postgres`; `SET ROLE` is the intended path.
  The file gains exactly what the CLI's own mechanism provides, for the duration of the file.
- **A migration file runs with `postgres` authority** (`createrole`, `bypassrls`, owner of `public`). Only reviewed files should be
  promoted; the static tests prove the files contain no `drop`, `truncate`, `delete from`, `create role` or `alter role`.
- **Pooling:** session mode keeps the setting for the connection. If a file were ever run through a transaction-mode pooler, an
  unrestored `SET ROLE` could leak onto another client's connection. The explicit restore (and the implicit rollback on error)
  prevents that.
- **`SECURITY DEFINER` functions are owned by `postgres`, which bypasses RLS.** That is what lets the triggers and the approval
  functions write where no policy allows it, but it also means each one must stay minimal: empty `search_path`, fully qualified names,
  an explicit authorization check (`is_admin()`), and no client-controlled SQL. The tests check the `search_path` pin and the revokes.

## Ownership implications

- All public tables, indexes, sequences and functions end up owned by `postgres` (checked locally for every object in `0001`–`0006`).
- The login role expires without owning anything, so nothing is orphaned and nothing needs `REASSIGN OWNED`.
- Not an ownership fix, and not attempted: no object is dropped or recreated to repair ownership. If something is ever found owned by
  the wrong role, the repair is `ALTER ... OWNER TO postgres` in a reviewed migration.

## Optional hardening (not proposed for now)

A dedicated `NOLOGIN` owner role (for example `broko_owner`) without `bypassrls` or `createrole` would shrink what the `SECURITY DEFINER`
functions can do. It requires `create role` rights (the login role has none) and a plan for the platform's `postgres`-owned objects, so it
is a later decision.

## What is verified, and how

- `supabase/proposed/tests/cli_connection_model.pglite.mjs`: applies `0001`–`0006` as an emulated login role (member of `postgres` with
  SET, not INHERIT, no CREATE on `public`, not superuser), in both CLI behaviours, and checks ownership, role restoration, the history
  insert after each file, and the `auth.users` trigger. **21 of 21 checks pass in each behaviour.**
- The same scripts reproduce the failures of the earlier approach (see item 3).
- **Limits of the emulation:** PGlite is real PostgreSQL but has no PostgREST or GoTrue, its `postgres` is a superuser (a privilege that
  `postgres` itself lacks on the real project would be hidden), and the pooler is not modelled.

## After any approved apply, verify with read-only queries

```sql
select c.relname, c.relowner::regrole from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','S','i');          -- every owner must be postgres
select proname, proowner::regrole, proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and proname <> 'rls_auto_enable';        -- owner postgres, search_path=""
```

then run `supabase/proposed/tests/0001_privileges.proposed.sql` (read-only).
