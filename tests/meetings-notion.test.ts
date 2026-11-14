import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candidateOf, createNotionConnector, meetingDateOf, type NotionFetch } from "../src/lib/ai-brain/assistant/notion";
import { NOW } from "./ai-chat-helpers";

// Meeting discovery and content retrieval against a FAKE Notion (an injected fetch). Nothing here contacts Notion.
const TOKEN = ["ntn", "_", "TESTONLY", "0123456789abcdefghijklmnopqrstuvwxyz"].join("");
const PAGE = "11111111-2222-4333-8444-555555555555";
const hex = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Call { url: string; method: string; body?: string }
type Reply = { status: number; body?: unknown } | "throw";
function fake(handler: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fetch: NotionFetch = async (url, init) => {
    const c: Call = { url: url.replace("https://api.notion.com/v1/", ""), method: init.method, body: init.body };
    calls.push(c);
    const out = handler(c);
    if (out === "throw") throw new Error(`socket reset ${init.headers.Authorization}`);
    return { status: out.status, text: async () => JSON.stringify(out.body ?? {}) };
  };
  return { calls, notion: createNotionConnector({ token: TOKEN, now: NOW, fetch }) };
}
const rich = (t: string) => [{ plain_text: t }];
const blk = (id: string, type: string, text: string, has_children = false, extra: Record<string, unknown> = {}) => ({ object: "block", id, type, has_children, [type]: { rich_text: rich(text), ...extra } });
const page = (title: string, over: Record<string, unknown> = {}, id = PAGE) => ({
  object: "page", id, url: `https://www.notion.so/${title.replace(/\s+/g, "-")}-${id.replace(/-/g, "")}`, created_time: "2026-10-20T08:00:00.000Z", last_edited_time: "2026-10-24T10:00:00.000Z",
  properties: { Name: { type: "title", title: rich(title) }, ...over },
});

