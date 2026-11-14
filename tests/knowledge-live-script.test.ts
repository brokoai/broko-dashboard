import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { answerKnowledge } from "../src/lib/ai-brain/chat/knowledge";
import type { Repo } from "../src/lib/backend/types";
import { createMemoryKnowledgeRepo, emptyKnowledgeStore } from "../src/lib/knowledge/memory-repo";
import { checkReview, isCurrent } from "../src/lib/knowledge/policy";
import { reviewKnowledge, submitKnowledge } from "../src/lib/knowledge/service";
import {
  CLEANUP_STRATEGY, DEV_REF, PLAN, PLAN_IDS, SAFETY_NET_MS, keyRole, markerOf, newRunId, presenceVerdict, purgeSql, safetyExpiry, targetProblems, titleOf, topicOf, wordOf, type Manifest,
} from "./live/lib/knowledge-live-plan";
import { ADMIN, MEMBER, world } from "./precon-helpers";

// Local checks for the LIVE knowledge script (tests/live/knowledge-live-dev.script.ts). Nothing here touches a network or a database.

const SCRIPT = readFileSync(new URL("./live/knowledge-live-dev.script.ts", import.meta.url), "utf8");
const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const GOOD = { url: `https://${DEV_REF}.supabase.co`, confirm: "broko-dev", key: "sb_publishable_abc", linkedRef: DEV_REF };

describe("live knowledge script: target guard (fails closed)", () => {
  it("accepts only the approved development project, confirmed three ways", () => {
    assert.deepEqual(targetProblems(GOOD), []);
    assert.ok(targetProblems({ ...GOOD, url: "https://esjloyhgipkdmdnvoiut.supabase.co" }).length > 0, "another project ref is refused");
    assert.ok(targetProblems({ ...GOOD, url: `https://${DEV_REF}.example.com` }).length > 0, "a look-alike host is refused");
    assert.ok(targetProblems({ ...GOOD, url: `http://${DEV_REF}.supabase.co` }).length > 0, "plain http is refused");
    assert.ok(targetProblems({ ...GOOD, url: undefined }).length > 0);
    assert.ok(targetProblems({ ...GOOD, confirm: undefined }).length > 0, "missing confirmation is refused");
    assert.ok(targetProblems({ ...GOOD, confirm: "production" }).length > 0);
    assert.ok(targetProblems({ ...GOOD, linkedRef: "esjloyhgipkdmdnvoiut" }).length > 0, "a different locally linked project is refused");
    assert.ok(targetProblems({ ...GOOD, linkedRef: null }).length > 0, "an unknown linked project is refused");
    assert.ok(targetProblems({ ...GOOD, key: undefined }).length > 0);
  });

  it("refuses secret and service-role keys", () => {
    const jwt = (role: string) => `h.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.s`;
    assert.equal(keyRole(jwt("service_role")), "service_role");
    assert.ok(targetProblems({ ...GOOD, key: jwt("service_role") }).length > 0);
    assert.ok(targetProblems({ ...GOOD, key: "sb_secret_abc" }).length > 0);
    assert.deepEqual(targetProblems({ ...GOOD, key: jwt("anon") }), []);
  });
});

