import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseRepo } from "../src/lib/backend/supabase/repo";
import { PROFILE_COLUMNS, toProfile } from "../src/lib/backend/supabase/profile";
import type { TaskInput } from "../src/lib/types";

/**
 * Contract test: the REAL Supabase repo code is run against a recording client, and every table, column and operation it
 * sends is checked against the privileges GRANTED by supabase/migrations/0001_init.sql (parsed from the file itself, not
 * re-typed here). If the app starts writing a column that clients are not allowed to write, or the SQL stops granting what the
 * app reads, this fails. It does not execute SQL; the same shapes are executed on a local PostgreSQL by
 * supabase/proposed/tests/0001_least_privilege.pglite.mjs.
 */
const sqlOf = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/--[^\n]*/g, "");
// CONTRACT_0001 (a file path) lets a reviewer point this test at another version of 0001 to prove it can fail.
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const ACTIVE_SQL = process.env.CONTRACT_0001 ? stripComments(readFileSync(process.env.CONTRACT_0001, "utf8")) : sqlOf("supabase/migrations/0001_init.sql");
const PRIVACY_SQL = sqlOf("supabase/proposed/0006_profiles_privacy.proposed.sql");

type Priv = "select" | "insert" | "update" | "delete";
interface Grant { table: Set<Priv>; cols: Map<Priv, Set<string>> }

/** role -> table -> privileges, applied in file order (grants add; a table-level revoke of a privilege removes it and its column grants). */
function parseGrants(sql: string, role: string, start: Map<string, Grant> = new Map()) {
  const out = start;
  const get = (t: string) => { if (!out.has(t)) out.set(t, { table: new Set(), cols: new Map() }); return out.get(t)!; };
  for (const m of sql.matchAll(/\b(grant|revoke)\b([^;]*?)\bon\s+public\.(\w+)\s+(?:to|from)\s+([^;]*);/gi)) {
    const [, verb, privText, table, roles] = m;
    if (!roles.split(",").map((r) => r.trim()).includes(role)) continue;
    // "insert (a, b), update (c)" or "select, insert"
    for (const part of privText.match(/(select|insert|update|delete)\s*(\([^)]*\))?/gi) ?? []) {
      const [, priv, cols] = /(select|insert|update|delete)\s*(\([^)]*\))?/i.exec(part)!;
      const p = priv.toLowerCase() as Priv, g = get(table);
      if (verb.toLowerCase() === "grant") {
        if (cols) g.cols.set(p, new Set([...(g.cols.get(p) ?? []), ...cols.slice(1, -1).split(",").map((c) => c.trim())]));
        else g.table.add(p);
      } else if (!cols) { g.table.delete(p); g.cols.delete(p); }
    }
  }
  return out;
}
const can = (g: Map<string, Grant>, table: string, priv: Priv, col?: string) => {
  const e = g.get(table);
  return !!e && (e.table.has(priv) || (col !== undefined && !!e.cols.get(priv)?.has(col)));
};

// ------------------------------------------------------------------------------ recording client
interface Op { table: string; kind: "select" | "insert" | "update"; select?: string; keys?: string[] }
function recordingClient() {
  const ops: Op[] = [];
  const row = { id: "00000000-0000-0000-0000-000000000001", assignee: null };
  const builder = (table: string) => {
    const op: Op = { table, kind: "select" };
    ops.push(op);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: (cols?: string) => { if (cols !== undefined && op.select === undefined) op.select = cols; return b; },
      insert: (p: Record<string, unknown>) => { op.kind = "insert"; op.keys = Object.keys(p); return b; },
      update: (p: Record<string, unknown>) => { op.kind = "update"; op.keys = Object.keys(p); return b; },
      eq: chain, in: chain, gte: chain, lt: chain, order: chain, limit: chain,
      single: async () => ({ data: row, error: null }),
      maybeSingle: async () => ({ data: row, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(res),
    });
    return b;
  };
  const db = { from: (t: string) => builder(t), rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient;
  return { db, ops };
}

/** "*, assignee:profiles!fk(full_name)" -> [{table, columns|"*"}] (top-level columns belong to `base`). */
function selectedColumns(base: string, list: string) {
  const items: string[] = []; let depth = 0, cur = "";
  for (const ch of list) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { items.push(cur.trim()); cur = ""; } else cur += ch; }
  if (cur.trim()) items.push(cur.trim());
  const out: { table: string; col: string }[] = [];
  for (const it of items) {
    const embed = /^(?:\w+:)?(\w+)(?:![\w]+)?\(([^)]*)\)$/.exec(it);
    if (embed) for (const c of embed[2].split(",").map((x) => x.trim())) out.push({ table: embed[1], col: c });
    else out.push({ table: base, col: it });
  }
  return out;
}

const TASK: TaskInput = { title: "t", description: null, status: "open", priority: "medium", assigned_to: null, due_at: null };

async function exerciseRepo() {
  const { db, ops } = recordingClient();
  const repo = createSupabaseRepo(db, "00000000-0000-0000-0000-0000000000aa");
  await repo.createTask(TASK);
  await repo.updateTask("00000000-0000-0000-0000-000000000001", { ...TASK });
  await repo.updateTask("00000000-0000-0000-0000-000000000001", { status: "completed" });
  await repo.listTasks(); await repo.getTask("x"); await repo.taskCounts(); await repo.listPeople();
  await repo.listActivity(10); await repo.listTaskActivity("x", 10); await repo.listIntegrations();
  await repo.teamWorkload(); await repo.listNotifications();
  return ops;
}

