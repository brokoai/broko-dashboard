import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ResultsLog, openResultsLog, resultsPathOf, safeCodes, safeLabel, type LogIo } from "./live/lib/results-log";
import { PLAN } from "./live/lib/knowledge-live-plan";

// Local checks for the results log of the LIVE knowledge script. No network, no database: an in-memory writer, plus temp-folder round trips.

const SCRIPT = readFileSync(new URL("./live/knowledge-live-dev.script.ts", import.meta.url), "utf8");
const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const DIR = "/tmp/broko-knowledge-live";

/** An in-memory folder whose create() fails with EEXIST exactly like flag "wx", so exclusive creation is exercised without a disk. */
function memory(existing: string[] = []) {
  const files = new Map<string, string>(existing.map((p) => [p, "FOREIGN CONTENT\n"]));
  const created: string[] = [];
  const io: LogIo = {
    mkdir: () => undefined,
    create: (p, d) => { if (files.has(p)) throw Object.assign(new Error("exists"), { code: "EEXIST" }); files.set(p, d); created.push(p); },
    append: (p, d) => void files.set(p, (files.get(p) ?? "") + d),
  };
  const text = (p: string) => files.get(p) ?? "";
  const lines = (p: string) => text(p).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { io, files, created, text, lines };
}
const T0 = () => new Date("2026-11-03T10:00:00Z");
const open = (m: ReturnType<typeof memory>, id = "20261103100000-abcdef", problems: string[] = []) => openResultsLog(DIR, id, m.io, T0, (x) => problems.push(x));

// Strings that must never reach a log, however they get into a failure summary.
const SECRETS = ["hunter2-password", "someone@example.com", ["sk", "-", "LiveTest", "A1b2C3d4E5f6G7"].join(""), "eyJhbGciOiJIUzI1NiJ9", "Bearer abc.def.ghi", "SELECT * FROM knowledge_items WHERE body = 'x'", "question: what is Dana's salary?", "ECONNRESET at TLSSocket.onHandle"];

describe("results log: statuses and format", () => {
  it("logs PASS, FAIL, BLOCKED and NOT_RUN, then a summary with the totals", () => {
    const m = memory(); const log = open(m); const p = log.path;
    log.link("20261103100001-123456");
    log.record("B1", "member proposal is stored as proposed", "PASS");
    log.record("B2", "member cannot insert status approved", "FAIL", "23514: some database text; 42501: other text");
    log.record("D4", "stale-item labelling", "BLOCKED", undefined, "reviewed_at is stamped by the database");
    log.finish([{ id: "B1", text: "x" }, { id: "B2", text: "x" }, { id: "D4", text: "x" }, { id: "G9", text: "knowledge_redact refuses an unknown reason" }, { id: "F1", text: "cleanup" }], new Set(["B1", "B2", "D4"]));
    const l = m.lines(p);
    assert.equal(l[0].type, "start");
    assert.equal(l[0].intended_target, "broko-dev");
    assert.ok(!("target" in l[0]), "the old field name is gone");
    assert.deepEqual(l[1], { type: "run", at: "2026-11-03T10:00:00.000Z", runId: "20261103100001-123456", manifest: "20261103100001-123456.json" });
    const checks = l.filter((x) => x.type === "check");
    assert.deepEqual(checks.map((c) => [c.id, c.status]), [["B1", "PASS"], ["B2", "FAIL"], ["D4", "BLOCKED"], ["G9", "NOT_RUN"], ["F1", "NOT_RUN"]]);
    assert.deepEqual(checks[1].codes, ["23514", "42501"]);
    assert.equal(checks[2].reason, "reviewed_at is stamped by the database");
    assert.equal(checks[0].codes, undefined, "a pass carries no codes");
    assert.deepEqual(l.at(-1), { type: "summary", at: "2026-11-03T10:00:00.000Z", passed: 1, failed: 1, blocked: 1, not_run: 2, not_run_ids: ["G9", "F1"] });
    assert.deepEqual(checks.map((c) => c.seq), [1, 2, 3, 4, 5]);
  });

  it("finish() writes once; calling it again changes nothing", () => {
    const m = memory(); const log = open(m);
    log.finish(PLAN, new Set());
    const first = m.text(log.path);
    log.finish(PLAN, new Set());
    assert.equal(m.text(log.path), first);
    assert.equal(m.lines(log.path).filter((x) => x.status === "NOT_RUN").length, PLAN.length);
  });

  it("the file name is unique per run and sits next to the manifest", () => {
    assert.equal(resultsPathOf("/t/broko-knowledge-live", "20261103100000-abcdef").replace(/\\/g, "/"), "/t/broko-knowledge-live/20261103100000-abcdef.results.jsonl");
    assert.match(SCRIPT, /openResultsLog\(join\(tmpdir\(\), "broko-knowledge-live"\), newRunId\(\)\)/);
    assert.match(SCRIPT, /const dir = join\(tmpdir\(\), "broko-knowledge-live"\)/, "the manifest folder is the same one");
  });
});

