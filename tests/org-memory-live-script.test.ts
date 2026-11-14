import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { searchWords } from "../src/lib/ai-brain/org-memory/query";
import { createToolAgent, isCoverageStatement } from "../src/lib/ai-brain/chat/tool-agent";
import { createMemoryRateLimiter } from "../src/lib/ai-brain/chat";
import { runBrainTool, standardRegistry, unavailableConnectors } from "../src/lib/ai-brain/assistant";
import { createMemoryOrgStore, type Extractor } from "../src/lib/ai-brain/org-memory";
import { handleIngest } from "../src/lib/org-memory-service";
import type { ToolTransport, ToolTurn } from "../src/lib/ai-brain/model-tool-transport";
import { NOW, admin, fakeRepo } from "./ai-chat-helpers";
import { describeAmbiguity, onlyIfEmpty, sanitizeDiag, signInFailureMessage, stateProblems, type State } from "./live/lib/org-memory-live-plan";

// Local checks for the LIVE organizational-memory script (tests/live/org-memory-supabase.live-dev.script.ts). Nothing here touches a network or a database.
const RUN = "20261111093809-209a82";
const good = (over: Partial<State> = {}): State => ({ runId: RUN, ws: `live-test-${RUN}`, sources: [1, 2, 3].map((n) => `${RUN}-p${n}`), held: ["6f1c2a9e-1b7d-4c1e-9a55-0d3b9a7c1e22"], docs: [], entities: 0, ...over });
const SCRIPT = readFileSync(new URL("./live/org-memory-supabase.live-dev.script.ts", import.meta.url), "utf8");

describe("cleanup is bounded to one run's own synthetic workspace and source ids", () => {
  it("accepts exactly the state a run writes", () => assert.deepEqual(stateProblems(good()), []));
  it("refuses a real-looking workspace, a foreign source id, extra or missing sources, and malformed lock ids", () => {
    assert.notDeepEqual(stateProblems(good({ ws: "default" })), []);
    assert.notDeepEqual(stateProblems(good({ ws: "live-test-20260101000000-aaaaaa" })), [], "a workspace from ANOTHER run is not this run's");
    assert.notDeepEqual(stateProblems(good({ sources: [`${RUN}-p1`, `${RUN}-p2`, "real-notion-page-id"] })), []);
    assert.notDeepEqual(stateProblems(good({ sources: [`${RUN}-p1`, `${RUN}-p2`] })), []);
    assert.notDeepEqual(stateProblems(good({ sources: [`${RUN}-p1`, `${RUN}-p2`, `${RUN}-p3`, "x"] })), []);
    assert.notDeepEqual(stateProblems(good({ sources: [`${RUN}-p3`, `${RUN}-p2`, `${RUN}-p1`] })), [], "order and identity must match exactly");
    assert.notDeepEqual(stateProblems(good({ held: ["not-a-uuid"] })), []);
  });
  it("refuses malformed run ids, missing fields and a state of the wrong shape", () => {
    for (const runId of ["", "live-test", "20261111093809-ZZZZZZ", "../../etc", "20261111093809-209a82-2", "x".repeat(40)]) assert.notDeepEqual(stateProblems({ ...good(), runId, ws: `live-test-${runId}` }), [], runId);
    assert.notDeepEqual(stateProblems({}), []);
    assert.notDeepEqual(stateProblems({ runId: RUN }), []);
  });
});

describe("the Claude checks need an unambiguous, known-empty background", () => {
  it("runs only when both counts are known and zero; any real document, other-run document or unknown count skips", () => {
    assert.equal(onlyIfEmpty({ real: 0, otherSynthetic: 0 }), true);
    for (const a of [{ real: 1, otherSynthetic: 0 }, { real: 0, otherSynthetic: 2 }, { real: null, otherSynthetic: 0 }, { real: 0, otherSynthetic: null }, { real: null, otherSynthetic: null }]) assert.equal(onlyIfEmpty(a), false);
    assert.match(describeAmbiguity({ real: null, otherSynthetic: 3 }), /unknown.*=3/);
  });
});

