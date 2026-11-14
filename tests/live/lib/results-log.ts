/**
 * Results log for tests/live/knowledge-live-dev.script.ts: one JSON line per event, appended as each check finishes, in the same temporary
 * folder as the run manifest. Pure and injectable (no network, no environment, no database), unit-tested by tests/knowledge-live-results-log.test.ts.
 *
 * SAFETY BY CONSTRUCTION: a line is built only from (a) the planned check id, (b) the check name, which is a literal in the script, (c) the status,
 * (d) SQLSTATE-shaped codes extracted from an error summary, and (e) for BLOCKED, the literal reason. Free text from a failure (database
 * messages, exception messages, payloads, emails, keys) is never copied: only the extracted codes are. Every writer failure is swallowed and
 * reported once as a code, so logging can never change a test result or the exit code.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LogStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export interface LogIo {
  mkdir(dir: string): void;
  /** Creates the file and writes `data`; MUST fail with code EEXIST if the file already exists (exclusive creation). */
  create(path: string, data: string): void;
  append(path: string, data: string): void;
}
export const realIo: LogIo = {
  mkdir: (d) => void mkdirSync(d, { recursive: true }),
  create: (p, d) => writeFileSync(p, d, { encoding: "utf8", flag: "wx" }),
  append: (p, d) => appendFileSync(p, d, "utf8"),
};

/**
 * SQLSTATE classes PostgreSQL defines, plus PL/pgSQL (P0) and implementation (XX). A code is accepted only when its class is on this list, so arbitrary
 * five-character tokens ("PHONE", "12345", "99ZZZ", "PROJ1") are rejected. PostgREST codes are PGRST followed by digits.
 */
const SQLSTATE_CLASSES = new Set(["00", "01", "02", "03", "08", "09", "0A", "0B", "0F", "0L", "0P", "0Z", "20", "21", "22", "23", "24", "25", "26", "27", "28", "2B", "2D", "2F", "34", "38", "39", "3B", "3D", "3F", "40", "42", "44", "53", "54", "55", "57", "58", "72", "F0", "HV", "P0", "XX"]);
/** Words the script puts in front of a `why()` result ("admin 42501: ...", "approve P0002: ..."). Nothing else may precede a code. */
const SEGMENT_LABELS = new Set(["admin", "member", "approve", "matching", "control", "real"]);
const SEGMENT_RE = /^(?:([a-z]+) )?([0-9A-Z]{5}|PGRST[0-9]{3,4}):/;

/**
 * Codes from a failure summary built by the script as segments joined with "; ", each `[label ]CODE: message`. A code counts only at the START of
 * a segment, after at most one allowlisted label, and only if it is a real SQLSTATE class or a PostgREST code. The message is never read.
 */
export const safeCodes = (detail: string | undefined): string[] => {
  const out: string[] = [];
  for (const seg of String(detail ?? "").split("; ")) {
    const m = SEGMENT_RE.exec(seg);
    if (!m) continue;
    if (m[1] !== undefined && !SEGMENT_LABELS.has(m[1])) continue;
    const code = m[2];
    if (code.startsWith("PGRST") || SQLSTATE_CLASSES.has(code.slice(0, 2))) out.push(code);
  }
  return [...new Set(out)].slice(0, 12);
};

/** Printable ASCII only, bounded length. Names and BLOCKED reasons are literals in the script; this is a second line of defence. */
export const safeLabel = (s: string, max = 200): string => s.replace(/[^ -~]/g, "?").slice(0, max);

const LABEL_RE = /^[a-z][a-z0-9_]{0,59}$/;

export class ResultsLog {
  /** Set after the first failed write; later events are dropped silently. */
  broken: string | null = null;
  private counts: Record<LogStatus, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  private seq = 0;
  private finished = false;

  private begun = false;

  /** Use openResultsLog(): it creates the file exclusively. A log that was not begun writes nothing, so it can never append to someone else's file. */
  constructor(readonly path: string, private readonly runId: string, private readonly io: LogIo = realIo, private readonly now: () => Date = () => new Date(), private readonly onProblem: (m: string) => void = (m) => console.error(m)) {}

  private problem(e: unknown): void {
    const code = String((e as { code?: unknown })?.code ?? "");
    this.broken = /^[A-Z0-9_]{2,16}$/.test(code) ? code : "WRITE_ERROR";
    this.onProblem(`RESULTS LOG: could not write (${this.broken}); test results are unaffected, continue to read the console output.`);
  }

