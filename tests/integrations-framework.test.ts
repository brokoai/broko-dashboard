import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { askBrain, type BrainChatContext } from "../src/lib/ai-brain/chat";
import { connectorsFor, phase1Registry, runTool, unavailableConnectors, type ConnectorResult, type ExternalRecord, type NotionConnector } from "../src/lib/ai-brain/assistant";
import type { MeetingCandidate, MeetingDocument } from "../src/lib/ai-brain/assistant/meetings/types";
import {
  LEGACY_NOTION_CONNECTION_ID, defaultRuntime, grantFor, resolveGrants, scopedNotionConnector,
  type ConnectionRef, type IntegrationRuntime, type RegisteredResource,
} from "../src/lib/ai-brain/integrations";
import { NOW, admin, alice, bob, everything, fakeRepo } from "./ai-chat-helpers";

// Pure and fake-backed: no network, no database, no real token. Every "token" below is a made-up marker that exists only to prove it never leaks.

const PAGE_A = "aaaaaaaa-0000-4000-8000-000000000001";
const PAGE_B = "bbbbbbbb-0000-4000-8000-000000000002";
const PAGE_ORG = "cccccccc-0000-4000-8000-000000000003";
const PAGE_OTHER = "dddddddd-0000-4000-8000-000000000004";
const DB_ORG = "eeeeeeee-0000-4000-8000-000000000005";
const SECRET_A = "TESTONLY-secret-of-alice";

const rec = (id: string, title: string, parent_id?: string): ExternalRecord => ({ system: "notion", record_id: id, title, ...(parent_id ? { parent_id } : {}), retrieved_at: NOW.toISOString() });
const cand = (id: string, title: string, parent_id?: string): MeetingCandidate => ({ system: "notion", record_id: id, title, ...(parent_id ? { parent_id } : {}), date_only: false, date_source: "created_time", retrieved_at: NOW.toISOString() });
const docOf = (id: string, title: string, parent_id?: string): MeetingDocument => ({ ...cand(id, title, parent_id), segments: [{ id: "S1", ref: id, kind: "title", text: title, depth: 0 }], coverage: { complete: true, gaps: [], blocks_read: 1 } });

/** A fake provider workspace: it knows a fixed set of pages, exactly like a real token only reaches what its owner picked. */
function workspace(secret: string, pages: ExternalRecord[], log: string[]): NotionConnector {
  const known = new Map(pages.map((p) => [p.record_id, p]));
  const deny = async <T>(): Promise<ConnectorResult<T>> => ({ ok: false, reason: "permission_denied" });
  void secret; // the secret lives in this closure only, like a real client's token
  return {
    searchPages: async () => ({ ok: true, data: [...known.values()] }),
    getPage: async (id) => { const p = known.get(id); log.push(`getPage:${id}`); return p ? { ok: true, data: p } : deny(); },
    queryDatabase: async (id) => { log.push(`query:${id}`); return { ok: true, data: [...known.values()].filter((p) => p.parent_id === id) }; },
    findMeetingCandidates: async () => ({ ok: true, data: [...known.values()].map((p) => cand(p.record_id, p.title, p.parent_id)) }),
    readMeetingDocument: async (id) => { const p = known.get(id); return p ? { ok: true, data: docOf(p.record_id, p.title, p.parent_id) } : deny(); },
  };
}

interface World { rt: IntegrationRuntime; built: string[]; reads: string[]; conns: ConnectionRef[]; resources: RegisteredResource[]; failStore?: boolean }
const personal = (id: string, owner: string, over: Partial<ConnectionRef> = {}): ConnectionRef => ({ id, provider: "notion", kind: "personal", owner_id: owner, status: "active", capabilities: ["documents"], ...over });
const orgConn = (id: string, over: Partial<ConnectionRef> = {}): ConnectionRef => ({ id, provider: "notion", kind: "organization", owner_id: null, status: "active", capabilities: ["documents"], ...over });

