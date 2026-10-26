import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Static guards for the SQL migrations. They read the files as text, so they prove the policy is written down and cannot
 * regress silently; they do NOT execute SQL. Real execution is done by supabase/proposed/tests/0001_least_privilege.pglite.mjs
 * (local PostgreSQL) and, after an approved apply, 0001_privileges.proposed.sql (read-only, on the dev project).
 */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/--[^\n]*/g, "");
const ACTIVE = { "0001_init.sql": read("supabase/migrations/0001_init.sql") };
const PROPOSED = {
  "0002_hardening": read("supabase/proposed/0002_hardening.proposed.sql"),
  "0003_ai_brain": read("supabase/proposed/0003_ai_brain.proposed.sql"),
  "0004_ai_jobs": read("supabase/proposed/0004_ai_jobs.proposed.sql"),
  "0005_default_privileges": read("supabase/proposed/0005_default_privileges.proposed.sql"),
  "0006_profiles_privacy": read("supabase/proposed/0006_profiles_privacy.proposed.sql"),
  "0007_preconstruction": read("supabase/proposed/0007_preconstruction.proposed.sql"),
};
const ALL = { ...ACTIVE, ...PROPOSED };
const entries = Object.entries(ALL);

const grants = (sql: string) => [...sql.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => m[0]);
const revokes = (sql: string) => [...sql.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => m[0]);