describe("D. meeting discovery", () => {
  it("dates come from a date property first (date-only stays a plain date), then the creation time", () => {
    const withTime = meetingDateOf(page("A", { Date: { type: "date", date: { start: "2026-10-23T13:00:00.000+05:30", end: null, time_zone: null } } }));
    assert.deepEqual(withTime, { starts_at: "2026-10-23T07:30:00.000Z", date_only: false, date_source: "date_property" });
    assert.deepEqual(meetingDateOf(page("A", { Date: { type: "date", date: { start: "2026-10-23" } } })), { starts_at: "2026-10-23", date_only: true, date_source: "date_property" });
    const zoned = meetingDateOf(page("A", { When: { type: "date", date: { start: "2026-10-23T13:00:00", time_zone: "Asia/Kolkata" } } }));
    assert.equal(zoned.starts_at, "2026-10-23T07:30:00.000Z");
    assert.deepEqual(meetingDateOf(page("A")), { starts_at: "2026-10-20T08:00:00.000Z", date_only: false, date_source: "created_time" });
    assert.equal(meetingDateOf({ object: "page", properties: {} }).date_source, "none");
  });

  it("candidates keep title, page id, original URL and last-edited time; databases and junk are skipped", () => {
    const c = candidateOf(page("Weekly sync"), NOW)!;
    assert.equal(c.title, "Weekly sync");
    assert.equal(c.record_id, PAGE);
    assert.match(c.url!, /^https:\/\/www\.notion\.so\//);
    assert.equal(c.last_edited, "2026-10-24T10:00:00.000Z");
    assert.equal(candidateOf({ object: "database", id: PAGE }, NOW), null);
    assert.equal(candidateOf({ object: "page", id: "not-an-id" }, NOW), null);
    assert.equal(candidateOf({ ...page("X"), url: "https://evil.example/x" }, NOW)!.url, undefined, "a non-Notion link is dropped");
  });

  it("runs the title search, a 'meeting' search and a recent-pages search in parallel, merges and de-duplicates them", async () => {
    const { notion, calls } = fake((c) => {
      const q = JSON.parse(c.body!).query as string;
      return { status: 200, body: { results: q === "" ? [page("Alpha", {}, hex(1)), page("Beta", {}, hex(2))] : [page("Alpha", {}, hex(1)), page(`Hit ${q}`, {}, hex(3))] } };
    });
    const r = await notion.findMeetingCandidates(["marketing"], 100);
    assert.ok(r.ok);
    assert.equal(new Set(r.data.map((x) => x.record_id)).size, r.data.length, "no duplicates");
    assert.equal(r.data.length, 3, "Alpha is returned by every search but appears once");
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`).sort(), ["POST search", "POST search", "POST search"]);
    assert.ok(calls.every((c) => JSON.parse(c.body!).filter.value === "page"), "pages only");
  });

  it("follows pagination of the recent-pages search, then stops", async () => {
    let n = 0;
    const { notion, calls } = fake((c) => {
      const b = JSON.parse(c.body!);
      if (b.query !== "") return { status: 200, body: { results: [] } };
      n += 1;
      return { status: 200, body: { results: [page(`P${n}`, {}, hex(10 + n))], has_more: true, next_cursor: `cur${n}` } };
    });
    const r = await notion.findMeetingCandidates([], 100);
    assert.ok(r.ok);
    assert.equal(calls.filter((c) => JSON.parse(c.body!).query === "").length, 2, "two pages of the broad search, no more");
    assert.ok(calls.some((c) => JSON.parse(c.body!).start_cursor === "cur1"));
  });

  it("nothing shared with the integration is an empty list, not an error; an auth failure is a failure", async () => {
    const empty = fake(() => ({ status: 200, body: { results: [] } }));
    assert.deepEqual(await empty.notion.findMeetingCandidates(["x"], 10), { ok: true, data: [] });
    const denied = fake(() => ({ status: 401 }));
    assert.deepEqual(await denied.notion.findMeetingCandidates(["x"], 10), { ok: false, reason: "not_connected" });
    const limited = fake(() => ({ status: 429 }));
    assert.deepEqual(await limited.notion.findMeetingCandidates(["x"], 10), { ok: false, reason: "rate_limited" });
  });
});

describe("G. nested block retrieval and pagination", () => {
  /** A page whose body is: heading, a paragraph with nested children (a bullet with a to-do), a toggle, a table, and a child page. */
  const tree = (c: Call): Reply => {
    const u = c.url;
    if (u === `pages/${PAGE}`) return { status: 200, body: page("AI Automation Partnership", { Attendees: { type: "people", people: [{ name: "Priya Shah" }, { name: "Rahul Mehta" }] }, Date: { type: "date", date: { start: "2026-10-23T13:00:00.000+05:30" } }, Done: { type: "checkbox", checkbox: true } }) };
    if (u.startsWith(`blocks/${PAGE}/children`)) {
      return u.includes("start_cursor=c2")
        ? { status: 200, body: { results: [blk(hex(5), "child_page", "", true, { title: "Appendix" }), blk(hex(6), "paragraph", "Closing remarks.")], has_more: false } }
        : { status: 200, body: { results: [blk(hex(1), "heading_2", "Decisions"), blk(hex(2), "paragraph", "Parent paragraph", true), blk(hex(3), "toggle", "Toggle with notes", true), blk(hex(4), "table", "", true), blk(hex(9), "image", "")], has_more: true, next_cursor: "c2" } };
    }
    if (u.startsWith(`blocks/${hex(2)}/children`)) return { status: 200, body: { results: [blk(hex(20), "bulleted_list_item", "Nested bullet", true)] } };
    if (u.startsWith(`blocks/${hex(20)}/children`)) return { status: 200, body: { results: [blk(hex(21), "to_do", "Deep to-do item", false, { checked: true })] } };
    if (u.startsWith(`blocks/${hex(3)}/children`)) return { status: 200, body: { results: [blk(hex(30), "paragraph", "Inside the toggle")] } };
    if (u.startsWith(`blocks/${hex(4)}/children`)) return { status: 200, body: { results: [{ object: "block", id: hex(40), type: "table_row", has_children: false, table_row: { cells: [rich("Owner"), rich("Due")] } }] } };
    if (u.startsWith(`blocks/${hex(5)}/children`)) return { status: 200, body: { results: [blk(hex(50), "paragraph", "Appendix body text")] } };
    return { status: 404 };
  };

  it("reads every top-level page of blocks, all nested levels and child pages, in reading order, with numbered segments", async () => {
    const { notion } = fake(tree);
    const r = await notion.readMeetingDocument(PAGE);
    assert.ok(r.ok);
    const d = r.data;
    assert.equal(d.title, "AI Automation Partnership");
    assert.deepEqual(d.segments.map((s) => s.text), [
      "AI Automation Partnership", "Attendees: Priya Shah, Rahul Mehta", "Date: 2026-10-23T13:00:00.000+05:30",
      "Decisions", "Parent paragraph", "Nested bullet", "Deep to-do item", "Toggle with notes", "Inside the toggle", "Owner | Due", "Appendix", "Appendix body text", "Closing remarks.",
    ]);
    assert.deepEqual(d.segments.map((s) => s.id), d.segments.map((_, i) => `S${i + 1}`));
    assert.equal(d.segments.find((s) => s.text === "Deep to-do item")?.kind, "todo");
    assert.equal(d.segments.find((s) => s.text === "Deep to-do item")?.checked, true);
    assert.equal(d.segments.find((s) => s.text === "Deep to-do item")?.depth, 2);
    assert.equal(d.segments.find((s) => s.text === "Appendix")?.kind, "subpage");
    assert.equal(d.segments.find((s) => s.text === "Deep to-do item")?.ref, hex(21), "the source block id is kept");
    assert.deepEqual(d.coverage, { complete: true, gaps: [], blocks_read: 12 });
    assert.equal(d.starts_at, "2026-10-23T07:30:00.000Z");
  });

  it("keeps the source page id, title, original URL and last-edited time", async () => {
    const { notion } = fake(tree);
    const r = await notion.readMeetingDocument(PAGE);
    assert.ok(r.ok);
    assert.equal(r.data.record_id, PAGE);
    assert.match(r.data.url!, /^https:\/\/www\.notion\.so\/AI-Automation-Partnership-/);
    assert.equal(r.data.last_edited, "2026-10-24T10:00:00.000Z");
    assert.equal(r.data.retrieved_at, NOW.toISOString());
  });

  it("only ever sends GET page, GET block children and POST search: a read of a whole tree changes nothing", async () => {
    const { notion, calls } = fake(tree);
    await notion.readMeetingDocument(PAGE);
    await notion.findMeetingCandidates(["x"], 5);
    assert.ok(calls.every((c) => c.method === "GET" || c.url === "search"));
    assert.ok(calls.every((c) => !/PATCH|DELETE|comments/.test(c.url)));
  });

  it("a page that is not shared (404) or not allowed (403) is a failure, not an empty document", async () => {
    assert.deepEqual(await fake(() => ({ status: 404 })).notion.readMeetingDocument(PAGE), { ok: false, reason: "permission_denied" });
    assert.deepEqual(await fake(() => ({ status: 403 })).notion.readMeetingDocument(PAGE), { ok: false, reason: "permission_denied" });
    const noContent = fake((c) => (c.url.startsWith("pages/") ? { status: 200, body: page("Hidden") } : { status: 404 }));
    assert.deepEqual(await noContent.notion.readMeetingDocument(PAGE), { ok: false, reason: "permission_denied" }, "readable page, unreadable content");
    assert.deepEqual(await fake(() => ({ status: 200, body: {} })).notion.readMeetingDocument("../../users"), { ok: false, reason: "error" });
  });

  it("nested content that cannot be read is recorded as a coverage gap, and the rest is still returned", async () => {
    const { notion } = fake((c) => (c.url.startsWith(`blocks/${hex(2)}/children`) ? { status: 404 } : c.url.startsWith(`blocks/${hex(3)}/children`) ? { status: 429 } : tree(c)));
    const r = await notion.readMeetingDocument(PAGE);
    assert.ok(r.ok);
    assert.equal(r.data.coverage.complete, false);
    assert.deepEqual([...r.data.coverage.gaps].sort(), ["rate_limited", "unreadable_children"]);
    assert.ok(r.data.segments.some((s) => s.text === "Closing remarks."));
    assert.ok(!r.data.segments.some((s) => s.text === "Nested bullet"));
  });

  it("a network error never leaks the token and fails safely", async () => {
    const r = await fake(() => "throw").notion.readMeetingDocument(PAGE);
    assert.deepEqual(r, { ok: false, reason: "error" });
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  });
});

describe("H. large meeting content", () => {
  it("pagination beyond the block limit stops, returns what was read, and says the page is incomplete", async () => {
    let cursor = 0;
    const { notion, calls } = fake((c) => {
      if (c.url === `pages/${PAGE}`) return { status: 200, body: page("Huge") };
      cursor += 1;
      return { status: 200, body: { results: Array.from({ length: 100 }, (_, i) => blk(hex(cursor * 1000 + i), "paragraph", `Line ${cursor}-${i}`)), has_more: true, next_cursor: `n${cursor}` } };
    });
    const r = await notion.readMeetingDocument(PAGE);
    assert.ok(r.ok);
    assert.equal(r.data.coverage.complete, false);
    assert.ok(r.data.coverage.gaps.includes("block_limit"));
    assert.ok(r.data.coverage.blocks_read >= 800 && r.data.coverage.blocks_read <= 1000);
    assert.ok(calls.length <= 12, `bounded number of requests (${calls.length})`);
    assert.ok(r.data.segments.length > 800, "everything read before the limit is returned");
  });

  it("nesting deeper than the depth limit is not opened and is reported", async () => {
    const { notion } = fake((c) => {
      if (c.url === `pages/${PAGE}`) return { status: 200, body: page("Deep") };
      const m = /^blocks\/(.+?)\/children/.exec(c.url)!;
      const level = m[1] === PAGE ? 0 : Number(m[1].slice(-4));
      return { status: 200, body: { results: [blk(hex(level + 1), "paragraph", `Level ${level + 1}`, true)] } };
    });
    const r = await notion.readMeetingDocument(PAGE);
    assert.ok(r.ok);
    assert.ok(r.data.coverage.gaps.includes("depth_limit"));
    assert.equal(r.data.coverage.complete, false);
    assert.ok(r.data.segments.some((s) => s.text === "Level 4"));
    assert.ok(!r.data.segments.some((s) => s.text === "Level 6"));
  });
});