describe("static properties of the live script (it cannot run here, so its source is checked)", () => {
  it("uses the publishable key only: no service-role key is read, named or accepted", () => {
    assert.ok(!/SUPABASE_SERVICE|SERVICE_ROLE_KEY/i.test(SCRIPT));
  });
  it("B6 reads the run by the id it recorded, never the latest run of the table", () => {
    assert.match(SCRIPT, /\.eq\("id", myRun\)/);
    assert.ok(!/order\("started_at"/.test(SCRIPT));
  });
  it("cleanup archives only the sources taken from the validated state, K1-K4 are skipped (not passed) when the preflight is not empty, and signal handlers are installed", () => {
    assert.match(SCRIPT, /for \(const src of s\.sources\)/);
    assert.match(SCRIPT, /if \(onlyIfEmpty\(beforeClaude\)\) await claude/);
    assert.match(SCRIPT, /skipped\(id, `INCONCLUSIVE/);
    for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) assert.ok(SCRIPT.includes(`"${sig}"`), sig);
    assert.match(SCRIPT, /--cleanup/);
  });
  it("no password, key or email variable value is ever printed", () => {
    assert.ok(!/console\.(log|error)\([^)]*process\.env\.PRECON_LIVE_(ADMIN|MEMBER)_(EMAIL|PASSWORD)/.test(SCRIPT));
    assert.ok(!/console\.(log|error)\([^)]*process\.env\.PRECON_LIVE_ANON_KEY/.test(SCRIPT));
  });
});

describe("Claude checks K1-K3: fixtures and failure diagnostics", () => {
  const kBlock = SCRIPT.slice(SCRIPT.indexOf("async function claude("), SCRIPT.indexOf("// ---- L") > 0 ? SCRIPT.indexOf("async function knowledge(") : undefined);
  it("K1/K2 ask about a record that survives as PROPOSED (the warehouse slot), never about the Pune decision that step I4 rejects", () => {
    assert.match(SCRIPT, /await A\.reader\.review\(decision\.id, "reject"/, "the decision is rejected earlier in the run, on purpose");
    const q1 = /const q1 = flat\(await ask\(admin, "admin", "([^"]+)"\)\)/.exec(kBlock);
    assert.ok(q1, "K1/K2 question found");
    assert.match(q1![1]!, /warehouse slot/i);
    assert.doesNotMatch(q1![1]!, /launch decision|Pune/i);
    assert.doesNotMatch(SCRIPT, /review\([^)]*warehouse/i, "the warehouse record is never reviewed before K, so it is still proposed");
  });
  it("a failing K check prints sanitized diagnostics (shape plus a redacted excerpt)", () => {
    assert.match(kBlock, /diag\(q1\)/);
    assert.match(kBlock, /q3_names_owner=/);
    assert.match(kBlock, /invented_number=/);
  });
  it("the invented-number test ignores the run id that appears in page titles", () => {
    assert.match(kBlock, /stripRun/);
  });
  it("sanitizeDiag removes urls, emails, tokens, ids and long numbers, collapses whitespace and bounds the length", () => {
    const dirty = "See https://www.notion.so/abc123 and mail ada@example.test, key sk-ant-api03-ABCDEFGHIJ, jwt eyJhbGciOiJIUzI1NiJ9.payload.sig, id 6f1c2a9e-1b7d-4c1e-9a55-0d3b9a7c1e22, run 20261111162756-337202,\n\n year 2026.";
    const clean = sanitizeDiag(dirty, 400);
    for (const secret of ["notion.so", "ada@", "sk-ant", "eyJhbGci", "6f1c2a9e", "20261111162756"]) assert.ok(!clean.includes(secret), secret);
    assert.match(clean, /<url>/); assert.match(clean, /<email>/); assert.match(clean, /<token>/); assert.match(clean, /<id>/); assert.match(clean, /<num>/);
    assert.ok(!/\s{2,}/.test(clean));
    assert.match(clean, /year 2026/, "short numbers are kept");
    assert.equal(sanitizeDiag("x".repeat(1000)).length, 220);
  });
  it("the L2 safety guard is unchanged: it still refuses while another account exists unless the owner sets the override", () => {
    assert.match(SCRIPT, /KNOWLEDGE_LIVE_ALLOW_OTHER_USERS/);
    assert.match(SCRIPT, /approval is not exercised/);
  });
});

describe("a failed sign-in reports only the variable, the HTTP status and the Supabase error code", () => {
  it("prints status and code for the usual provider failures", () => {
    assert.equal(signInFailureMessage("PRECON_LIVE_ADMIN_EMAIL", { status: 400, code: "invalid_credentials" }), "Sign-in failed for PRECON_LIVE_ADMIN_EMAIL: 400 invalid_credentials");
    assert.equal(signInFailureMessage("PRECON_LIVE_ADMIN_EMAIL", { status: 400, code: "email_not_confirmed" }), "Sign-in failed for PRECON_LIVE_ADMIN_EMAIL: 400 email_not_confirmed");
    assert.equal(signInFailureMessage("PRECON_LIVE_MEMBER_EMAIL", { status: 429, code: "over_request_rate_limit" }), "Sign-in failed for PRECON_LIVE_MEMBER_EMAIL: 429 over_request_rate_limit");
  });
  it("prints ? for a missing or unexpected status or code, and never the provider message or anything secret-shaped", () => {
    assert.equal(signInFailureMessage("PRECON_LIVE_ADMIN_EMAIL", {}), "Sign-in failed for PRECON_LIVE_ADMIN_EMAIL: ? ?");
    const hostile = { status: "400 admin@example.com", code: "Invalid login credentials for admin@example.com password hunter2 eyJhbGciOiJIUzI1NiJ9.abc.def sb_publishable_abcdefghij", message: "Invalid login credentials hunter2" };
    const out = signInFailureMessage("PRECON_LIVE_ADMIN_EMAIL", hostile);
    assert.equal(out, "Sign-in failed for PRECON_LIVE_ADMIN_EMAIL: ? ?");
    for (const s of ["admin@example.com", "hunter2", "eyJ", "sb_publishable", "Invalid login"]) assert.ok(!out.includes(s), s);
    assert.equal(signInFailureMessage("K", { status: 9999, code: "x".repeat(200) }), "Sign-in failed for K: ? ?");
  });
  it("the script uses the helper, never echoes the provider message, and the success path is unchanged", () => {
    assert.match(SCRIPT, /if \(error\) throw new Abort\(signInFailureMessage\(emailKey, error\)\)/);
    const body = SCRIPT.slice(SCRIPT.indexOf("async function signIn("), SCRIPT.indexOf("function guard()"));
    assert.ok(!/error\.message|\$\{error\}/.test(body), "the provider message must not be used");
    assert.match(body, /signInWithPassword\(\{ email: need\(emailKey\), password: need\(passKey\) \}\)/);
    assert.match(body, /No user after sign-in/);
    assert.match(body, /No profile row for the signed-in user/);
    assert.match(body, /return \{ db, profile: toProfile\(row as ProfileRow, u\.user\.email\) \}/);
  });
});

describe("K diagnostics trace the tool path without changing any check", () => {
  it("records the tool, a redacted short query, the record count and the agent's answer or decline code", () => {
    assert.match(SCRIPT, /describeToolInput\(input\)/);
    assert.match(SCRIPT, /agent=declined:\$\{o\.reason\} \(tool calls \$\{o\.stats\.calls\}\)/);
    assert.match(SCRIPT, /toolAgent: spy/);
  });
  // The trace helpers are pure; the test evaluates exactly the block the script contains (the script itself cannot be imported: it runs main()).
  const helpers = (() => {
    const block = SCRIPT.slice(SCRIPT.indexOf("// TRACE-HELPERS-BEGIN"), SCRIPT.indexOf("// TRACE-HELPERS-END"));
    const wrapStart = SCRIPT.indexOf("function loggingTransport");
    const wrap = SCRIPT.slice(wrapStart, SCRIPT.indexOf("\n}\n", wrapStart) + 3);
    const js = ts.transpileModule(`${block}\n${wrap}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function("sanitizeDiag", "searchWords", "isCoverageStatement", `${js}; return { describeToolInput, describeAdapterCall, deliveredIds, describeSubmission, describeRound, loggingTransport, queryWordsOf, recordTermsOf, detailLine };`)(sanitizeDiag, searchWords, isCoverageStatement) as {
      deliveredIds: (m: unknown) => string[];
      detailLine: (id: string, status: string, detail: string | undefined, at: string) => string | null;
      queryWordsOf: (m: unknown) => string[];
      recordTermsOf: (m: unknown) => string[];
      describeSubmission: (i: unknown, d: ReadonlySet<string>, ctx?: { queryWords: readonly string[]; recordTerms: readonly string[] }) => string;
      describeRound: (round: number, m: unknown, b: { type: string; name?: string; input?: unknown }[], forced: boolean) => string;
      loggingTransport: (inner: ToolTransport, sink: string[]) => ToolTransport;
      describeToolInput: (i: unknown) => string;
      describeAdapterCall: (q: { entity_type?: string; query?: string; limit: number; source_doc_id?: string; include_rejected?: boolean }, o: number | unknown) => string;
    };
  })();
  it("the tool-level trace shows query, entity_type and limit exactly as the model passed them (and a missing one as '-')", () => {
    assert.equal(helpers.describeToolInput({ query: "warehouse", entity_type: "action_item", limit: 5 }), "input{query=warehouse, entity_type=action_item, limit=5}");
    assert.equal(helpers.describeToolInput({ query: "warehouse" }), "input{query=warehouse, entity_type=-, limit=-}");
    assert.equal(helpers.describeToolInput({}), "input{query=-, entity_type=-, limit=-}");
    assert.equal(helpers.describeToolInput(null), "input{query=-, entity_type=-, limit=-}");
    assert.match(helpers.describeToolInput({ query: "x1", id: "abc" }), /other_keys=\[id\]/);
  });
  it("the adapter-level trace shows the arguments received, the filter shape and the result count; a throw shows no error text", () => {
    const t = helpers.describeAdapterCall({ query: "warehouse", entity_type: "commitment", limit: 10 }, 0);
    assert.match(t, /query_words=\[warehouse\]/);
    assert.match(t, /entity_type=commitment, limit=10, source_doc=no, include_rejected=false/);
    assert.match(t, /doc\.archived=eq\.false; entity_type=eq\.commitment; source_doc_id=-; review_status=neq\.rejected; or=ilike\(name,description,owner,team\)x1word\(s\); order=extracted_at\.desc,id\.asc; read=single,limit 10/);
    assert.match(t, /-> 0 row\(s\)$/);
    const none = helpers.describeAdapterCall({ source_doc_id: "11111111-1111-1111-1111-111111111111", include_rejected: true, limit: 10 }, 1);
    assert.match(none, /entity_type=-/);
    assert.match(none, /source_doc_id=eq\.<id>; review_status=any; or=-/);
    assert.doesNotMatch(none, /1111/, "ids are never printed");
    assert.match(helpers.describeAdapterCall({ query: "halcyon warehouse slot", limit: 10 }, 3), /x3word\(s\).*read=paged,200\/page.*-> 3 row\(s\)/);
    assert.match(helpers.describeAdapterCall({ query: "warehouse", limit: 10 }, new Error("secret source text")), /-> threw \(error text withheld\)$/);
    assert.doesNotMatch(helpers.describeAdapterCall({ query: "warehouse", limit: 10 }, new Error("secret source text")), /secret/);
  });
  // ---- final-answer diagnostics: what the model submitted (content-free), and why finalizeItems would decline it
  const fixtureTurnResult = (n: number) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "<<<DATA x>>>\n{\"records\":[{\"cites\":[\"M1.S2\"]}],\"segments\":[\"M1.S2 (text) Dana from the Operations team will confirm the warehouse slot.\"],\"shown\":1}\n<<<END x>>>" }] });
  it("deliveredIds lists only segments that were really delivered (the 'M1.S2 (kind)' lines), never ids merely mentioned in a record's cites or in the model's own turn", () => {
    const messages = [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "tool_use", id: "a", name: "submit_answer", input: { items: [{ text: "x", cites: ["M1.S9"] }] } }] }, fixtureTurnResult(1)];
    assert.deepEqual(helpers.deliveredIds(messages), ["M1.S2"]);
    assert.deepEqual(helpers.deliveredIds([{ role: "user", content: "nothing here" }]), []);
  });
  const D = new Set(["M1.S2"]);
  const one = (text: string, cites: string[]) => ({ text, cites });
  const cited = "Dana from the Operations team will confirm the warehouse slot.";
  it("describeSubmission names the branch finalizeItems would take, from the submission alone, and never prints the text", () => {
    const branch = (items: unknown[]) => /predicted_branch=(.*)$/.exec(helpers.describeSubmission({ items }, D))![1]!;
    assert.match(branch([one(cited, ["M1.S2"])]), /^none/);
    assert.match(branch([one(cited, ["M1.S2"]), one("This record is proposed and has not been reviewed yet.", [])]), /^factual_item_without_cite \(item 2\)/);
    assert.match(branch([one(`${cited} It is a proposed record, not yet reviewed.`, ["M1.S2"])]), /^several_factual_sentences_in_one_item \(item 1\)/);
    assert.match(branch([one(cited, ["M1.S1"])]), /^invented_or_undelivered_cite \(item 1\)/);
    assert.match(branch([one(cited, ["S2"])]), /^invented_or_undelivered_cite/);
    assert.match(branch([one("The stored notes do not mention Halcyon.", []), one(cited, ["M1.S2"])]), /^none/, "a coverage statement needs no cite");
    assert.match(branch([one("No stored record links this slot to Halcyon.", [])]), /^factual_item_without_cite/);
    assert.match(branch([one(`${cited} [M1.S2]`, ["M1.S2"])]), /^marker_in_text/);
    assert.match(helpers.describeSubmission({ nope: 1 }, D), /not an array/);
    const t = helpers.describeSubmission({ items: [one(cited, ["M1.S2", "M1.S1", "S2"])] }, D);
    assert.match(t, /cites=\[M1\.S2:delivered,M1\.S1:NOT_DELIVERED,S2:INVALID_FORMAT\]/);
    assert.match(t, /factual_sentences=1/);
    assert.doesNotMatch(t, /Dana|warehouse|Operations/, "no submitted text, no evidence text");
  });
  // ---- Step 0: category flags for an item rejected for a missing citation (content-free)
  const CTX = { queryWords: ["halcyon", "warehouse"], recordTerms: ["Dana", "Operations"] };
  const flagsFor = (text: string, ctx = CTX) => {
    const line = helpers.describeSubmission({ items: [one(cited, ["M1.S2"]), one(text, [])] }, D, ctx);
    return /uncited_item\{[^}]*\}/.exec(line)?.[0] ?? "";
  };
  const flag = (f: string, name: string) => new RegExp(`${name}=(true|false)`).exec(f)![1] === "true";
  it("flags each category on its own: bullet, negation, query term, review status, owner/team, due date", () => {
    assert.ok(flag(flagsFor("- This sentence is a bullet item with enough length."), "bullet"));
    assert.ok(flag(flagsFor("1. This sentence is a numbered item with enough length."), "bullet"));
    assert.ok(!flag(flagsFor("This sentence is plain prose with enough length here."), "bullet"));
    assert.ok(flag(flagsFor("Nothing else was found about this particular matter."), "negation"));
    assert.ok(!flag(flagsFor("Something else was found about this particular matter."), "negation"));
    assert.ok(flag(flagsFor("Halcyon appears in a stored record of the company."), "query_term"));
    assert.ok(!flag(flagsFor("Something appears in a stored record of the company."), "query_term"));
    assert.ok(flag(flagsFor("The record status is proposed and not yet confirmed."), "review_status"));
    assert.ok(!flag(flagsFor("Something appears in a stored record of the company."), "review_status"));
    assert.ok(flag(flagsFor("The team that owns this task has not changed lately."), "owner_team"));
    assert.ok(flag(flagsFor("Someone named Dana will handle this for the company."), "owner_team"), "a delivered owner value is recognised");
    assert.ok(!flag(flagsFor("Someone named Dana will handle this for the company.", { queryWords: [], recordTerms: [] }), "owner_team"));
    assert.ok(flag(flagsFor("The due date for this task has not been written down."), "due_date"));
    assert.ok(!flag(flagsFor("Something appears in a stored record of the company."), "due_date"));
  });
  it("one item can match several categories at once, and every uncited factual item is reported with its own index", () => {
    const f = flagsFor("- The record does not state a due date; owner Dana, status proposed, for the warehouse.");
    for (const k of ["bullet", "negation", "query_term", "review_status", "owner_team", "due_date", "factual", "zero_cites"]) assert.ok(flag(f, k), k);
    assert.match(f, /index=2,/);
    assert.match(f, /factual=true\(sentences=1\)/);
    const two = helpers.describeSubmission({ items: [one("First uncited factual sentence about something else.", []), one(cited, ["M1.S2"]), one("Second uncited factual sentence about something else.", [])] }, D, CTX);
    assert.deepEqual([...two.matchAll(/uncited_item\{index=(\d+)/g)].map((m) => m[1]), ["1", "3"]);
  });
  it("cited items, coverage statements and non-factual items are never flagged; the prediction is unchanged", () => {
    const line = helpers.describeSubmission({ items: [one(cited, ["M1.S2"]), one("The notes do not state a due date.", []), one("Short line:", [])] }, D, CTX);
    assert.doesNotMatch(line, /uncited_item/);
    assert.match(line, /predicted_branch=none/);
    assert.doesNotMatch(helpers.describeSubmission({ items: [one(cited, ["M1.S2"])] }, D), /uncited_item/);
  });
  it("empty and very long items: empty text yields no flag; a long one reports its exact length and a bounded result", () => {
    assert.doesNotMatch(helpers.describeSubmission({ items: [one(cited, ["M1.S2"]), one("", []), one("   ", [])] }, D, CTX), /uncited_item/);
    const long = `${"Halcyon warehouse owner due proposed not ".repeat(2000)}.`;
    const line = helpers.describeSubmission({ items: [one(cited, ["M1.S2"]), one(long, [])] }, D, CTX);
    assert.match(line, new RegExp(`uncited_item\\{index=2, chars=${long.length},`));
    assert.ok(line.length < 1500, "the output does not grow with the item");
    const many = helpers.describeSubmission({ items: Array.from({ length: 30 }, (_, i) => one(`Uncited factual sentence number ${i} about nothing at all.`, [])) }, D, CTX);
    assert.equal([...many.matchAll(/uncited_item\{/g)].length, 10, "at most 10 flagged items");
  });
  it("no answer text, evidence text or record value ever appears in the diagnostic output", () => {
    const secret = "Zanzibar quartermaster approved the Halcyon warehouse; owner Dana, Operations, due Friday.";
    const line = helpers.describeSubmission({ items: [one(cited, ["M1.S2"]), one(secret, [])] }, D, CTX);
    assert.doesNotMatch(line, /Zanzibar|quartermaster|approved the|Halcyon|Dana|Operations|Friday|warehouse/i);
    assert.match(line, /uncited_item\{index=2, chars=\d+, bullet=false/);
  });
  it("queryWordsOf reads the model's own search words and recordTermsOf the delivered owner/team values (words only)", () => {
    const messages = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "memory_entities_find", input: { query: "Halcyon warehouse slot" } }, { type: "tool_use", id: "b", name: "memory_entities_find", input: { limit: 3 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "{\"records\":[{\"owner\":\"Dana\",\"team\":\"Operations\"}]}" }] },
    ];
    const words = helpers.queryWordsOf(messages);
    assert.ok(words.includes("halcyon") && words.includes("warehouse"));
    assert.deepEqual(helpers.queryWordsOf("not an array"), []);
    assert.deepEqual(helpers.recordTermsOf(messages).sort(), ["Dana", "Operations"]);
    assert.deepEqual(helpers.recordTermsOf([]), []);
  });
  it("describeRound passes the context through (a flagged line appears for an uncited factual item in a forced final submit)", () => {
    const msgs = [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "tool_use", id: "a", name: "memory_entities_find", input: { query: "warehouse" } }] }, fixtureTurnResult(1)];
    const r = helpers.describeRound(3, msgs, [{ type: "tool_use", name: "submit_answer", input: { items: [one(cited, ["M1.S2"]), one("This record is proposed and has not been reviewed yet.", [])] } }], true);
    assert.match(r, /uncited_item\{index=2, chars=\d+, bullet=false, negation=true, query_term=false, review_status=true/);
    assert.match(r, /predicted_branch=factual_item_without_cite \(item 2\)/);
  });
  // ---- persistence of the K1/K2 diagnostic in the results JSONL (allow-listed, sanitized, bounded)
  const FLAG = "uncited_item{index=2, chars=52, bullet=false, negation=true, query_term=false, review_status=true, owner_team=false, due_date=false, factual=true(sentences=1), zero_cites=true}";
  const K1_DETAIL = (excerpt: string) => `repository records read=1; chars=210 cites=1 excerpt="${excerpt}" labels="Stored Notion memory"; trace=[input{query=warehouse slot, entity_type=-, limit=-} -> ok 1 record(s); round 3 (final turn: submit_answer forced): tools=[submit_answer] final_submit=yes alone=true items=2 delivered_ids=[M1.S2] item1{chars=62, factual_sentences=1, marker_in_text=false, cites=[M1.S2:delivered]} ${FLAG} predicted_branch=factual_item_without_cite (item 2); agent=declined:uncited (tool calls 2)]`;
  it("a K1/K2 detail is kept as one JSON line with the trace and the uncited_item flags intact", () => {
    const line = helpers.detailLine("K1", "FAIL", K1_DETAIL("x"), "2026-11-13T00:00:00.000Z")!;
    const rec = JSON.parse(line) as Record<string, string>;
    assert.deepEqual(Object.keys(rec), ["type", "at", "id", "status", "detail"]);
    assert.equal(rec.type, "detail"); assert.equal(rec.id, "K1"); assert.equal(rec.status, "FAIL");
    assert.ok(rec.detail!.includes(FLAG), "the category flags survive serialization");
    assert.match(rec.detail!, /predicted_branch=factual_item_without_cite \(item 2\)/);
    assert.match(rec.detail!, /^repository records read=1 chars=210 cites=1 trace=\[/);
    assert.ok(!line.includes("\n"), "one line");
    const k2 = JSON.parse(helpers.detailLine("K2", "PASS", `cites=1 valid=1 expected_cites_present=true; chars=210 cites=1 excerpt="e" labels="l"; trace=[agent=answered]`, "t")!) as Record<string, string>;
    assert.equal(k2.detail, "chars=210 cites=1 valid=1 expected_cites_present=true trace=[agent=answered]");
  });
  it("the answer excerpt and labels are never kept, nor is anything outside the allow-list; secret-looking values are redacted", () => {
    const answer = "Zanzibar quartermaster will confirm the pallets; sk-ABCDEFGH12345678 https://example.com/x a@b.com 12345678901";
    const rec = JSON.parse(helpers.detailLine("K1", "PASS", K1_DETAIL(answer), "t")!) as { detail: string };
    assert.doesNotMatch(rec.detail, /Zanzibar|quartermaster|pallets|Stored Notion|excerpt|labels/);
    const sneaky = JSON.parse(helpers.detailLine("K1", "PASS", `chars=5 cites=0 excerpt="x"; trace=[input{query=call me at a@b.com sk-ZZZZZZZZ99999999 https://h.io/p 1234567890123}]`, "t")!) as { detail: string };
    assert.doesNotMatch(sneaky.detail, /a@b\.com|sk-ZZZ|h\.io|1234567890123/);
    assert.match(sneaky.detail, /<email>/); assert.match(sneaky.detail, /<token>/); assert.match(sneaky.detail, /<url>/); assert.match(sneaky.detail, /<num>/);
    const quoted = JSON.parse(helpers.detailLine("K1", "PASS", `chars=5 cites=1 excerpt="He said "secret cites=9 chars=999" ok" labels="l"; trace=[agent=answered]`, "t")!) as { detail: string };
    assert.doesNotMatch(quoted.detail, /secret|cites=9|chars=999/);
  });
  it("the detail is bounded, and empty or missing details yield no line", () => {
    const huge = helpers.detailLine("K1", "FAIL", `chars=1 trace=[${"round 3 ".repeat(5000)}]`, "t")!;
    assert.ok(JSON.parse(huge).detail.length <= 4000);
    assert.equal(helpers.detailLine("K1", "PASS", undefined, "t"), null);
    assert.equal(helpers.detailLine("K1", "PASS", "", "t"), null);
    assert.equal(helpers.detailLine("K1", "PASS", `excerpt="only the answer"`, "t"), null, "nothing allow-listed, nothing written");
  });
  it("the results log is unchanged and stays compatible: a detail line sits after its K check record, the other lines and the summary are as before", async () => {
    const { mkdtempSync, appendFileSync, readFileSync: rf } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openResultsLog } = await import("./live/lib/results-log");
    const dir = mkdtempSync(join(tmpdir(), "k-detail-"));
    const log = openResultsLog(dir, "run1");
    log.record("A1", "guard", "PASS");
    log.record("K1", "memory answer", "FAIL", "chars=210 cites=1 trace=[x]");
    appendFileSync(log.path, `${helpers.detailLine("K1", "FAIL", K1_DETAIL("x"), "t")}\n`, "utf8");
    log.record("K2", "cites", "PASS");
    log.finish([{ id: "A1", text: "guard" }, { id: "K1", text: "k1" }, { id: "K2", text: "k2" }, { id: "KC1", text: "kc1" }], new Set(["A1", "K1", "K2"]));
    const lines = rf(log.path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(lines.map((l) => l.type), ["start", "check", "check", "detail", "check", "check", "summary"]);
    const k1 = lines[2]!;
    assert.deepEqual(Object.keys(k1), ["type", "seq", "at", "id", "name", "status", "codes"], "the check record keeps exactly its old fields");
    assert.ok(!("detail" in k1));
    assert.equal(lines[6]!.passed, 2); assert.equal(lines[6]!.failed, 1); assert.deepEqual(lines[6]!.not_run_ids, ["KC1"]);
  });
  it("the script writes the detail for K1/K2 PASS or FAIL only, to the existing results file, and leaves the writer and console output alone", () => {
    assert.match(SCRIPT, /\(id === "K1" \|\| id === "K2"\) && \(status === "PASS" \|\| status === "FAIL"\) && rlog && existsSync\(rlog\.path\)/);
    assert.match(SCRIPT, /appendFileSync\(rlog\.path, `\$\{line\}\\n`, "utf8"\)/);
    assert.match(SCRIPT, /console\.log\(`\$\{status\.padEnd\(7\)\} \$\{id\.padEnd\(3\)\} \$\{step\.text\}\$\{detail \? `  \(\$\{detail\}\)` : ""\}`\)/, "console line unchanged");
    assert.match(SCRIPT, /rlog\?\.record\(id, step\.text, status, status === "FAIL" \? detail : undefined, status === "BLOCKED" \? detail : undefined\)/, "the writer call is unchanged");
  });
  it("the script still wires the flags into describeRound only, and the K pass conditions are untouched", () => {
    assert.match(SCRIPT, /describeSubmission\(submit\.input, new Set\(deliveredIds\(messages\)\), \{ queryWords: queryWordsOf\(messages\), recordTerms: recordTermsOf\(messages\) \}\)/);
  });
  it("describeRound shows the round, the tools, whether it was the final submit, and the submission breakdown", () => {
    const msgs = [{ role: "user", content: "q" }, { role: "assistant", content: [] }, fixtureTurnResult(1)];
    assert.match(helpers.describeRound(1, [{ role: "user", content: "q" }], [{ type: "tool_use", name: "memory_entities_find", input: { query: "x" } }], false), /^round 1: tools=\[memory_entities_find\] final_submit=no$/);
    assert.match(helpers.describeRound(2, msgs, [{ type: "text" }], false), /^round 2: tools=\[none\] plain_text_only/);
    const r3 = helpers.describeRound(3, msgs, [{ type: "tool_use", name: "submit_answer", input: { items: [one(cited, ["M1.S2"])] } }], true);
    assert.match(r3, /^round 3 \(final turn: submit_answer forced\): tools=\[submit_answer\] final_submit=yes alone=true items=1 delivered_ids=\[M1\.S2\] item1\{chars=\d+, factual_sentences=1, marker_in_text=false, cites=\[M1\.S2:delivered\]\} predicted_branch=none/);
  });
  it("loggingTransport returns the model's turn untouched and records one line per turn (round from the conversation length, forced flag from toolChoice)", async () => {
    const turn: ToolTurn = { blocks: [{ type: "tool_use", id: "s", name: "submit_answer", input: { items: [one(cited, ["M1.S2"])] } }], stopReason: "tool_use", usage: { input: 3, output: 4 } };
    const sink: string[] = [];
    const t = helpers.loggingTransport(async () => turn, sink);
    const req = { system: "s", messages: [{ role: "user" as const, content: "q" }, { role: "assistant" as const, content: [] }, fixtureTurnResult(1) as never, { role: "assistant" as const, content: [] }, fixtureTurnResult(2) as never], tools: [], maxTokens: 1, toolChoice: { tool: "submit_answer" } };
    assert.equal(await t(req as never), turn, "the very same turn object");
    assert.equal(sink.length, 1);
    assert.match(sink[0]!, /^round 3 \(final turn: submit_answer forced\)/);
  });
  it("the predicted branch agrees with what the REAL agent decides, for every shape (answered iff predicted 'none')", async () => {
    const extractor: Extractor = { async extract() { return { ok: true, raw: [{ entity_type: "task", name: "Confirm warehouse slot", description: "Dana confirms the warehouse slot.", evidence: ["S2"], basis: "explicit", confidence: "high", owner: "Dana", team: "Operations" }], truncated: false }; } };
    const notion = { ...unavailableConnectors().notion,
      async findMeetingCandidates() { return { ok: true, data: [{ system: "notion", record_id: "p1", title: "Halcyon logistics", url: "https://www.notion.so/p1", last_edited: "2026-11-01T11:00:00.000Z", date_only: false, date_source: "none", retrieved_at: NOW.toISOString() } as never] }; },
      async readMeetingDocument(id: string) {
        const segments = ["Halcyon logistics", cited].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? "title" as const : "text" as const, text: t, depth: 0 }));
        return { ok: true, data: { system: "notion", record_id: id, title: "Halcyon logistics", url: "https://www.notion.so/p1", last_edited: "2026-11-01T11:00:00.000Z", date_only: false, date_source: "none", retrieved_at: NOW.toISOString(), segments, coverage: { complete: true, gaps: [], blocks_read: 2 } } as never };
      } };
    const shapes: unknown[][] = [
      [one(cited, ["M1.S2"])],
      [one(cited, ["M1.S2"]), one("This record is proposed and has not been reviewed yet.", [])],
      [one(`${cited} It is a proposed record, not yet reviewed.`, ["M1.S2"])],
      [one(cited, ["M1.S1"])],
      [one(cited, ["S2"])],
      [one(cited, ["M1.S2"]), one("No stored record links this slot to Halcyon.", [])],
      [one(cited, ["M1.S2"]), one("The stored notes do not mention Halcyon.", [])],
      [one(cited, [])],
    ];
    for (const items of shapes) {
      const store = createMemoryOrgStore(() => NOW);
      const repoFor = async () => ({ ...fakeRepo({}).repo, orgMemory: store.accessFor(admin) });
      await handleIngest({ user: admin, backendKind: "supabase", repoFor, notion: notion as never, extractor, workspaceId: "ws", now: () => NOW, log: () => undefined });
      const repo = await repoFor();
      const brain = { user: admin, repo, mode: "live" as const, now: NOW, orgMemory: repo.orgMemory.reader, connectors: unavailableConnectors() };
      const use = (name: string, input: unknown): ToolTurn => ({ blocks: [{ type: "tool_use", id: `${name}-${Math.random()}`, name, input }], stopReason: "tool_use", usage: { input: 1, output: 1 } });
      const turns = [use("memory_entities_find", { query: "Halcyon warehouse slot" }), use("memory_entities_find", { query: "Halcyon" }), use("submit_answer", { items })];
      let n = 0;
      const sink: string[] = [];
      const agent = createToolAgent({ transport: helpers.loggingTransport(async () => turns[n++]!, sink), limiter: createMemoryRateLimiter({ maxCalls: 9 }) });
      const out = await agent.run({ userId: "u", role: "admin", message: "what do our stored notes say about the Halcyon warehouse slot", today: "Thursday 12 November 2026", timeZone: "UTC", recent: [], contracts: standardRegistry().list(), run: (id, input) => runBrainTool(brain as never, id, input) });
      assert.equal(sink.length, 3, "one line per round");
      assert.match(sink[0]!, /^round 1: tools=\[memory_entities_find\] final_submit=no$/);
      assert.match(sink[2]!, /^round 3 \(final turn: submit_answer forced\)/);
      const predicted = /predicted_branch=(.*)$/.exec(sink[2]!)![1]!;
      assert.equal(out.kind === "answered", predicted.startsWith("none"), `${JSON.stringify(items).slice(0, 80)} -> agent ${out.kind === "answered" ? "answered" : `declined:${out.reason}`}, predicted ${predicted}`);
      assert.doesNotMatch(sink.join("\n"), /Dana|warehouse slot|Operations team/, "the trace carries no submitted or evidence text");
    }
  });
  it("the live script wires the diagnostics without changing the agent: same createToolAgent and gate, the 20 s transport and 30/hour limiter the application uses, spy over the instrumented agent", () => {
    assert.match(SCRIPT, /const diagAgent = gateRelationshipTool\(createToolAgent\(\{ transport: loggingTransport\(innerTransport \?\? transport, trace\), limiter: createMemoryRateLimiter\(\{ maxCalls: 30, windowMs: 3_600_000 \}\) \}\), process\.env\);/);
    assert.match(SCRIPT, /createToolTransport\(loadAiBrainConfig\(process\.env\), \{ timeoutMs: 20_000 \}\)/);
    assert.match(SCRIPT, /const o = await diagAgent\.run\(/);
    assert.doesNotMatch(SCRIPT, /MAX_CALLS|MAX_ROUNDS/, "no limit is touched or restated by the script");
  });
  it("the trace instrumentation changes no behaviour: the adapter result is returned as before and errors are rethrown", () => {
    assert.match(SCRIPT, /const r = await a\.reader\.findEntities\(q\); reads\[key\] \+= r\.length; trace\.push\(describeAdapterCall\(q, r\.length\)\); return r;/);
    assert.match(SCRIPT, /catch \(e\) \{ trace\.push\(describeAdapterCall\(q, e\)\); throw e; \}/);
  });
  it("the K pass conditions are unchanged (reads, citations, valid ids, proposed wording)", () => {
    assert.match(SCRIPT, /check\("K1", !!q1 && reads\.admin > 0 && \/stored Notion memory\/\.test\(q1\.sections\)/);
    assert.match(SCRIPT, /q1\.cites\.length > 0 && q1\.cites\.every\(\(c\) => validIds\.has\(c\)\)/);
  });
});