describe("SQL migrations: least privilege (static guards)", () => {
  it("no grant goes to anon or public, and none is broad (ALL, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN)", () => {
    for (const [name, sql] of entries) {
      for (const g of grants(sql)) {
        assert.ok(!/\bto\b[^;]*\b(anon|public)\b/i.test(g), `${name}: grants to anon/public: ${g.slice(0, 80)}`);
        assert.ok(!/\bgrant\s+(all|truncate|references|trigger|maintain)\b/i.test(g) && !/\b(truncate|references|trigger|maintain)\b/i.test(g.split(/\bon\b/i)[0]), `${name}: broad grant: ${g.slice(0, 80)}`);
      }
    }
  });

  it("service_role is never granted DELETE or TRUNCATE on any table, the AI tables included (workers read, insert and update)", () => {
    for (const [name, sql] of entries) {
      for (const g of grants(sql).filter((x) => /\bto\s+service_role\b/i.test(x) && /\bon\s+public\./i.test(x))) {
        assert.ok(!/\b(delete|truncate)\b/i.test(g.split(/\bon\b/i)[0]), `${name}: ${g.slice(0, 80)}`);
      }
    }
  });

  it("every table has RLS enabled by an explicit statement (the platform's event trigger swallows its own failures), and none is FORCEd", () => {
    for (const [name, sql] of entries) {
      for (const [, table] of sql.matchAll(/create table public\.(\w+)/gi)) {
        assert.match(sql, new RegExp(`alter table public\\.${table}\\s+enable row level security`, "i"), `${name}: RLS not enabled on ${table}`);
      }
      assert.ok(!/force row level security/i.test(sql), `${name}: FORCE RLS would break SECURITY DEFINER writers`);
    }
  });

  it("every SECURITY DEFINER function pins search_path to an empty string", () => {
    for (const [name, sql] of entries) {
      for (const m of sql.matchAll(/create (?:or replace )?function\s+public\.(\w+)[\s\S]*?\$\$/gi)) {
        if (/security definer/i.test(m[0])) assert.match(m[0], /set search_path = ''/i, `${name}: ${m[1]} does not pin an empty search_path`);
      }
    }
  });

  it("every function created has EXECUTE revoked from PUBLIC (functions are executable by everyone by default)", () => {
    for (const [name, sql] of entries) {
      const revoked = new Set<string>();
      for (const r of revokes(sql).filter((x) => /on function/i.test(x) && /\bfrom\b[^;]*\bpublic\b/i.test(x))) {
        for (const [, fn] of r.matchAll(/public\.(\w+)\s*\(/g)) revoked.add(fn);
      }
      for (const [, fn] of sql.matchAll(/create function\s+public\.(\w+)/gi)) assert.ok(revoked.has(fn), `${name}: EXECUTE on ${fn}() is not revoked from public`);
    }
  });

  it("migrations never drop, truncate or delete", () => {
    for (const [name, sql] of entries) assert.ok(!/^\s*(drop|truncate|delete from)\b/im.test(sql), `${name} contains a destructive statement`);
  });
});

describe("role handling in every migration file (CLI login role: SET but NOT INHERIT, no CREATE on public)", () => {
  for (const [name, sql] of entries) {
    it(`${name}: saves the current role, switches to postgres BEFORE any DDL, and restores the saved role (never a bare RESET ROLE)`, () => {
      const save = sql.search(/select set_config\('broko\.prev_role', current_user, false\)\s*;/i);
      const setRole = sql.search(/\bset role postgres\s*;/i);
      const firstDdl = sql.search(/\b(create|alter|grant|revoke)\b/i);
      assert.ok(save >= 0 && setRole > save, "must save the current role, then SET ROLE postgres");
      assert.ok(setRole < firstDdl, "SET ROLE postgres must come before the first DDL statement");
      assert.match(sql, /execute format\('set role %I', current_setting\('broko\.prev_role'\)\)/i, "must restore the saved role");
      assert.ok(!/^\s*reset role\s*;/im.test(sql), "a bare RESET ROLE would return to the login role and break the CLI's history insert");
      assert.ok(sql.lastIndexOf("prev_role") > setRole, "the restore comes after the DDL");
    });
  }
});

describe("0001_init.sql: ownership and the privilege model", () => {
  const sql = ACTIVE["0001_init.sql"];
  const TABLES = ["profiles", "tasks", "activity_events", "notifications", "integrations"];

  it("revokes everything from every API role on every table before granting back", () => {
    const all = revokes(sql).find((r) => /revoke all on public\.profiles/i.test(r));
    assert.ok(all, "no blanket revoke");
    for (const t of TABLES) assert.match(all, new RegExp(`public\\.${t}\\b`), `blanket revoke misses ${t}`);
    for (const role of ["public", "anon", "authenticated", "service_role"]) assert.match(all, new RegExp(`\\b${role}\\b`), `blanket revoke misses ${role}`);
    assert.ok(sql.indexOf(all) > sql.search(/enable row level security/i), "the revoke must follow table creation");
  });

  it("gives authenticated column-level INSERT/UPDATE on tasks that exclude server-controlled columns, and no DELETE", () => {
    const ins = sql.match(/grant insert \(([^)]*)\) on public\.tasks to authenticated/i);
    const upd = sql.match(/grant update \(([^)]*)\) on public\.tasks to authenticated/i);
    assert.ok(ins && upd, "tasks must use column-level grants for authenticated");
    for (const col of ["source", "external_reference", "created_at", "updated_at", "completed_at"]) {
      assert.ok(!ins[1].includes(col) && !upd![1].includes(col), `authenticated can write tasks.${col}`);
    }
    assert.ok(!upd![1].includes("created_by"), "created_by must not be updatable");
    assert.ok(ins[1].includes("created_by"), "the dashboard sends created_by on insert");
    assert.ok(!/grant[^;]*\bdelete\b[^;]*on public\.tasks[^;]*authenticated/i.test(sql), "no client DELETE on tasks");
    assert.ok(!/grant\s+(insert|update)\s+on public\.tasks\s+to\s+authenticated/i.test(sql), "no table-level write grant on tasks");
  });

  it("makes profiles, activity events and integrations read-only for clients (writes are server-side)", () => {
    for (const t of ["profiles", "activity_events", "integrations"]) {
      const g = grants(sql).filter((x) => new RegExp(`on public\\.${t}\\s+to\\s+authenticated`, "i").test(x));
      assert.equal(g.length, 1, `${t}: expected exactly one grant to authenticated`);
      assert.match(g[0], /grant select on/i);
    }
  });

  it("limits notifications to reading plus marking read", () => {
    assert.match(sql, /grant update \(read_at\) on public\.notifications to authenticated/i);
    assert.ok(!/grant update on public\.notifications to authenticated/i.test(sql));
  });

  it("lets only signed-in users call is_admin() and team_workload(); trigger functions are not callable by anyone", () => {
    assert.match(sql, /grant execute on function public\.is_admin\(\) to authenticated/i);
    assert.match(sql, /grant execute on function public\.team_workload\(\) to authenticated/i);
    const trig = revokes(sql).find((r) => /handle_new_user/i.test(r))!;
    for (const f of ["handle_new_user", "guard_profile_update", "tasks_log_activity", "tasks_before_write", "touch_updated_at"]) assert.match(trig, new RegExp(f));
    for (const role of ["public", "anon", "authenticated", "service_role"]) assert.match(trig, new RegExp(`\\b${role}\\b`));
  });

  it("allows trusted maintenance to promote the first admin (the guard only restricts real user sessions)", () => {
    assert.match(sql, /if auth\.uid\(\) is not null and not public\.is_admin\(\) and/i);
  });

  it("does NOT change platform default privileges (that is the separate, unpromoted 0005 proposal)", () => {
    for (const [name, text] of entries.filter(([n]) => n !== "0005_default_privileges")) {
      assert.ok(!/alter default privileges/i.test(text), `${name} must not alter default privileges`);
    }
  });
});