  /** Exclusive creation with the start line. Returns "exists" (and reports nothing) when the file is already there; any other failure breaks the log once. */
  begin(): "ok" | "exists" | "failed" {
    try {
      this.io.create(this.path, `${JSON.stringify({ type: "start", runId: this.runId, startedAt: this.now().toISOString(), intended_target: "broko-dev" })}
`);
      this.begun = true;
      return "ok";
    } catch (e) {
      if ((e as { code?: unknown })?.code === "EEXIST") return "exists";
      this.problem(e);
      return "failed";
    }
  }

  /** Marks the log unusable without touching any file (used when no unique name could be created). */
  abandon(code: string): void { if (!this.broken) this.problem({ code }); }

  private write(obj: Record<string, unknown>): void {
    if (this.broken || !this.begun) return;
    try { this.io.append(this.path, `${JSON.stringify(obj)}
`); } catch (e) { this.problem(e); }
  }

  /** One check outcome. `detail` is the same summary string the console shows; only codes are taken from it. A BLOCKED reason is a literal. */
  record(id: string, name: string, status: Exclude<LogStatus, "NOT_RUN">, detail?: string, reason?: string): void {
    this.counts[status]++;
    const line: Record<string, unknown> = { type: "check", seq: ++this.seq, at: this.now().toISOString(), id: safeLabel(id, 8), name: safeLabel(name, 200), status };
    if (status === "FAIL") line.codes = safeCodes(detail);
    if (status === "BLOCKED" && reason) line.reason = safeLabel(reason, 300);
    this.write(line);
  }

  /** Ties this log to the run's manifest once the run id exists (the id is a timestamp plus random hex; it identifies no person). */
  link(manifestRunId: string): void {
    this.write({ type: "run", at: this.now().toISOString(), runId: safeLabel(manifestRunId, 32), manifest: `${safeLabel(manifestRunId, 32)}.json` });
  }

  /** A fixed-vocabulary event (for example "run_stopped_unexpected_error"). The label must match a lowercase identifier: no free text. */
  event(label: string): void {
    this.write({ type: "event", at: this.now().toISOString(), label: LABEL_RE.test(label) ? label : "invalid_label" });
  }

  /** Writes NOT_RUN for every planned id that was never reported, then the summary. Safe to call more than once; only the first call writes. */
  finish(planned: readonly { id: string; text: string }[], reportedIds: ReadonlySet<string>): void {
    if (this.finished) return;
    this.finished = true;
    const notRun = planned.filter((s) => !reportedIds.has(s.id));
    for (const s of notRun) this.write({ type: "check", seq: ++this.seq, at: this.now().toISOString(), id: safeLabel(s.id, 8), name: safeLabel(s.text, 200), status: "NOT_RUN" });
    this.counts.NOT_RUN = notRun.length;
    this.write({ type: "summary", at: this.now().toISOString(), passed: this.counts.PASS, failed: this.counts.FAIL, blocked: this.counts.BLOCKED, not_run: this.counts.NOT_RUN, not_run_ids: notRun.map((s) => s.id) });
  }
}

export const resultsPathOf = (dir: string, runId: string): string => join(dir, `${runId}.results.jsonl`);

const MAX_NAME_TRIES = 20;
/**
 * Creates the folder and a NEW log file, exclusively (flag "wx"): an existing file is never opened, appended to or overwritten. On a name collision the
 * next numbered name is tried (`<id>`, `<id>-2`, `<id>-3`, ...). Never throws; if no file can be created the returned log writes nothing and says why once.
 */
export function openResultsLog(dir: string, baseId: string, io: LogIo = realIo, now?: () => Date, onProblem?: (m: string) => void): ResultsLog {
  try { io.mkdir(dir); } catch { /* the exclusive create below fails the same way and reports it once */ }
  let last: ResultsLog | null = null;
  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const id = n === 1 ? baseId : `${baseId}-${n}`;
    const log = new ResultsLog(resultsPathOf(dir, id), id, io, now, onProblem);
    const r = log.begin();
    if (r !== "exists") return log;
    last = log;
  }
  last!.abandon("EEXIST");
  return last!;
}