function world(conns: ConnectionRef[], resources: RegisteredResource[] = [], pages: Record<string, ExternalRecord[]> = {}): World {
  const w: World = { built: [], reads: [], conns, resources, rt: undefined as unknown as IntegrationRuntime };
  w.rt = {
    // the store deliberately OVER-RETURNS: every connection of every employee. The framework must still keep each employee to their own.
    store: {
      connectionsFor: async () => { if (w.failStore) throw new Error("db down postgres://user:pw@host"); return w.conns; },
      resourcesOf: async (id) => w.resources.filter((r) => r.connection_id === id),
    },
    clients: { notion: async (c) => { w.built.push(c.id); return workspace(`secret-${c.id}`, pages[c.id] ?? [], w.reads); } },
  };
  return w;
}

const PAGES = { "conn-alice": [rec(PAGE_A, "Alice private notes")], "conn-bob": [rec(PAGE_B, "Bob private notes")] };
const titles = (r: ConnectorResult<ExternalRecord[]>) => (r.ok ? r.data.map((x) => x.title).sort() : r.reason);

describe("A. personal connections: owner-only", () => {
  const w = () => world([personal("conn-alice", alice.id), personal("conn-bob", bob.id)], [], PAGES);

  it("each employee sees only their own connection, even though the store returned both", async () => {
    const x = w();
    assert.deepEqual(titles(await scopedNotionConnector(x.rt, alice).searchPages("notes", 10)), ["Alice private notes"]);
    assert.deepEqual(titles(await scopedNotionConnector(x.rt, bob).searchPages("notes", 10)), ["Bob private notes"]);
  });

  it("the other employee's connection is never even opened (no client is built for it)", async () => {
    const x = w();
    await scopedNotionConnector(x.rt, alice).searchPages("notes", 10);
    assert.deepEqual(x.built, ["conn-alice"]);
  });

  it("Alice cannot fetch Bob's page by its id, with search, getPage, meeting find or meeting read", async () => {
    const x = w();
    const n = scopedNotionConnector(x.rt, alice);
    assert.deepEqual(await n.getPage(PAGE_B), { ok: false, reason: "permission_denied" });
    assert.deepEqual(await n.readMeetingDocument(PAGE_B), { ok: false, reason: "permission_denied" });
    const found = await n.findMeetingCandidates([], 10);
    assert.ok(found.ok && found.data.every((c) => c.record_id !== PAGE_B));
    assert.ok(!x.built.includes("conn-bob"), "Bob's connection was never opened on Alice's behalf");
  });

  it("an administrator is not special: they cannot use an employee's personal connection", async () => {
    const x = w();
    assert.deepEqual(await scopedNotionConnector(x.rt, admin).searchPages("notes", 10), { ok: false, reason: "not_connected" });
    assert.deepEqual(x.built, []);
    assert.equal(grantFor(admin, personal("conn-alice", alice.id), [], "notion", "documents"), null);
  });

  it("an employee with no connection gets not_connected, and nothing is built or read", async () => {
    const x = world([personal("conn-bob", bob.id)], [], PAGES);
    assert.deepEqual(await scopedNotionConnector(x.rt, alice).searchPages("notes", 10), { ok: false, reason: "not_connected" });
    assert.deepEqual(x.built, []);
  });

  it("a personal connection with no owner, or an organization connection with an owner, is refused (invalid shapes fail closed)", () => {
    assert.equal(grantFor(alice, personal("p", alice.id, { owner_id: null }), [], "notion", "documents"), null);
    assert.equal(grantFor(alice, orgConn("o", { owner_id: alice.id }), [{ connection_id: "o", provider_resource_id: PAGE_ORG, visibility: "org_members" }], "notion", "documents"), null);
  });

  it("a connection for another provider or capability is not used", () => {
    assert.equal(grantFor(alice, personal("p", alice.id, { provider: "outlook_mail", capabilities: ["mail"] }), [], "notion", "documents"), null);
    assert.equal(grantFor(alice, personal("p", alice.id, { capabilities: ["mail"] }), [], "notion", "documents"), null);
  });

  it("two connections of one employee (two workspaces) are both used and merged without duplicates", async () => {
    const x = world([personal("c1", alice.id), personal("c2", alice.id)], [], { c1: [rec(PAGE_A, "Alice workspace one")], c2: [rec(PAGE_A, "dup"), rec(PAGE_OTHER, "Alice workspace two")] });
    const r = await scopedNotionConnector(x.rt, alice).searchPages("x", 10);
    assert.deepEqual(titles(r), ["Alice workspace one", "Alice workspace two"]);
  });
});