describe("proposed 0005 (default privileges) and 0006 (profiles privacy)", () => {
  it("0005 touches only future objects of role postgres in schema public, for exactly the three API roles", () => {
    const stmts = [...PROPOSED["0005_default_privileges"].matchAll(/alter default privileges[^;]*;/gi)].map((m) => m[0]);
    assert.equal(stmts.length, 3);
    for (const s of stmts) {
      assert.match(s, /for role postgres in schema public revoke/i);
      assert.match(s, /from anon, authenticated, service_role/i);
      assert.ok(!/\bgrant\b/i.test(s.replace(/for role postgres in schema public/i, "")), "0005 must only revoke");
    }
    assert.ok(stmts.some((s) => /on tables/i.test(s)) && stmts.some((s) => /on sequences/i.test(s)) && stmts.some((s) => /execute on functions/i.test(s)));
    assert.ok(!/from public\b/i.test(stmts.join(" ")), "0005 must not touch PUBLIC (global effect on extension functions)");
  });

  it("neither is in the active migration directory", () => {
    for (const f of ["0002_hardening", "0003_ai_brain", "0004_ai_jobs", "0005_default_privileges", "0006_profiles_privacy"]) {
      assert.ok(!existsSync(new URL(`../supabase/migrations/${f}.sql`, import.meta.url)), `${f} must stay in supabase/proposed/ until promoted`);
    }
  });

  it("0006 removes email from what signed-in users can read, and keeps what the dashboard needs", () => {
    const sql = PROPOSED["0006_profiles_privacy"];
    const g = sql.match(/grant select \(([^)]*)\) on public\.profiles to authenticated/i);
    assert.ok(g, "column-level SELECT grant expected");
    const cols = g[1].split(",").map((c) => c.trim());
    assert.ok(!cols.includes("email"), "email must not be readable");
    for (const needed of ["id", "full_name", "role", "title"]) assert.ok(cols.includes(needed), `dashboard needs profiles.${needed}`);
    assert.match(sql, /revoke select on public\.profiles from authenticated/i);
  });
});

/** "privileges -> roles" of every GRANT on one table, normalised, so an over-grant of any kind changes the list. */
const tableGrants = (sql: string, table: string) =>
  grants(sql)
    .filter((g) => new RegExp(`\\bon\\s+public\\.${table}\\b`, "i").test(g))
    .map((g) => {
      const m = g.match(/grant\s+([\s\S]*?)\s+on\s+public\.\w+\s+to\s+([\s\S]*?);/i)!;
      return `${m[1].split(",").map((s) => s.trim().toLowerCase()).sort().join(",")} -> ${m[2].split(",").map((s) => s.trim().toLowerCase()).sort().join(",")}`;
    })
    .sort();

describe("AI tables (0003/0004): exact table privileges (static; PGlite and a real database check them by has_table_privilege)", () => {
  // The ONLY grants the application and worker need. Anything else (DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, a wider role) fails here.
  const EXPECTED = {
    ai_messages: ["insert,select,update -> service_role", "select -> authenticated"],
    ai_jobs: ["select -> authenticated", "select -> service_role"],
  } as const;
  for (const [name, table] of [["0003_ai_brain", "ai_messages"], ["0004_ai_jobs", "ai_jobs"]] as const) {
    it(`${table}: revoke ALL from public, anon, authenticated and service_role (not relying on defaults), then exactly the grants the app needs`, () => {
      const sql = PROPOSED[name];
      const r = revokes(sql).find((x) => new RegExp(`revoke all on public\\.${table}\\b`, "i").test(x));
      assert.ok(r, "no blanket revoke");
      for (const role of ["public", "anon", "authenticated", "service_role"]) assert.match(r, new RegExp(`\\b${role}\\b`), `revoke misses ${role}`);
      assert.deepEqual(tableGrants(sql, table), [...EXPECTED[table]]);
      assert.ok(sql.search(new RegExp(`revoke all on public\\.${table}\\b`, "i")) < sql.search(new RegExp(`grant [^;]* on public\\.${table}\\b`, "i")), "revoke must come before the grants");
      assert.match(sql, new RegExp(`create policy ${table}_select on public\\.${table} for select to authenticated\\s+using \\(public\\.is_admin\\(\\)\\)`, "i"));
    });
  }
});