describe("live knowledge script: plan and source agree", () => {
  it("every planned id is unique and every id the script reports is planned", () => {
    assert.equal(PLAN_IDS.size, PLAN.length);
    const used = new Set([...code.matchAll(/\b(?:check|blocked)\("([A-G]\d+)"/g)].map((m) => m[1]));
    for (const id of used) assert.ok(PLAN_IDS.has(id), `${id} is reported but not planned`);
    for (const s of PLAN) assert.ok(used.has(s.id), `${s.id} is planned but never reported by the script`);
  });

  it("covers the five areas requested", () => {
    for (const g of ["A", "B", "C", "D", "E", "F", "G"] as const) assert.ok(PLAN.some((s) => s.group === g));
    assert.ok(PLAN.find((s) => s.id === "C9")?.text.includes("DOCUMENTED DESIGN"), "admin self-approval is recorded as documented behaviour");
  });
});

describe("live knowledge script: static safety guards", () => {
  it("never uses a service-role key, never exits the process abruptly, never reads unexpected env", () => {
    assert.ok(!/SERVICE_ROLE|service_role|createAdmin|SUPABASE_SECRET|sb_secret/i.test(code), "no secret-key path");
    assert.ok(!/process\.exit\(/.test(code));
    const env = new Set([...code.matchAll(/process\.env\.([A-Z_]+)|need\("([A-Z_]+)"\)|need\((\w+)\)/g)].map((m) => m[1] ?? m[2]).filter(Boolean));
    for (const k of env) assert.match(k, /^(PRECON_LIVE_|KNOWLEDGE_LIVE_)/, `unexpected environment variable ${k}`);
  });

  it("requires an explicit mode and runs the dry run before any client is created", () => {
    assert.match(code, /Choose a mode: --dry-run/);
    const dry = code.slice(code.indexOf("function dryRun"), code.indexOf("interface Session"));
    assert.ok(!/createClient|fetch\(|signIn/.test(dry), "dry run is network-free");
  });

  it("only calls the review function; it never executes DDL or a purge", () => {
    const rpcs = [...code.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    // knowledge_review does the writing; knowledge_redact (0011) is the administrator removal path; the secret functions are only probed for refusal.
    const allowed = new Set(["knowledge_review", "knowledge_redact", "knowledge_secret_signal", "knowledge_secret_guard", "knowledge_events_secret_guard"]);
    assert.ok(rpcs.length > 0 && rpcs.every((n) => allowed.has(n)), "unexpected rpc");
    assert.ok(!/delete from|drop |alter |truncate|grant |revoke |disable row level/i.test(code.replace(/"[^"]*cannot[^"]*"/g, "")), "no DDL/purge text in executable code");
  });

  it("the only chat_audit insert is the pair of probes that carry an invalid latency (they can never store a row)", () => {
    const inserts = [...code.matchAll(/from\("chat_audit"\)\.insert\(/g)];
    assert.equal(inserts.length, 1);
    assert.match(code, /latency_ms: -1/);
    assert.ok(!/from\("chat_audit"\)\.(update|upsert)\([^)]*\)\.eq\("id", (?!ZERO)/.test(code));
  });

  it("direct update/delete attempts only target items it created or the all-zero id", () => {
    const lines = code.split(/\r?\n/).filter((l) => /\.(update|delete)\(/.test(l) && /from\("(knowledge_items|knowledge_events|answer_feedback|chat_audit)"\)/.test(l));
    assert.ok(lines.length >= 8);
    for (const l of lines) {
      for (const m of l.matchAll(/\.(update|delete)\(.*?\)\.eq\("\w+", (.+?)\);?\s*$/g)) assert.match(m[2], /^(mine\.id|stillProposed\.id|ZERO|String\(afterE1\[0\]\?\.id \?\? ZERO\))\)?$/, `unexpected target in: ${l.trim().slice(0, 100)}`);
      assert.match(l, /\.eq\(/, `an update/delete without a row filter: ${l.trim().slice(0, 100)}`);
    }
  });

  it("cleanup runs in a finally block, through knowledge_review only, and never retries a write", () => {
    assert.match(code, /finally \{\s*await cleanup\(\);/);
    assert.ok(code.includes('review(id, "reject"') && code.includes('review(id, "expire"'));
    assert.ok(!/for \(let attempt|retry|while \(true\)/i.test(code));
  });
});

describe("live knowledge script: the 0011 / 0012 checks (group G)", () => {
  it("builds every secret-shaped string from parts: no credential-like literal is in the script", () => {
    assert.ok(!/(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.|AKIA[0-9A-Z]{16}|-----BEGIN|ghp_[A-Za-z0-9]{20}|xox[baprs]-/.test(SCRIPT));
    assert.match(code, /const KEY = \["sk", "-"/);
  });
  it("uses the shared corpus, and redacts anything a secret probe unexpectedly stored", () => {
    assert.match(code, /secret-corpus\.json/);
    assert.match(code, /UNEXPECTEDLY STORED/);
    assert.match(code, /knowledge_redact", \{ p_id: x\.id, p_reason: "secret" \}/);
  });
  it("probes only the dedicated redaction path and refusals; the only redaction targets are rows this run created", () => {
    const targets = [...code.matchAll(/rpc\("knowledge_redact", \{ p_id: ([^,]+),/g)].map((m) => m[1]);
    assert.ok(targets.length >= 6);
    for (const t of targets) assert.match(t, /^(x\.id|redactT\.id|rA\.id|ZERO)$/, `unexpected redaction target ${t}`);
  });
  it("the manifest records only ids, labels and the author role: never text, credentials or secret test strings", () => {
    const pushes = [...code.matchAll(/manifest\.(items|feedback)\.push\(([^;]*)\);/g)].map((m) => m[0]);
    assert.ok(pushes.length >= 3);
    for (const l of pushes) assert.ok(!/body|title|KEY|password|anonKey|process\.env|text/i.test(l.replace(/label: `UNEXPECTEDLY STORED: \$\{label\}`/, "")), `manifest push carries more than ids/labels: ${l.slice(0, 100)}`);
    assert.match(code, /JSON\.stringify\(manifest, null, 2\)/);
  });
  it("nothing the script prints can carry a credential: the environment is only reported as set or not set", () => {
    const logs = code.split(/\r?\n/).filter((l) => /console\.(log|error)|info\(/.test(l));
    for (const l of logs) assert.ok(!/anonKey|_PASSWORD|_EMAIL|need\(/.test(l.replace(/process\.env\[k\] \? "set" : "not set"/, "").replace(/\$\{k\.padEnd\(28\)\}/, "")), `a log line may print a credential: ${l.trim().slice(0, 100)}`);
  });
  it("helper items that only an administrator needs go to an archived project when one exists, and the org-scope G1 items are retired right after G1", () => {
    assert.match(code, /const iso: Record<string, unknown> = archived \?/);
    assert.match(code, /mustCreate\(admin, "admin", "note screening target", iso\)/);
    assert.match(code, /mustCreate\(admin, "admin", "redaction bystander", iso\)/);
    assert.ok(code.indexOf("await retire(gOld.id, gPlain.id)") > code.indexOf('check("G1"') && code.indexOf("await retire(gOld.id, gPlain.id)") < code.indexOf('check("G3"'));
  });
  it("the plan lists group G with a blocked placeholder for the approval-time mismatch", () => {
    assert.equal(PLAN.filter((s) => s.group === "G").length, 12);
    assert.match(code, /blocked\("G2"/);
  });
});

describe("live knowledge script: run identity and cleanup artefacts", () => {
  it("run ids are unique and the marker, topic and title obey the database rules", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRunId()));
    assert.equal(ids.size, 50);
    const id = newRunId(new Date("2026-10-29T10:11:12Z"), () => 0.5);
    assert.equal(id, "20261029101112-888888");
    assert.match(topicOf(id, "conf"), /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(topicOf(id, "x".repeat(80)).length <= 60);
    const t = titleOf(id, "member proposal");
    assert.ok(t.startsWith(markerOf(id)) && t.length >= 3 && t.length <= 160);
    assert.match(wordOf(id), /^[a-z]+$/);
  });

  it("the purge SQL is scoped to the manifest, refuses non-uuids, and ends in a rollback by default", () => {
    const m: Manifest = { runId: "20261029101112-888888", startedAt: "x", target: DEV_REF, items: [{ id: "11111111-2222-4333-8444-555555555555", label: "a", author: "member" }], feedback: ["aaaaaaaa-2222-4333-8444-555555555555"] };
    const sql = purgeSql(m);
    assert.match(sql, /delete from public\.answer_feedback where id in \('aaaaaaaa/);
    assert.match(sql, /delete from public\.knowledge_events where item_id in \('11111111/);
    assert.match(sql, /delete from public\.knowledge_items where id in \('11111111[^;]*title like '\[LIVE-TEST 20261029101112-888888\]%'/);
    assert.ok(sql.indexOf("answer_feedback") < sql.indexOf("knowledge_events") && sql.indexOf("knowledge_events") < sql.indexOf("from public.knowledge_items"), "children first");
    assert.match(sql, /rollback; --/);
    assert.throws(() => purgeSql({ ...m, items: [{ id: "x'; drop table public.profiles; --", label: "a", author: "member" }] }));
    assert.ok(CLEANUP_STRATEGY.some((l) => /never executed|PRINTS/.test(l)));
  });
});

describe("live knowledge script: rehearsal of the conflict check on the in-memory repository", () => {
  it("two same-topic, different-text approved items are reported as a conflict by the exact question the script asks", async () => {
    const w = world();
    const store = emptyKnowledgeStore();
    const now = new Date("2026-10-26T12:00:00Z");
    const mk = (user: typeof ADMIN) => createMemoryKnowledgeRepo({ user, store, writable: true, now: () => now, projectIds: async () => new Set() });
    const kctx = (user: typeof ADMIN) => ({ user, repo: mk(user), precon: w.repoFor(user), now: () => now, log: () => undefined });
    const runId = "20261029101112-1a2b3c"; const word = wordOf(runId); const topic = topicOf(runId, "conf");
    for (const [label, method] of [["one", "alpha"], ["two", "beta"]] as const) {
      const it = await submitKnowledge(kctx(ADMIN), {
        kind: "procedure", scope: "organization", project_id: null, title: titleOf(runId, `conflict ${label} ${word}`), topic,
        body: `The ${word} rule says use method ${method}. Synthetic text for run ${runId}.`, source_ref: markerOf(runId), supersedes_id: null, expires_on: null,
      });
      await reviewKnowledge(kctx(ADMIN), { id: it.id, action: "approve", note: "conflict" });
    }
    const ctx = { user: MEMBER, mode: "live" as const, now, repo: { knowledge: mk(MEMBER), precon: w.repoFor(MEMBER) } as unknown as Repo };
    const answer = await answerKnowledge(ctx, `how do we handle the ${word} rule`, { explicit: true });
    assert.ok(answer?.sections.some((s) => (s.heading ?? "").startsWith("Conflicting approved knowledge")), JSON.stringify(answer?.sections.map((s) => s.heading)));
  });
});

describe("live knowledge script: visibility safety (expiry net, eager retirement, presence check)", () => {
  const T0 = Date.parse("2026-10-29T12:00:00Z");

  it("every test item gets a database-time expiry of exactly 10 minutes unless a check overrides it", () => {
    assert.equal(SAFETY_NET_MS, 600_000);
    assert.equal(safetyExpiry(T0), "2026-10-29T12:10:00.000Z");
    assert.match(code, /expires_at: safetyExpiry\(dbNow\(\)\), body:/, "row() defaults expires_at to the safety net, before the overrides are spread");
    assert.ok(code.indexOf("expires_at: safetyExpiry(dbNow())") < code.indexOf("...over }"), "an explicit override still wins");
    assert.ok(!/expires_at: null/.test(code.slice(code.indexOf("function row"), code.indexOf("const COLS"))));
  });

  it("the net works with the real expiry and retrieval rules: current before 10 minutes, gone after, and an expired proposal cannot be approved", () => {
    const item = { status: "approved" as const, effective_from: new Date(T0).toISOString(), expires_at: safetyExpiry(T0) };
    assert.equal(isCurrent(item, new Date(T0 + 9 * 60_000 + 59_000)), true);
    assert.equal(isCurrent(item, new Date(T0 + 10 * 60_000 + 1_000)), false);
    const proposed = { status: "proposed" as const, expires_at: safetyExpiry(T0) };
    assert.equal(checkReview(proposed, "approve", null, new Date(T0 + 60_000)), null);
    assert.ok(checkReview(proposed, "approve", null, new Date(T0 + 11 * 60_000)), "approval after the net has passed is refused");
    assert.equal(checkReview(proposed, "reject", "reason", new Date(T0 + 11 * 60_000)), null, "rejecting an expired proposal stays possible, so cleanup always works");
  });

  it("eager retirement goes through knowledge_review only, is limited to approved items, and covers every long-lived approved item after its last use", () => {
    const fn = code.slice(code.indexOf("async function retire"), code.indexOf("const mustCreate"));
    assert.match(fn, /\(await statusOf\(id\)\) !== "approved"\) continue;/);
    assert.match(fn, /review\(id, "expire"/);
    assert.ok(!/\.(update|delete|insert)\(/.test(fn) && !/process\.exit|throw /.test(fn), "no direct write and it never throws");
    for (const id of ["mine.id", "repl.id", "self.id", "c1i.id, c2i.id", "nearFuture.id", "d8i.id", "d7i.id"]) assert.ok(code.includes(`await retire(${id});`), `${id} is retired`);
    // retirement happens after the assertion that needs the item, never before it
    const after = (item: string, check: string) => assert.ok(code.indexOf(`await retire(${item});`) > code.indexOf(`check("${check}"`), `${item} retired only after ${check}`);
    after("mine.id", "C5"); after("repl.id", "C6"); after("self.id", "C9"); after("c1i.id, c2i.id", "D3"); after("nearFuture.id", "D2"); after("d8i.id", "D8"); after("d7i.id", "D7");
  });

  it("the presence check is a head-only count that reads no profile details, refuses by default and needs the exact count to override", () => {
    assert.deepEqual(presenceVerdict(0, undefined).ok, true);
    assert.equal(presenceVerdict(3, undefined).ok, false);
    assert.equal(presenceVerdict(3, "").ok, false);
    assert.equal(presenceVerdict(3, "yes").ok, false);
    assert.equal(presenceVerdict(3, "2").ok, false, "a stale acknowledgement does not apply");
    assert.equal(presenceVerdict(3, "4").ok, false);
    assert.equal(presenceVerdict(3, "3").ok, true);
    assert.match(presenceVerdict(3, undefined).message, /KNOWLEDGE_LIVE_ALLOW_OTHER_USERS=3/);
    const a6 = code.slice(code.indexOf("const others = await"), code.indexOf("const memberRepo"));
    assert.match(a6, /select\("id", \{ count: "exact", head: true \}\)/, "count only, no rows come back");
    assert.ok(!/email|full_name|name|\.data/.test(a6.replace(/KNOWLEDGE_LIVE_ALLOW_OTHER_USERS/g, "")), "no profile detail is read or printed");
    assert.match(a6, /throw new Abort/, "refusal happens before any write");
    assert.ok(code.indexOf("const others = await") < code.indexOf("const runId = newRunId()"), "the check runs before the run identity and every insert");
    assert.ok(code.indexOf("const others = await") > code.indexOf('check("A2"'));
  });

  it("the dry run documents the override and the plan lists A6", () => {
    assert.ok(PLAN_IDS.has("A6") && PLAN.find((s) => s.id === "A6")?.writes === false);
    assert.ok(CLEANUP_STRATEGY.some((l) => /10 minutes/.test(l)) && CLEANUP_STRATEGY.some((l) => /Eager retirement/.test(l)));
    assert.match(SCRIPT, /KNOWLEDGE_LIVE_ALLOW_OTHER_USERS=<exact count>|KNOWLEDGE_LIVE_ALLOW_OTHER_USERS/);
    assert.match(SCRIPT, /KNOWLEDGE_LIVE_ALLOW_OTHER_USERS=<N>|ALLOW_OTHER_USERS=<N>|ALLOW_OTHER_USERS/);
  });
});