describe("B. connection lifecycle: revoked, disconnected and unavailable fail closed, immediately", () => {
  for (const status of ["revoked", "disconnected", "needs_reauth", "error"] as const) {
    it(`a ${status} connection is not used and nothing is read`, async () => {
      const x = world([personal("conn-alice", alice.id, { status })], [], PAGES);
      assert.deepEqual(await scopedNotionConnector(x.rt, alice).searchPages("x", 5), { ok: false, reason: "not_connected" });
      assert.deepEqual(x.built, []);
      assert.deepEqual(x.reads, []);
    });
  }

  it("revocation takes effect on the very next call (nothing is cached)", async () => {
    const x = world([personal("conn-alice", alice.id)], [], PAGES);
    const n = scopedNotionConnector(x.rt, alice);
    assert.ok((await n.searchPages("x", 5)).ok);
    x.conns = [personal("conn-alice", alice.id, { status: "revoked" })];
    assert.deepEqual(await n.searchPages("x", 5), { ok: false, reason: "not_connected" });
    assert.deepEqual(await n.getPage(PAGE_A), { ok: false, reason: "not_connected" });
  });

  it("a store failure is an error, not an open door: no client is built and no error text leaks", async () => {
    const x = world([personal("conn-alice", alice.id)], [], PAGES);
    x.failStore = true;
    const r = await scopedNotionConnector(x.rt, alice).searchPages("x", 5);
    assert.deepEqual(r, { ok: false, reason: "error" });
    assert.deepEqual(x.built, []);
    assert.ok(!JSON.stringify(r).includes("postgres"));
  });

  it("a client factory that throws or returns nothing leaves the employee not connected", async () => {
    const base = world([personal("conn-alice", alice.id)], [], PAGES);
    const thrower: IntegrationRuntime = { store: base.rt.store, clients: { notion: async () => { throw new Error(SECRET_A); } } };
    const nothing: IntegrationRuntime = { store: base.rt.store, clients: { notion: async () => null } };
    const missing: IntegrationRuntime = { store: base.rt.store, clients: {} };
    for (const rt of [thrower, nothing, missing]) {
      const r = await scopedNotionConnector(rt, alice).searchPages("x", 5);
      assert.deepEqual(r, { ok: false, reason: "not_connected" });
      assert.ok(!JSON.stringify(r).includes("TESTONLY"));
    }
  });

  it("a signed-out caller (no user id) gets nothing", async () => {
    const x = world([personal("conn-alice", alice.id)], [], PAGES);
    const ghost = { ...alice, id: "" };
    assert.deepEqual(await resolveGrants(x.rt, ghost, "notion", "documents"), { ok: false, reason: "not_connected" });
    assert.deepEqual(x.built, []);
  });
});

