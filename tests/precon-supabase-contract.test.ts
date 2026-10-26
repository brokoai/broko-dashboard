import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseFileStore, createSupabasePreconRepo, PRECON_BUCKET } from "../src/lib/backend/supabase/precon";
import { safeHref } from "../src/lib/chat-state";
import { ADMIN, MEMBER } from "./precon-helpers";

// The Supabase adapter cannot be exercised against a live project here. This contract test records exactly what it asks the
// database for, so the privilege decisions in supabase/proposed/0007 (no unit_number for members, no storage path or hash in
// reads, admin-only unit number function, created_by set from the session) cannot drift without a test failing.

interface Call { table?: string; rpc?: string; args?: unknown; ops: [string, unknown[]][] }

function stub(results: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const builder = (call: Call, key: string) => {
    const b: unknown = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => void) => ok({ data: results[key] ?? [], error: null, count: 0 });
        return (...args: unknown[]) => { call.ops.push([prop, args]); return b; };
      },
    });
    return b;
  };
  const storageCalls: [string, unknown[]][] = [];
  const db = {
    from(table: string) { const c: Call = { table, ops: [] }; calls.push(c); return builder(c, table); },
    rpc(name: string, args: unknown) { const c: Call = { rpc: name, args, ops: [] }; calls.push(c); return builder(c, name); },
    storage: { from(bucket: string) { storageCalls.push(["from", [bucket]]); return { remove: async (p: string[]) => { storageCalls.push(["remove", p]); return { error: null }; } }; } },
  } as unknown as SupabaseClient;
  return { db, calls, storageCalls };
}
const selects = (calls: Call[], table: string) => calls.filter((c) => c.table === table).flatMap((c) => c.ops.filter(([o]) => o === "select").map(([, a]) => String(a[0])));

describe("Supabase Pre-Construction adapter contract", () => {
  it("never selects the storage path or content hash when listing documents", async () => {
    const s = stub();
    await createSupabasePreconRepo(s.db, MEMBER).listDocuments();
    const sel = selects(s.calls, "precon_documents").join(" ");
    assert.ok(sel && !/storage_path|sha256/.test(sel), sel);
  });
  it("never selects unit_number from the table, and asks for unit numbers only as an administrator", async () => {
    const m = stub({ precon_projects: [{ id: "p1", name: "P", city: null, developer: null }] });
    await createSupabasePreconRepo(m.db, MEMBER).listInventory();
    assert.ok(!selects(m.calls, "precon_inventory").join(" ").includes("unit_number"));
    assert.equal(m.calls.filter((c) => c.rpc === "precon_unit_numbers").length, 0, "members never call the admin-only function");
    const a = stub({ precon_projects: [{ id: "p1", name: "P", city: null, developer: null }] });
    await createSupabasePreconRepo(a.db, ADMIN).listInventory();
    assert.ok(!selects(a.calls, "precon_inventory").join(" ").includes("unit_number"));
    assert.equal(a.calls.filter((c) => c.rpc === "precon_unit_numbers").length, 1);
  });
  it("searches through the security-invoker function with the documented argument names", async () => {
    const s = stub();
    await createSupabasePreconRepo(s.db, MEMBER).searchChunks("pool or gym", { projectId: "p1", limit: 5 });
    assert.deepEqual(s.calls.find((c) => c.rpc)?.args, { q: "pool or gym", p_project: "p1", lim: 5 });
    assert.equal(s.calls.find((c) => c.rpc)?.rpc, "precon_search_chunks");
  });
  it("sets created_by from the session on insert, and never sends unit_number on update", async () => {
    const s = stub({ precon_inventory: [{ id: "x" }] });
    const repo = createSupabasePreconRepo(s.db, ADMIN);
    const row = { unit_number: "1204", unit_type: null, bedrooms: 2, den: false, bathrooms: 2, area_sqft: 800, price: 1, currency: "CAD", availability: "available" as const, expected_occupancy: null };
    await repo.insertInventory("p1", [row], { source: "import: a.csv", source_document_id: null });
    const inserted = s.calls.find((c) => c.ops.some(([o]) => o === "insert"))!.ops.find(([o]) => o === "insert")![1][0] as Record<string, unknown>[];
    assert.equal(inserted[0].created_by, ADMIN.id);
    assert.equal(inserted[0].project_id, "p1");
    await repo.updateInventory("u1", row, { source: "import: b.csv", source_document_id: null });
    const upd = s.calls.filter((c) => c.ops.some(([o]) => o === "update")).at(-1)!.ops.find(([o]) => o === "update")![1][0] as Record<string, unknown>;
    assert.ok(!("unit_number" in upd));
    assert.equal(upd.verified_at, null, "a changed record must be re-verified");
  });
  it("the file store works in the private bucket only", async () => {
    const s = stub();
    await createSupabaseFileStore(s.db).remove("projects/a/b/c.pdf");
    assert.deepEqual(s.storageCalls, [["from", [PRECON_BUCKET]], ["remove", ["projects/a/b/c.pdf"]]]);
    assert.equal(PRECON_BUCKET, "precon-files");
  });
});

describe("citation links", () => {
  it("allow an in-app document page anchor and nothing else", () => {
    assert.equal(safeHref("/precon/documents/abc-123#p2"), "/precon/documents/abc-123#p2");
    for (const bad of ["/precon/documents/abc#evil", "/precon/x#p2/../..", "//evil.example/#p1", "https://evil.example", "javascript:alert(1)", "/a#p"]) assert.equal(safeHref(bad), undefined, bad);
  });
});