describe("AI functions (0003/0004): exact EXECUTE rights", () => {
  // Worker functions: service_role only. Reviewer functions: signed-in users (each checks is_admin() itself). Nobody else, PUBLIC included.
  const EXPECTED: Record<string, { file: "0003_ai_brain" | "0004_ai_jobs"; to: string }> = {
    ai_record_audit_event: { file: "0003_ai_brain", to: "service_role" },
    ai_approve_message: { file: "0003_ai_brain", to: "authenticated" },
    ai_reject_message: { file: "0003_ai_brain", to: "authenticated" },
    ai_enqueue_job: { file: "0004_ai_jobs", to: "service_role" },
    ai_claim_job: { file: "0004_ai_jobs", to: "service_role" },
    ai_complete_job: { file: "0004_ai_jobs", to: "service_role" },
    ai_retry_job: { file: "0004_ai_jobs", to: "service_role" },
    ai_fail_job: { file: "0004_ai_jobs", to: "service_role" },
    ai_requeue_job: { file: "0004_ai_jobs", to: "authenticated" },
  };
  it("every AI function created is in the table above (a new function must be classified on purpose)", () => {
    for (const file of ["0003_ai_brain", "0004_ai_jobs"] as const) {
      for (const [, f] of PROPOSED[file].matchAll(/create (?:or replace )?function\s+public\.(\w+)/gi)) {
        if (f === "tasks_guard") continue; // an invoker trigger function: not callable as RPC and covered by its own pin below
        assert.ok(EXPECTED[f]?.file === file, `${file}: ${f}() has no declared EXECUTE policy`);
      }
    }
  });
  for (const [f, { file, to }] of Object.entries(EXPECTED)) {
    it(`${f}(): revoked from public, anon, authenticated and service_role, then granted to ${to} only`, () => {
      const sql = PROPOSED[file];
      const rev = revokes(sql).filter((x) => new RegExp(`on function public\\.${f}\\s*\\(`, "i").test(x));
      assert.equal(rev.length, 1, "expected exactly one revoke");
      assert.match(rev[0], /revoke all on function/i);
      for (const role of ["public", "anon", "authenticated", "service_role"]) assert.match(rev[0].split(/\bfrom\b/i)[1], new RegExp(`\\b${role}\\b`), `revoke misses ${role}`);
      const gr = grants(sql).filter((x) => new RegExp(`on function public\\.${f}\\s*\\(`, "i").test(x));
      assert.equal(gr.length, 1, "expected exactly one grant");
      assert.match(gr[0], new RegExp(`grant execute on function[^;]*\\sto ${to};$`, "i"));
    });
  }
});

/**
 * Controls that a mutation experiment (removing each one in a scratch copy) showed were NOT caught by the behavioural scripts, or
 * that no single-session script can exercise. They pin the text of the control; the behaviour is proven by
 * supabase/proposed/tests/mutation_checks.pglite.mjs (and, for SKIP LOCKED, by the two-session procedure in the 0004 test script).
 */