describe("C. organization connections: only explicitly registered resources, with a visibility policy", () => {
  const reg = (id: string, visibility: RegisteredResource["visibility"] = "org_members", connection_id = "org1"): RegisteredResource => ({ connection_id, provider_resource_id: id, visibility });
  const ORG_PAGES = { org1: [rec(PAGE_ORG, "Company handbook"), rec(PAGE_OTHER, "Secret HR file"), rec(PAGE_A, "Row in the registered database", DB_ORG)] };

  it("an organization connection with NO registered resource grants nothing, however much its token can reach", async () => {
    const x = world([orgConn("org1")], [], ORG_PAGES);
    assert.deepEqual(await scopedNotionConnector(x.rt, alice).searchPages("x", 10), { ok: false, reason: "not_connected" });
    assert.deepEqual(x.built, []);
  });

  it("only registered pages (and rows of a registered database) come back; everything else the token can reach is dropped", async () => {
    const x = world([orgConn("org1")], [reg(PAGE_ORG), reg(DB_ORG)], ORG_PAGES);
    const r = await scopedNotionConnector(x.rt, alice).searchPages("x", 10);
    assert.deepEqual(titles(r), ["Company handbook", "Row in the registered database"]);
    assert.ok(!JSON.stringify(r).includes("Secret HR"));
  });

  it("an unregistered page by id is refused even though the organization token can open it, and its content is not returned", async () => {
    const x = world([orgConn("org1")], [reg(PAGE_ORG)], ORG_PAGES);
    const n = scopedNotionConnector(x.rt, alice);
    const g = await n.getPage(PAGE_OTHER);
    const m = await n.readMeetingDocument(PAGE_OTHER);
    assert.deepEqual(g, { ok: false, reason: "permission_denied" });
    assert.deepEqual(m, { ok: false, reason: "permission_denied" });
    assert.ok(!JSON.stringify([g, m]).includes("Secret HR"));
    assert.equal((await n.getPage(PAGE_ORG)).ok, true);
  });

  it("a database can be listed only if it is itself registered (the client is not even called otherwise)", async () => {
    const x = world([orgConn("org1")], [reg(PAGE_ORG)], ORG_PAGES);
    const n = scopedNotionConnector(x.rt, alice);
    assert.deepEqual(await n.queryDatabase(DB_ORG, 5), { ok: false, reason: "permission_denied" });
    assert.ok(!x.reads.includes(`query:${DB_ORG}`));
    const y = world([orgConn("org1")], [reg(DB_ORG)], ORG_PAGES);
    const rows = await scopedNotionConnector(y.rt, alice).queryDatabase(DB_ORG, 5);
    assert.ok(rows.ok);
    assert.deepEqual(rows.data.map((p) => p.title), ["Row in the registered database"]);
  });

  it("visibility is enforced: an admins-only resource is invisible to a member and visible to an administrator", async () => {
    const x = world([orgConn("org1")], [reg(PAGE_ORG, "admins")], ORG_PAGES);
    assert.deepEqual(await scopedNotionConnector(x.rt, alice).searchPages("x", 10), { ok: false, reason: "not_connected" });
    assert.deepEqual(titles(await scopedNotionConnector(x.rt, admin).searchPages("x", 10)), ["Company handbook"]);
  });

  it("registered resources of ANOTHER connection do not widen this one", async () => {
    const x = world([orgConn("org1")], [reg(PAGE_ORG, "org_members", "someone-elses-connection")], ORG_PAGES);
    assert.deepEqual(await scopedNotionConnector(x.rt, alice).searchPages("x", 10), { ok: false, reason: "not_connected" });
  });

  it("the whole-workspace marker is ignored on any connection that is not the legacy one", async () => {
    const x = world([orgConn("org1")], [reg("*")], ORG_PAGES);
    assert.deepEqual(await scopedNotionConnector(x.rt, admin).searchPages("x", 10), { ok: false, reason: "not_connected" });
    assert.equal(grantFor(admin, orgConn("org1"), [reg("*")], "notion", "documents"), null);
  });

  it("an organization connection never lets an employee reach a colleague's personal content", async () => {
    const x = world([personal("conn-bob", bob.id), orgConn("org1")], [reg(PAGE_ORG)], { ...PAGES, ...ORG_PAGES });
    const r = await scopedNotionConnector(x.rt, alice).searchPages("x", 10);
    assert.deepEqual(titles(r), ["Company handbook"]);
    assert.ok(!x.built.includes("conn-bob"));
  });

  it("personal results win over an organization copy of the same page, and ordering puts personal connections first", async () => {
    const x = world([orgConn("org1"), personal("conn-alice", alice.id)], [reg(PAGE_ORG)], { "conn-alice": [rec(PAGE_ORG, "Alice's copy")], org1: [rec(PAGE_ORG, "Org copy")] });
    assert.deepEqual(titles(await scopedNotionConnector(x.rt, alice).searchPages("x", 10)), ["Alice's copy"]);
  });
});