describe("F1: the log file is created exclusively", () => {
  it("creates a new file with the start line, and a log that was never created writes nothing", () => {
    const m = memory(); const log = open(m);
    assert.deepEqual(m.created, [log.path]);
    const orphan = new ResultsLog("/tmp/never-created.jsonl", "r", m.io, T0);
    orphan.record("B1", "n", "PASS"); orphan.event("script_error"); orphan.finish(PLAN, new Set());
    assert.ok(!m.files.has("/tmp/never-created.jsonl"), "a log that was not created exclusively writes nothing");
  });

  it("on a name collision it takes the next free numbered name and leaves the existing files untouched", () => {
    const first = resultsPathOf(DIR, "20261103100000-abcdef");
    const second = resultsPathOf(DIR, "20261103100000-abcdef-2");
    const m = memory([first, second]);
    const log = open(m);
    assert.equal(log.path, resultsPathOf(DIR, "20261103100000-abcdef-3"));
    log.record("A1", "target", "PASS");
    assert.equal(m.text(first), "FOREIGN CONTENT\n");
    assert.equal(m.text(second), "FOREIGN CONTENT\n");
    assert.equal(m.lines(log.path)[0].runId, "20261103100000-abcdef-3");
    assert.equal(m.lines(log.path).filter((x) => x.type === "check").length, 1);
  });

  it("gives up safely after 20 collisions: nothing is written, the problem is reported once, and the run is unaffected", () => {
    const paths = ["20261103100000-abcdef", ...Array.from({ length: 19 }, (_, i) => `20261103100000-abcdef-${i + 2}`)].map((id) => resultsPathOf(DIR, id));
    const m = memory(paths); const problems: string[] = [];
    const log = open(m, undefined, problems);
    assert.doesNotThrow(() => { log.record("A1", "n", "PASS"); log.finish(PLAN, new Set()); });
    assert.equal(log.broken, "EEXIST");
    assert.equal(problems.length, 1);
    assert.equal(m.created.length, 0);
    for (const p of paths) assert.equal(m.text(p), "FOREIGN CONTENT\n");
  });

  it("a real disk round trip: two logs with the same id get different files, and a pre-existing file is not modified", () => {
    const dir = mkdtempSync(join(tmpdir(), "broko-results-log-excl-"));
    try {
      const planted = resultsPathOf(dir, "20261103100000-aaaaaa");
      writeFileSync(planted, "do not touch\n");
      const a = openResultsLog(dir, "20261103100000-aaaaaa", undefined, T0);
      const b = openResultsLog(dir, "20261103100000-aaaaaa", undefined, T0);
      a.record("A1", "x", "PASS"); b.record("A1", "x", "PASS");
      assert.notEqual(a.path, b.path); assert.notEqual(a.path, planted);
      assert.equal(readFileSync(planted, "utf8"), "do not touch\n");
      assert.equal(readdirSync(dir).length, 3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the real writer uses the exclusive flag", () => {
    const lib = readFileSync(new URL("./live/lib/results-log.ts", import.meta.url), "utf8");
    assert.match(lib, /flag: "wx"/);
  });
});

describe("F2: the A6 check name is a fixed literal", () => {
  it("the logged name has no count and no environment value; the message goes to the (code-only) detail", () => {
    assert.match(code, /check\("A6", "presence check: only the two test accounts exist, or the exact extra count is acknowledged", presence\.ok, presence\.message\);/);
    assert.ok(!/check\("A6", presence\.message/.test(code));
  });
  it("every check and blocked name in the script is a plain string literal", () => {
    const calls = [...code.matchAll(/\b(?:check|blocked)\("([A-G]\d+)", (.)/g)];
    assert.ok(calls.length >= 50);
    for (const m of calls) assert.equal(m[2], '"', `${m[1]} has a non-literal name`);
  });
  it("a refused presence check logs its codes only, even with a long message", () => {
    const m = memory(); const log = open(m);
    log.record("A6", "presence check: only the two test accounts exist, or the exact extra count is acknowledged", "FAIL", "1 other account(s) exist and could see the synthetic approved items; refusing. To proceed knowingly, set KNOWLEDGE_LIVE_ALLOW_OTHER_USERS=1");
    const line = m.lines(log.path).at(-1)!;
    assert.deepEqual(line.codes, []);
    assert.ok(!m.text(log.path).includes("KNOWLEDGE_LIVE_ALLOW_OTHER_USERS"));
    assert.ok(!m.text(log.path).includes("refusing"));
  });
});

describe("F3: strict diagnostic codes", () => {
  it("rejects the arbitrary five-character tokens from the review", () => {
    assert.deepEqual(safeCodes("PHONE: 555-0100; 12345: x; ABCDE: y; 99ZZZ: z; PROJ1: q"), []);
    for (const t of ["PHONE", "12345", "99ZZZ", "PROJ1", "ABCDE"]) assert.deepEqual(safeCodes(`${t}: anything`), [], t);
  });
  it("keeps legitimate SQLSTATE and PostgREST codes", () => {
    for (const c of ["42501", "23514", "23503", "22023", "22001", "55000", "54000", "P0002", "PGRST202", "PGRST116", "XX000"]) assert.deepEqual(safeCodes(`${c}: text`), [c], c);
    assert.deepEqual(safeCodes("42501: x; 23514: y; PGRST202: z; P0002: w"), ["42501", "23514", "PGRST202", "P0002"]);
  });
  it("takes a code only at the start of a segment, after at most one allowlisted label", () => {
    assert.deepEqual(safeCodes("admin P0002: a; member 42501: b"), ["P0002", "42501"]);
    assert.deepEqual(safeCodes("approve 55000: a; matching 23514: b; control 23514: c; real 23514: d"), ["55000", "23514"]);
    assert.deepEqual(safeCodes("stored 42501: a"), [], "an unknown label is not accepted");
    assert.deepEqual(safeCodes("the call failed with 42501: denied"), [], "a code in the middle of text is not accepted");
    assert.deepEqual(safeCodes("detail 42501 and 23514: x"), []);
    assert.deepEqual(safeCodes("42501 denied"), [], "a code needs its colon");
  });
  it("text after a valid code cannot add codes", () => {
    assert.deepEqual(safeCodes(`42501: ${SECRETS[1]} PHONE: 555 12345: z`), ["42501"]);
    assert.deepEqual(safeCodes(`42501: ${SECRETS[6]}; PROJ1: x`), ["42501"]);
  });
  it("bounded, and empty for nothing", () => {
    assert.deepEqual(safeCodes(undefined), []);
    assert.deepEqual(safeCodes(""), []);
    assert.deepEqual(safeCodes("a".repeat(5000)), []);
    assert.ok(safeCodes(Array.from({ length: 40 }, (_, i) => `${String(40000 + i)}: x`).join("; ")).length <= 12);
  });
});

describe("F4: the start event names the intended target", () => {
  it("uses intended_target, and never a field that implies the guard passed", () => {
    const m = memory(); const log = open(m);
    const start = m.lines(log.path)[0];
    assert.deepEqual(Object.keys(start).sort(), ["intended_target", "runId", "startedAt", "type"]);
    assert.equal(start.intended_target, "broko-dev");
    const lib = readFileSync(new URL("./live/lib/results-log.ts", import.meta.url), "utf8");
    assert.ok(!/\btarget: "broko-dev"/.test(lib));
  });
  it("a refused run (guard fails) records A1 FAIL and NOT_RUN for the rest, with the same intended target", () => {
    const m = memory(); const log = open(m);
    log.record("A1", "target guard", "FAIL", "URL project ref is not the approved development project");
    log.event("run_refused_or_aborted");
    log.finish(PLAN, new Set(["A1"]));
    const l = m.lines(log.path);
    assert.equal(l[0].intended_target, "broko-dev");
    assert.equal(l.filter((x) => x.status === "NOT_RUN").length, PLAN.length - 1);
    assert.ok(!l.some((x) => x.status === "PASS"));
  });
});

describe("results log: nothing sensitive can enter it", () => {
  it("a failure summary contributes its codes only, never its text", () => {
    const m = memory(); const log = open(m);
    for (const s of SECRETS) log.record("B3", "member cannot forge an author", "FAIL", `42501: ${s}; P0002: ${s}; 55000: ${s}`);
    const all = m.text(log.path);
    for (const s of SECRETS) assert.ok(!all.includes(s), `leaked: ${s.slice(0, 12)}`);
    assert.deepEqual(m.lines(log.path).filter((x) => x.type === "check").map((x) => x.codes), SECRETS.map(() => ["42501", "P0002", "55000"]));
  });

  it("a detail with no code yields an empty code list and no text at all", () => {
    const m = memory(); const log = open(m);
    log.record("F2", "no item is open", "FAIL", `3 unexpected rows for ${SECRETS[1]}`);
    assert.deepEqual(m.lines(log.path).at(-1)!.codes, []);
    assert.ok(!m.text(log.path).includes("example.com"));
  });

  it("labels are printable ASCII and bounded; events accept only a fixed lowercase vocabulary", () => {
    assert.equal(safeLabel(["ok", String.fromCharCode(0), String.fromCharCode(0x202e), String.fromCharCode(10), String.fromCharCode(0x200b), "name"].join("")), "ok????name");
    assert.equal(safeLabel("x".repeat(500), 200).length, 200);
    const m = memory(); const log = open(m);
    log.event("run_stopped_unexpected_error");
    log.event(`Error: ${SECRETS[2]}`);
    const ev = m.lines(log.path).filter((x) => x.type === "event").map((x) => x.label);
    assert.deepEqual(ev, ["run_stopped_unexpected_error", "invalid_label"]);
    assert.ok(!m.text(log.path).includes(SECRETS[2]));
  });

  it("the script passes the log only literals, the check's own name and the failure summary; it never logs an exception", () => {
    const calls = [...code.matchAll(/rlog\??\.(\w+)\(([^;]*)\)/g)].map((m) => [m[1], m[2]]);
    assert.ok(calls.length >= 5 && calls.length <= 12, `unexpected number of log calls: ${calls.length}`);
    for (const [fn, args] of calls) {
      assert.ok(["record", "event", "link", "finish", "path"].includes(fn), `unexpected log method ${fn}`);
      assert.ok(!/\.message|String\(e|process\.env|anonKey|PASSWORD|EMAIL/.test(args), `log call may carry a raw message or credential: ${fn}(${args.slice(0, 60)})`);
    }
    assert.equal([...code.matchAll(/\bblocked\("/g)].length, [...code.matchAll(/blocked\("[A-G]\d+", "[^"]*", "/g)].length, "every blocked() reason is a literal");
  });
});

describe("results log: incremental, and never masks a test result", () => {
  it("each completed check is already on disk when the process stops (no finish, no summary)", () => {
    const dir = mkdtempSync(join(tmpdir(), "broko-results-log-test-"));
    try {
      const log = openResultsLog(dir, "20261103100000-aaaaaa", undefined, T0);
      log.record("A1", "target is exactly broko-dev", "PASS");
      log.record("A2", "separate admin and member sessions", "PASS");
      log.record("A3", "tables reachable", "FAIL", "P0002: x");
      assert.ok(existsSync(log.path));
      const rows = readFileSync(log.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.deepEqual(rows.map((r) => r.type), ["start", "check", "check", "check"]);
      assert.deepEqual(rows.filter((r) => r.type === "check").map((r) => r.status), ["PASS", "PASS", "FAIL"]);
      assert.ok(!rows.some((r) => r.type === "summary"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("every record is written the moment it is recorded", () => {
    const m = memory(); const log = open(m);
    for (let i = 1; i <= 3; i++) { log.record(`B${i}`, "n", "PASS"); assert.equal(m.lines(log.path).filter((x) => x.type === "check").length, i); }
  });

  it("a writer that fails is reported once, by code only, and never throws or changes the outcome", () => {
    const problems: string[] = []; let appends = 0;
    const io: LogIo = { mkdir: () => undefined, create: () => undefined, append: () => { appends++; throw Object.assign(new Error(`EACCES: permission denied, open '/secret/${SECRETS[0]}'`), { code: "EACCES" }); } };
    const log = openResultsLog(DIR, "r", io, T0, (m) => problems.push(m));
    assert.doesNotThrow(() => { log.record("B1", "n", "FAIL", "42501: x"); log.record("B2", "n", "PASS"); log.event("script_error"); log.finish(PLAN, new Set()); });
    assert.equal(problems.length, 1);
    assert.equal(appends, 1, "after the first failure the log stops writing");
    assert.match(problems[0], /EACCES/);
    assert.ok(!problems[0].includes(SECRETS[0]) && !problems[0].includes("/secret"));
    assert.equal(log.broken, "EACCES");
  });

  it("a folder or file that cannot be created does not stop the run", () => {
    const io: LogIo = { mkdir: () => { throw new Error("nope"); }, create: () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); }, append: () => { throw new Error("never reached"); } };
    const problems: string[] = [];
    const log = openResultsLog("/does/not/exist", "r", io, T0, (m) => problems.push(m));
    assert.doesNotThrow(() => { log.record("A1", "n", "PASS"); log.finish(PLAN, new Set()); });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ENOENT/);
  });

  it("an error object without a safe code is reported as a generic code", () => {
    const problems: string[] = [];
    const io: LogIo = { mkdir: () => undefined, create: () => { throw new Error(`${SECRETS[1]} failed`); }, append: () => undefined };
    openResultsLog(DIR, "r", io, T0, (m) => problems.push(m));
    assert.match(problems[0], /WRITE_ERROR/);
    assert.ok(!problems[0].includes("example.com"));
  });
});

describe("results log: wiring in the live script leaves its behaviour alone", () => {
  it("records inside report(), finishes in a finally block, and rethrows so exit codes are unchanged", () => {
    assert.match(code, /rlog\?\.record\(/);
    assert.match(code, /try \{ await live\(\); \} catch \(e\) \{ rlog\?\.event\([^)]*\); throw e; \} finally \{ rlog\?\.finish\(PLAN, new Set\(reported\.keys\(\)\)\); \}\s*return summary\(\);/);
  });
  it("adds no environment variable, no database call and no new import besides the log module", () => {
    assert.match(code, /import \{ openResultsLog, type ResultsLog \} from "\.\/lib\/results-log";/);
    const lib = readFileSync(new URL("./live/lib/results-log.ts", import.meta.url), "utf8");
    assert.ok(!/process\.env|supabase|createClient|fetch\(/i.test(lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
    assert.deepEqual([...lib.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]), ["node:fs", "node:path"]);
  });
  it("opens the log before the target guard so even a refused run leaves a record", () => {
    const live = code.indexOf("async function live");
    assert.ok(code.indexOf("rlog = openResultsLog") > live && code.indexOf("rlog = openResultsLog") < code.indexOf("const problems = targetProblems", live));
  });
});