describe("regression pins for controls that behavioural tests cannot or did not catch", () => {
  const fn = (sql: string, name: string) => {
    const m = sql.match(new RegExp(`create (?:or replace )?function\\s+public\\.${name}\\b[\\s\\S]*?end \\$\\$;`, "i"));
    assert.ok(m, `${name} not found`);
    return m[0];
  };

  it("ai_claim_job selects with FOR UPDATE SKIP LOCKED and LIMIT 1 (two workers can never take the same row)", () => {
    const body = fn(PROPOSED["0004_ai_jobs"], "ai_claim_job");
    assert.match(body, /for update skip locked\s+limit 1/i);
  });

  it("every worker report (complete, retry, fail) is fenced on the lease owner AND the attempt counter", () => {
    for (const name of ["ai_complete_job", "ai_retry_job", "ai_fail_job"]) {
      const body = fn(PROPOSED["0004_ai_jobs"], name);
      assert.match(body, /status = 'processing'/i, `${name}: must require status processing`);
      assert.match(body, /lease_owner = p_worker/i, `${name}: must require the lease owner`);
      assert.match(body, /attempts = p_attempt/i, `${name}: must require the attempt counter (a reused worker name is otherwise unfenced)`);
    }
  });

  it("the invoker task guard (0003) trusts only roles other than the browser roles, and the browser roles are forced to source 'manual'", () => {
    const body = fn(PROPOSED["0003_ai_brain"], "tasks_guard");
    assert.match(body, /trusted_writer boolean := current_user not in \('authenticated', 'anon'\)/i);
    assert.match(body, /if not trusted_writer then\s+new\.source := 'manual';\s+new\.external_reference := null;/i);
    assert.ok(!/trusted_writer boolean := true/i.test(body));
  });

  it("0002's guards enforce assignment, server-controlled task columns and integration state themselves", () => {
    const sql = PROPOSED["0002_hardening"];
    const tg = fn(sql, "tasks_guard");
    assert.match(tg, /created_by, source, external_reference and created_at are immutable/i);
    assert.match(tg, /not public\.is_admin\(\)[\s\S]*new\.assigned_to <> auth\.uid\(\)[\s\S]*only administrators can assign tasks to other people/i);
    const ig = fn(sql, "integrations_guard");
    assert.match(ig, /new\.status in \('connected', 'error'\)/i);
    for (const col of ["last_sync_at", "last_error", "connected_by"]) assert.match(ig, new RegExp(`new\\.${col}\\s+is distinct from old\\.${col}`, "i"));
    for (const t of ["tasks_guard", "integrations_guard"]) assert.match(sql, new RegExp(`create trigger ${t} before (?:insert or )?update on public\\.`, "i"));
  });

  it("0002 revokes EXECUTE on its own trigger functions from every API role, service_role included", () => {
    const r = revokes(PROPOSED["0002_hardening"]).find((x) => /tasks_guard/i.test(x) && /integrations_guard/i.test(x));
    assert.ok(r, "no revoke covering the new trigger functions");
    for (const role of ["public", "anon", "authenticated", "service_role"]) assert.match(r, new RegExp(`\\b${role}\\b`), `revoke misses ${role}`);
    for (const f of ["profiles_keep_an_admin", "guard_profile_update", "handle_new_user"]) assert.match(r, new RegExp(f));
  });

  it("0001 keeps at least one administrator: no trusted-path bypass, update-of-role AND delete triggers, definer with pinned search_path", () => {
    const sql = ACTIVE["0001_init.sql"];
    const body = fn(sql, "profiles_keep_an_admin");
    assert.match(body, /security definer set search_path = ''/i);
    assert.match(body, /for update;/i, "must lock the other administrators while checking");
    assert.match(body, /errcode = '23514'/);
    assert.ok(!/auth\.uid\(\) is null/i.test(body), "a trusted-path bypass would let the service role remove the last admin");
    assert.match(sql, /create trigger profiles_keep_an_admin_upd before update of role on public\.profiles\s+for each row execute function public\.profiles_keep_an_admin\(\)/i);
    assert.match(sql, /create trigger profiles_keep_an_admin_del before delete on public\.profiles\s+for each row execute function public\.profiles_keep_an_admin\(\)/i);
  });

  it("ai_claim_job rejects an unbounded lease and a bad worker name before it touches any row", () => {
    const body = fn(PROPOSED["0004_ai_jobs"], "ai_claim_job");
    assert.match(body, /p_lease_seconds is null or p_lease_seconds not between 10 and 3600/i);
    assert.match(body, /p_worker is null or char_length\(p_worker\) not between 1 and 100/i);
    assert.ok(body.search(/not between 10 and 3600/i) < body.search(/update public\.ai_jobs/i), "validate before any update");
    assert.equal((body.match(/errcode = '22023'/g) ?? []).length, 2);
  });

  it("ai_retry_job requires a retry time and clamps it to [now, now + 24 h]", () => {
    const body = fn(PROPOSED["0004_ai_jobs"], "ai_retry_job");
    assert.match(body, /if p_run_at is null then raise exception/i);
    assert.match(body, /v_run := least\(greatest\(p_run_at, now\(\)\), now\(\) \+ interval '24 hours'\)/i);
    assert.match(body, /next_attempt_at = v_run/i);
    assert.ok(!/next_attempt_at = p_run_at/i.test(body), "the raw caller value must never be stored");
    assert.match(body, /attempts < max_attempts/i, "retries stay bounded");
  });

  it("the job key is an unambiguous JSON array of the three reference fields, never a delimiter join", () => {
    const body = fn(PROPOSED["0004_ai_jobs"], "ai_enqueue_job");
    assert.match(body, /v_key text := array_to_json\(array\[p_provider, p_mailbox_ref, p_source_message_id\]\)::text/i);
    assert.ok(!/\|\|\s*'\|'/.test(body), "no '|' concatenation");
    assert.match(PROPOSED["0004_ai_jobs"], /ai_jobs_ref_lengths check \(char_length\(mailbox_ref\) <= 200 and char_length\(source_message_id\) between 1 and 512\)/i);
  });

  it("approve and reject take the opaque review_id, check the administrator first, and report an unknown id with P0002 only after that", () => {
    for (const name of ["ai_approve_message", "ai_reject_message"]) {
      const body = fn(PROPOSED["0003_ai_brain"], name);
      assert.match(body, new RegExp(`function public\\.${name}\\(\\s*p_review_id uuid`, "i"));
      assert.match(body, /where review_id = p_review_id/i);
      assert.ok(!/dedupe_key = p_/i.test(body), `${name}: must not accept the internal dedupe key as a handle`);
      assert.match(body, /errcode = 'P0002'/);
      assert.ok(body.search(/is_admin\(\)/i) >= 0 && body.search(/is_admin\(\)/i) < body.search(/P0002/), `${name}: administrator check must come before the not-found answer`);
    }
    assert.match(PROPOSED["0003_ai_brain"], /review_id uuid not null unique default gen_random_uuid\(\)/i);
  });

  it("the public job id is the unique, 12-hex correlation_id; complete, retry, fail and requeue take it (text) and match on it, never on the row uuid", () => {
    const sql = PROPOSED["0004_ai_jobs"];
    assert.match(sql, /correlation_id text not null unique check \(correlation_id ~ '\^\[0-9a-f\]\{12\}\$'\)/i);
    for (const name of ["ai_complete_job", "ai_retry_job", "ai_fail_job", "ai_requeue_job"]) {
      const body = fn(sql, name);
      assert.match(body, new RegExp(`function public\\.${name}\\(p_job_id text`, "i"), `${name} must take p_job_id text`);
      assert.match(body, /where correlation_id = p_job_id/i, `${name} must match on the public id`);
      assert.ok(!/\bwhere id = /i.test(body), `${name} must not match on the internal uuid`);
    }
    assert.match(fn(sql, "ai_enqueue_job"), /returns text/i);
    assert.match(fn(sql, "ai_enqueue_job"), /returning correlation_id into v_id/i);
  });

  it("ai_record_audit_event types metadata VALUES (enums, a 12-hex workflow id, bounded keys and flags), not just keys, so no free text can be stored", () => {
    const body = fn(PROPOSED["0003_ai_brain"], "ai_record_audit_event");
    assert.match(body, /unexpected metadata key/i);
    assert.match(body, /jsonb_each\(p_metadata\)/i);
    assert.match(body, /invalid metadata value/i);
    assert.match(body, /when 'workflow_id'[^\n]*\^\[0-9a-f\]\{12\}\$/i);
    assert.match(body, /when 'error_category'[^\n]*in \(/i);
    assert.match(body, /jsonb_array_length\(e\.value\) <= 12/i);
  });

  it("approval locks the message row before checking its status (one task per approval under concurrency; provable only with two sessions)", () => {
    assert.match(fn(PROPOSED["0003_ai_brain"], "ai_approve_message"), /from public\.ai_messages where review_id = p_review_id for update;/i);
  });

  it("the 0003 invoker task guard pins an empty search_path", () => {
    assert.match(fn(PROPOSED["0003_ai_brain"], "tasks_guard"), /set search_path = ''/i);
  });

  it("0001 creates no extension (they land in public, where default privileges would expose their functions)", () => {
    assert.ok(!/create extension/i.test(ACTIVE["0001_init.sql"]));
  });
});