// ---- --k-only mode: its cleanup scope is one source in its own workspace, and the full-run scope is unchanged
import { cleanupProblems, kOnlyStateProblems } from "./live/lib/org-memory-live-plan";
describe("--k-only cleanup scope", () => {
  const k = (over: Partial<State> = {}): State => ({ runId: RUN, ws: `live-konly-${RUN}`, sources: [`${RUN}-k1`], held: [], docs: [], entities: 0, ...over });
  it("accepts exactly the state a K-only run writes, through the shared check", () => {
    assert.deepEqual(kOnlyStateProblems(k()), []);
    assert.deepEqual(cleanupProblems(k()), []);
    assert.deepEqual(cleanupProblems(good()), [], "the full run's scope still passes");
  });
  it("refuses a foreign workspace, extra or foreign sources, and a mixed scheme", () => {
    assert.notDeepEqual(cleanupProblems(k({ ws: "default" })), []);
    assert.notDeepEqual(cleanupProblems(k({ ws: "live-konly-20260101000000-aaaaaa" })), []);
    assert.notDeepEqual(cleanupProblems(k({ sources: [`${RUN}-k1`, `${RUN}-p1`] })), []);
    assert.notDeepEqual(cleanupProblems(k({ sources: ["real-notion-page-id"] })), []);
    assert.notDeepEqual(cleanupProblems(k({ sources: [`${RUN}-p1`] })), [], "a full-run source id is not a K-only source id");
    assert.notDeepEqual(cleanupProblems(good({ ws: `live-konly-${RUN}` })), [], "full-run sources under a K-only workspace are refused");
    assert.notDeepEqual(cleanupProblems(k({ held: ["not-a-uuid"] })), []);
    assert.notDeepEqual(cleanupProblems({}), []);
  });
  it("the script keeps K-only inside its bounds: K1/K2 only, no member, no review, no relationships, no service role", () => {
    const body = SCRIPT.slice(SCRIPT.indexOf("async function kOnlyRun("), SCRIPT.indexOf("async function main("));
    assert.ok(body.length > 500);
    assert.doesNotMatch(body, /PRECON_LIVE_MEMBER|\.review\(|proposeToKnowledge|knowledge_review|upsertRelationships|org_relationship|SERVICE_ROLE|service_role/);
    assert.match(body, /if \(!preflightOk\) throw new Abort\("preflight failed; NO write was made"\)/, "every guard runs before the first write");
    assert.ok(body.indexOf("preflight failed") < body.indexOf("handleIngest("), "preflight precedes ingestion");
    assert.match(SCRIPT, /if \(k12\) return; \/\/ K-only mode stops here: no K3, no member question/);
  });
});