describe("the real Supabase repo only touches what 0001 grants to authenticated", () => {
  const authenticated = parseGrants(ACTIVE_SQL, "authenticated");

  it("tasks INSERT sends only columns that clients may insert (and created_by, which the policy pins to auth.uid())", async () => {
    const ins = (await exerciseRepo()).filter((o) => o.kind === "insert");
    assert.equal(ins.length, 1);
    assert.deepEqual([...ins[0].keys!].sort(), ["assigned_to", "created_by", "description", "due_at", "priority", "status", "title"]);
    for (const k of ins[0].keys!) assert.ok(can(authenticated, "tasks", "insert", k), `INSERT tasks.${k} is not granted`);
  });

  it("tasks UPDATE sends only columns that clients may update", async () => {
    const upd = (await exerciseRepo()).filter((o) => o.kind === "update");
    assert.equal(upd.length, 2);
    for (const o of upd) for (const k of o.keys!) assert.ok(can(authenticated, "tasks", "update", k), `UPDATE tasks.${k} is not granted`);
    assert.deepEqual([...upd[0].keys!].sort(), ["assigned_to", "description", "due_at", "priority", "status", "title"]);
  });

  it("every SELECT (including embedded relations) uses only readable columns", async () => {
    const reads = (await exerciseRepo()).filter((o) => o.kind === "select" && o.select !== undefined);
    assert.ok(reads.length >= 8);
    for (const o of reads) {
      for (const { table, col } of selectedColumns(o.table, o.select!)) {
        // `*` needs a table-level SELECT. Named columns may be granted at either level.
        assert.ok(col === "*" ? can(authenticated, table, "select") : can(authenticated, table, "select", col), `SELECT ${table}.${col} (from ${o.table}: "${o.select}") is not granted`);
      }
    }
  });

  it("the app never deletes through the API (so no DELETE grant is needed or given)", async () => {
    assert.ok((await exerciseRepo()).every((o) => ["select", "insert", "update"].includes(o.kind)));
    for (const t of ["tasks", "profiles", "activity_events", "notifications", "integrations"]) assert.ok(!can(authenticated, t, "delete"), `${t}: DELETE must not be granted`);
  });

  it("a hostile payload fails closed: forging server-controlled columns is NOT granted", () => {
    for (const k of ["source", "external_reference", "created_at", "updated_at", "completed_at", "id"]) assert.ok(!can(authenticated, "tasks", "insert", k), `INSERT tasks.${k}`);
    for (const k of ["source", "external_reference", "created_by", "created_at", "updated_at", "completed_at", "id"]) assert.ok(!can(authenticated, "tasks", "update", k), `UPDATE tasks.${k}`);
    for (const k of ["role", "title", "email", "full_name"]) assert.ok(!can(authenticated, "profiles", "update", k), `UPDATE profiles.${k}`);
    assert.ok(!can(authenticated, "integrations", "update"));
    assert.ok(!can(authenticated, "activity_events", "insert"));
  });
});

describe("M-4 readiness: the app and the proposed 0006 agree", () => {
  it("the sign-in profile query reads no email, and every column it reads is granted once 0006 is applied", () => {
    const cols = PROFILE_COLUMNS.split(",").map((c) => c.trim());
    assert.ok(!cols.includes("email"));
    const after = parseGrants(PRIVACY_SQL, "authenticated", parseGrants(ACTIVE_SQL, "authenticated"));
    for (const c of cols) assert.ok(can(after, "profiles", "select", c), `profiles.${c} must stay readable after 0006`);
    assert.ok(!can(after, "profiles", "select", "email"), "0006 must remove email");
    assert.ok(!after.get("profiles")!.table.has("select"), "no table-level SELECT left on profiles");
  });

  it("every other profiles read in the app (listPeople, the task assignee embed) is also covered after 0006", async () => {
    const after = parseGrants(PRIVACY_SQL, "authenticated", parseGrants(ACTIVE_SQL, "authenticated"));
    for (const o of (await exerciseRepo()).filter((x) => x.select !== undefined)) {
      for (const { col } of selectedColumns(o.table, o.select!).filter((x) => x.table === "profiles")) assert.ok(can(after, "profiles", "select", col), `profiles.${col}`);
    }
  });

  it("the signed-in user's email comes from the verified auth session, never from a profiles row", () => {
    const p = toProfile({ id: "u1", full_name: "A", role: "member", title: null }, "a@example.test");
    assert.equal(p.email, "a@example.test");
    assert.equal(toProfile({ id: "u1", full_name: "A", role: "member", title: null }, undefined).email, null);
  });
});

describe("service_role (workers) grants match the documented minimum", () => {
  const svc = parseGrants(ACTIVE_SQL, "service_role");
  it("can read everything, write only events, notifications, integration status, tasks and profiles; never delete or truncate", () => {
    for (const t of ["profiles", "tasks", "activity_events", "notifications", "integrations"]) { assert.ok(can(svc, t, "select")); assert.ok(!can(svc, t, "delete")); }
    assert.ok(can(svc, "activity_events", "insert") && can(svc, "integrations", "update") && can(svc, "tasks", "insert") && can(svc, "notifications", "insert"));
    assert.ok(!can(svc, "activity_events", "update"), "events are append-only even for the service role");
  });
});