describe("D. legacy shared-token connection (feature-flagged, administrators only)", () => {
  const TOKEN = ["ntn", "_", "TESTONLY", "0123456789abcdefghijklmnopqrstuvwxyz"].join("");
  const env = (extra: Record<string, string> = {}) => ({ NOTION_API_KEY: TOKEN, ...extra });

  it("without the legacy flag the shared token is not offered to anyone", async () => {
    const rt = defaultRuntime(env({ BROKO_CONNECTION_FRAMEWORK: "1" }), NOW);
    assert.deepEqual(await resolveGrants(rt, admin, "notion", "documents"), { ok: false, reason: "not_connected" });
  });

  it("with the legacy flag, an administrator gets the workspace-wide grant and a member gets nothing", async () => {
    const rt = defaultRuntime(env({ BROKO_CONNECTION_FRAMEWORK: "1", BROKO_LEGACY_NOTION_CONNECTION: "1" }), NOW);
    const a = await resolveGrants(rt, admin, "notion", "documents");
    assert.ok(a.ok);
    assert.equal(a.grants[0].connection.id, LEGACY_NOTION_CONNECTION_ID);
    assert.equal(a.grants[0].connection.kind, "organization");
    assert.equal(a.grants[0].scope, "all");
    assert.deepEqual(await resolveGrants(rt, alice, "notion", "documents"), { ok: false, reason: "not_connected" });
    assert.ok(!JSON.stringify(a).includes(TOKEN), "the grant carries no token");
  });

  it("the legacy flag without a usable token offers nothing", async () => {
    const rt = defaultRuntime({ BROKO_LEGACY_NOTION_CONNECTION: "1", NOTION_API_KEY: "short" }, NOW);
    assert.deepEqual(await resolveGrants(rt, admin, "notion", "documents"), { ok: false, reason: "not_connected" });
  });

  it("only the legacy connection id is ever given the environment token", async () => {
    const rt = defaultRuntime(env({ BROKO_LEGACY_NOTION_CONNECTION: "1" }), NOW);
    assert.equal(await rt.clients.notion!(personal("conn-alice", alice.id)), null);
    assert.equal(await rt.clients.notion!(orgConn("org1")), null);
    assert.equal(await rt.clients.notion!(orgConn("org1", { legacy: true })), null, "a legacy flag on a different id does not unlock it");
  });
});

