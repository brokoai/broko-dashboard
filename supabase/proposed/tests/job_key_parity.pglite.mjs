// LOCAL ONLY. Never connects to any remote database. Proves that the SQL job key (0004 ai_enqueue_job) is byte-for-byte the text the
// application builds: jobKey(ref) = JSON.stringify([provider, mailbox_ref, source_message_id]) (src/lib/ai-brain/jobs.ts), and that the
// SQL correlation_id equals the application's jobId (first 12 hex characters of SHA-256 of that text). If the two ever drift, a
// database-backed repository would show a job id that the audit events do not carry.
//
//   npm install --no-save @electric-sql/pglite
//   node supabase/proposed/tests/job_key_parity.pglite.mjs
//
// Single session, synthetic strings only. It says nothing about concurrency.
import { createEnv } from "./lib/pglite_env.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const CR = String.fromCharCode(13);
const root = fileURLToPath(new URL("../../", import.meta.url));
const FILES = ["migrations/0001_init.sql", "proposed/0002_hardening.proposed.sql", "proposed/0003_ai_brain.proposed.sql", "proposed/0004_ai_jobs.proposed.sql"].map((f) => `${root}${f}`);
void CR;

const VECTORS = [
  ["synthetic", "box", "msg-1"],
  ["synthetic", "a|b", "c"],
  ["synthetic", "a", "b|c"],
  ["gmail", "", "x"],
  ["synthetic", 'q"uote', "back\\slash"],
  ["synthetic", "tab\there", "new\nline"],
  ["synthetic", "carriage\rreturn", "form\fbackspace\b"],
  ["synthetic", "ctrl\u0001\u001f", "del\u007f"],
  ["synthetic", "café üñ", "日本語"],
  ["synthetic", "emoji 😀", "slash/and/ sep "],
  ["synthetic", "[\"already\",\"json\"]", "{\"k\":1}"],
  ["synthetic", "m".repeat(200), "s".repeat(512)],
  ["microsoft_graph", "mailbox@example.test", "AAMkAD=="],
];

const env = await createEnv({ applyAs: "cli_login_postgres" });
if (!(await env.apply(FILES, { cliSetsRole: false }))) { console.log("FAIL  migrations did not apply"); process.exit(1); }
let bad = 0;
for (const [provider, mailbox, source] of VECTORS) {
  const expectKey = JSON.stringify([provider, mailbox, source]);
  const expectId = createHash("sha256").update(expectKey, "utf8").digest("hex").slice(0, 12);
  const label = JSON.stringify([provider, mailbox.slice(0, 20), source.slice(0, 20)]);
  try {
    await env.db.exec("set role service_role");
    const r = await env.db.query("select public.ai_enqueue_job($1, $2, $3) as id", [provider, mailbox, source]);
    await env.db.exec("reset role");
    const row = (await env.db.query("select job_key, correlation_id from public.ai_jobs where correlation_id = $1", [r.rows[0].id])).rows[0];
    // ai_enqueue_job returns the PUBLIC job id: it must equal the application's jobId, not a database uuid.
    const ok = row?.job_key === expectKey && row.correlation_id === expectId && r.rows[0].id === expectId;
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  sql=${row.job_key} app=${expectKey} / ${row.correlation_id} vs ${expectId}`}`);
  } catch (e) { bad++; await env.db.exec("reset role").catch(() => {}); console.log(`FAIL  ${label}: ${String(e.message).split("\n")[0]}`); }
}
const distinct = (await env.db.query("select count(distinct job_key) n, count(*) t from public.ai_jobs")).rows[0];
if (Number(distinct.n) !== VECTORS.length) { bad++; console.log(`FAIL  expected ${VECTORS.length} distinct jobs, found ${distinct.n}`); }
console.log(bad === 0 ? `\nALL OK: ${VECTORS.length} vectors; SQL job_key and correlation_id equal the application's jobKey and jobId` : `\n${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