describe("E. wiring: flags, existing behaviour preserved, tool registry still the only path", () => {
  const live = (user = alice, extra: Partial<BrainChatContext> = {}): BrainChatContext => ({ user, repo: fakeRepo().repo, mode: "live", now: NOW, ...extra });
  const saved = { ...process.env };
  afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  const flagOn = (extra: Record<string, string> = {}) => { process.env.BROKO_CONNECTION_FRAMEWORK = "1"; Object.assign(process.env, extra); };

  it("flag off (the default): injected integrations are ignored and no environment token means not connected, as before", async () => {
    delete process.env.NOTION_API_KEY; delete process.env.BROKO_CONNECTION_FRAMEWORK;
    const x = world([personal("conn-alice", alice.id)], [], PAGES);
    const c = connectorsFor(live(alice, { integrations: x.rt }), process.env);
    assert.deepEqual(await c.notion.searchPages("x", 5), { ok: false, reason: "not_connected" });
    assert.deepEqual(x.built, []);
  });

  it("flag off: an injected connectors object still wins, exactly as before", () => {
    const fake = unavailableConnectors();
    assert.equal(connectorsFor(live(alice, { connectors: fake }), { BROKO_CONNECTION_FRAMEWORK: "1" }), fake);
  });

  it("flag on in demo mode: still no external access", async () => {
    const x = world([personal("conn-alice", alice.id)], [], PAGES);
    const c = connectorsFor({ ...live(alice, { integrations: x.rt }), mode: "demo" }, { BROKO_CONNECTION_FRAMEWORK: "1" });
    assert.deepEqual(await c.notion.searchPages("x", 5), { ok: false, reason: "not_connected" });
    assert.deepEqual(x.built, []);
  });

  it("flag on: two employees asking the same Brain question through chat each get only their own Notion pages", async () => {
    flagOn();
    const x = world([personal("conn-alice", alice.id), personal("conn-bob", bob.id)], [], PAGES);
    const a = everything(await askBrain(live(alice, { integrations: x.rt }), "Search Notion for notes"));
    const b = everything(await askBrain(live(bob, { integrations: x.rt }), "Search Notion for notes"));
    assert.ok(a.includes("Alice private notes") && !a.includes("Bob private notes"), "alice sees only hers");
    assert.ok(b.includes("Bob private notes") && !b.includes("Alice private notes"), "bob sees only his");
    for (const t of [a, b]) assert.ok(!t.includes("TESTONLY") && !t.includes("secret-conn"), "no secret in a reply");
  });

  it("flag on: a colleague with no connection is told Notion is not connected and sees nothing", async () => {
    flagOn();
    const x = world([personal("conn-alice", alice.id)], [], PAGES);
    const text = everything(await askBrain(live(bob, { integrations: x.rt }), "Search Notion for notes"));
    assert.ok(!text.includes("Alice private notes"));
    assert.match(text, /not connected/i);
  });

  it("flag on: after Alice's connection is revoked her next question reads nothing", async () => {
    flagOn();
    const x = world([personal("conn-alice", alice.id)], [], PAGES);
    assert.ok(everything(await askBrain(live(alice, { integrations: x.rt }), "Search Notion for notes")).includes("Alice private notes"));
    x.conns = [personal("conn-alice", alice.id, { status: "revoked" })];
    const after = everything(await askBrain(live(alice, { integrations: x.rt }), "Search Notion for notes"));
    assert.ok(!after.includes("Alice private notes"));
  });

  it("meeting tools stay administrator-only in Phase A, even with a personal connection (lifted later, behind its own review)", async () => {
    flagOn();
    const x = world([personal("conn-alice", alice.id)], [], PAGES);
    const brain = live(alice, { integrations: x.rt });
    const r = await runTool(phase1Registry(), "notion.meetings.find", { keywords: [] }, { user: alice, now: NOW, brain, connectors: connectorsFor(brain, process.env) });
    assert.deepEqual([r.ok, r.ok ? "" : r.reason], [false, "permission_denied"]);
    assert.deepEqual(x.built, []);
  });

  it("flag on: the shared environment token is never offered to a member, with or without the legacy flag", async () => {
    flagOn({ NOTION_API_KEY: ["ntn", "_", "TESTONLY", "0123456789abcdefghijklmnopqrstuvwxyz"].join("") });
    const member = connectorsFor(live(alice), process.env);
    assert.deepEqual(await member.notion.searchPages("x", 5), { ok: false, reason: "not_connected" }, "legacy flag off: nobody");
    process.env.BROKO_LEGACY_NOTION_CONNECTION = "1";
    assert.deepEqual(await connectorsFor(live(alice), process.env).notion.searchPages("x", 5), { ok: false, reason: "not_connected" }, "legacy flag on: still not a member");
  });
});

describe("F. static guarantees", () => {
  const dir = join(process.cwd(), "src/lib/ai-brain/integrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const src = (f: string) => readFileSync(join(dir, f), "utf8");

  it("the framework makes no network call, reads no secret from the environment except through the legacy module, and logs nothing", () => {
    for (const f of files) {
      const s = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      assert.ok(!/\bfetch\s*\(/.test(s), `${f} must not call fetch`);
      assert.ok(!/console\./.test(s), `${f} must not log`);
      if (f !== "legacy.ts") assert.ok(!/process\.env|NOTION_API_KEY/.test(s), `${f} must not read the environment`);
    }
  });

  it("a ConnectionRef has no field that can hold a token, key or secret", () => {
    const body = /export interface ConnectionRef \{([\s\S]*?)\n\}/.exec(src("types.ts"))![1];
    assert.ok(!/token|secret|key|password|credential/i.test(body.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")));
  });

  it("no integration file imports a database client or writes anything (Phase A has no storage)", () => {
    for (const f of files) assert.ok(!/supabase|createClient|\.insert\(|\.update\(|\.delete\(/.test(src(f)), `${f} must not touch a database`);
  });
});
