import "server-only";
import type { ConnectorFailure, ConnectorResult, ExternalRecord, NotionConnector } from "./connectors";
import { isValidTimeZone, zonedToUtc } from "./meetings/datetime";
import type { CoverageGap, MeetingCandidate, MeetingDocument, SourceSegment } from "./meetings/types";

/**
 * Read-only Notion client for the Broko Assistant. SERVER ONLY (the `server-only` import fails a client bundle at build time).
 *
 * What it can do: search pages and databases that were explicitly SHARED with the Notion integration, read one page (title and a short
 * plain-text excerpt), and list the rows of one shared database (titles and links). What it can never do: create, edit, delete or
 * comment. Only four request shapes exist below (POST /search, GET /pages/{id}, GET /blocks/{id}/children, POST /databases/{id}/query),
 * the host is fixed, ids are validated before they reach a URL, and redirects are refused.
 *
 * The token is read once from `NOTION_API_KEY`, lives only in this closure and the Authorization header of the request, and is never
 * put in a result, error, log or audit value: every failure becomes a fixed code. Notion access is workspace-level (it sees what was
 * shared with the integration, not what the individual employee could open in Notion), so what is shared is the access boundary.
 * Everything returned is untrusted data (see tools.ts runTool).
 */

const BASE = "https://api.notion.com/v1/";
/** Stable API version. Newer versions split databases into "data sources"; this client uses only the stable page/search shapes. */
const NOTION_VERSION = "2022-06-28";
const FETCH_TIMEOUT_MS = 6000;
const MAX_BODY_CHARS = 1_000_000;
const MAX_EXCERPT_CHARS = 1500;
const MAX_BLOCKS = 100;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export type NotionFetch = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: "error" }) => Promise<{ status: number; text(): Promise<string> }>;

/** Dashes added to a bare 32-hex id; null if it is not a Notion id. */
export function normalizeNotionId(id: string): string | null {
  if (!UUID.test(id)) return null;
  const h = id.replace(/-/g, "").toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const plain = (richText: unknown): string => arr(richText).map((t) => str(obj(t)?.plain_text)).join("");

/** Page title: the property of type "title", whatever it is called. Database title: its title rich text. */
export function titleOf(o: Json): string {
  if (o.object === "database") return plain(o.title).trim();
  const props = obj(o.properties) ?? {};
  for (const p of Object.values(props)) { const prop = obj(p); if (prop?.type === "title") return plain(prop.title).trim(); }
  return "";
}

const TEXT_BLOCKS = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "callout", "toggle"]);
/** Plain text of the supported text blocks only (no files, embeds, images, formulas or child pages), capped. */
export function excerptOf(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const b of blocks.slice(0, MAX_BLOCKS)) {
    const block = obj(b); const type = str(block?.type);
    if (!block || !TEXT_BLOCKS.has(type)) continue;
    const t = plain(obj(block[type])?.rich_text).trim();
    if (t) parts.push(t);
  }
  return parts.join(" ").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS);
}

const safeUrl = (u: unknown): string | undefined => (typeof u === "string" && /^https:\/\/([a-z0-9-]+\.)?notion\.(so|site)\/[^\s]{0,400}$/i.test(u) ? u : undefined);

/** The containing page or database (normalized id), if Notion reports one. Used only for organization-resource policy. */
export function parentIdOf(o: Json): string | undefined {
  const p = obj(o.parent);
  if (!p) return undefined;
  const raw = str(p.database_id) || str(p.page_id) || str(p.block_id);
  return (raw && normalizeNotionId(raw)) || undefined;
}

function recordOf(o: Json, now: Date, excerpt?: string): ExternalRecord | null {
  const id = normalizeNotionId(str(o.id));
  const kind = o.object === "database" ? "database" : o.object === "page" ? "page" : null;
  if (!id || !kind) return null;
  const edited = str(o.last_edited_time).slice(0, 10);
  const url = safeUrl(o.url);
  const parent = parentIdOf(o);
  return {
    system: "notion", record_id: id, title: titleOf(o) || "(untitled)", ...(excerpt ? { excerpt } : {}), ...(url ? { url } : {}), ...(parent ? { parent_id: parent } : {}),
    owner_context: `Notion ${kind}${edited ? `, last edited ${edited}` : ""}`, retrieved_at: now.toISOString(),
  };
}

// ---- meeting discovery and content (read-only) ----------------------------------------------------------------------------

const MAX_BLOCKS_TOTAL = 800;
const MAX_DEPTH = 4;
const MAX_REQUESTS = 60;
const READ_DEADLINE_MS = 6500; // a long Notion AI transcript is ~350 blocks over several sequential pages; the tool's own timeout is 10 s
const CONCURRENCY = 4;
const MAX_CANDIDATES = 100;
const MAX_PROPERTIES = 15;
const DATE_PROP_NAME = /date|when|time|meeting|start/i;

/** A page's date: the best date property (a database "Date" column), else the creation time. Date-only values stay a plain YYYY-MM-DD. */
export function meetingDateOf(o: Json): { starts_at?: string; date_only: boolean; date_source: MeetingCandidate["date_source"] } {
  const props = obj(o.properties) ?? {};
  const dates = Object.entries(props).map(([name, p]) => ({ name, p: obj(p) })).filter((x) => x.p?.type === "date" && obj(x.p.date)?.start);
  const best = dates.find((d) => DATE_PROP_NAME.test(d.name)) ?? dates[0];
  if (best) {
    const d = obj(best.p!.date)!;
    const start = str(d.start);
    if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return { starts_at: start, date_only: true, date_source: "date_property" };
    const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(start);
    const zone = str(d.time_zone);
    let ms = Number.NaN;
    if (hasOffset) ms = Date.parse(start);
    else if (zone && isValidTimeZone(zone)) {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(start);
      if (m) ms = zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), zone);
    } else ms = Date.parse(`${start}Z`);
    if (Number.isFinite(ms)) return { starts_at: new Date(ms).toISOString(), date_only: false, date_source: "date_property" };
  }
  const created = Date.parse(str(o.created_time));
  return Number.isFinite(created) ? { starts_at: new Date(created).toISOString(), date_only: false, date_source: "created_time" } : { date_only: false, date_source: "none" };
}

export function candidateOf(o: Json, now: Date): MeetingCandidate | null {
  const id = normalizeNotionId(str(o.id));
  if (!id || o.object !== "page") return null;
  const url = safeUrl(o.url);
  const edited = str(o.last_edited_time);
  const parent = parentIdOf(o);
  return {
    system: "notion", record_id: id, title: titleOf(o) || "(untitled)", ...(url ? { url } : {}), ...(edited ? { last_edited: edited } : {}), ...(parent ? { parent_id: parent } : {}),
    ...meetingDateOf(o), retrieved_at: now.toISOString(),
  };
}

const propertyText = (p: Json): string => {
  switch (p.type) {
    case "rich_text": return plain(p.rich_text);
    case "select": case "status": return str(obj(p[str(p.type)])?.name);
    case "multi_select": return arr(p.multi_select).map((x) => str(obj(x)?.name)).filter(Boolean).join(", ");
    case "people": return arr(p.people).map((x) => str(obj(x)?.name)).filter(Boolean).join(", ");
    case "number": return typeof p.number === "number" ? String(p.number) : "";
    case "date": { const d = obj(p.date); return d?.start ? `${str(d.start)}${d.end ? ` to ${str(d.end)}` : ""}` : ""; }
    default: return "";
  }
};

export interface SegmentDraft { ref: string; kind: SourceSegment["kind"]; text: string; depth: number; checked?: boolean }

/** The text a block contributes, or nothing for types that carry none (images, files, embeds, code, formulas, databases). */
export function draftsOf(block: Json, depth: number): SegmentDraft[] {
  const type = str(block.type);
  const ref = str(block.id);
  const rich = (k: string) => plain(obj(block[k])?.rich_text).trim();
  const one = (kind: SourceSegment["kind"], text: string, checked?: boolean): SegmentDraft[] => (text ? [{ ref, kind, text, depth, ...(checked === undefined ? {} : { checked }) }] : []);
  switch (type) {
    case "heading_1": case "heading_2": case "heading_3": return one("heading", rich(type));
    case "paragraph": case "bulleted_list_item": case "numbered_list_item": case "callout": case "toggle": return one("text", rich(type));
    case "quote": return one("quote", rich(type));
    case "to_do": return one("todo", rich(type), obj(block.to_do)?.checked === true);
    case "table_row": return one("table", arr(obj(block.table_row)?.cells).map((c) => plain(c).trim()).filter(Boolean).join(" | "));
    case "child_page": return one("subpage", str(obj(block.child_page)?.title).trim());
    default: return [];
  }
}

class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active += 1;
    try { return await fn(); } finally { this.active -= 1; this.waiting.shift()?.(); }
  }
}

export interface NotionOptions { token: string; now?: Date; fetch?: NotionFetch }

export function createNotionConnector(opts: NotionOptions): NotionConnector {
  const token = opts.token;
  const now = opts.now ?? new Date();
  const doFetch: NotionFetch = opts.fetch ?? ((url, init) => fetch(url, init));

  /** One request. Every outcome is a fixed code; the response body is parsed only on 200 and never copied into an error. */
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<ConnectorResult<Json>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(`${BASE}${path}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 429) return { ok: false, reason: "rate_limited" };
      if (res.status === 401) return { ok: false, reason: "not_connected" }; // token invalid or revoked: the connector is effectively not connected
      if (res.status === 403 || res.status === 404) return { ok: false, reason: "permission_denied" }; // not shared with the integration, or restricted
      if (res.status !== 200) return { ok: false, reason: "error" };
      const text = await res.text();
      if (text.length > MAX_BODY_CHARS) return { ok: false, reason: "error" };
      const parsed = obj(JSON.parse(text));
      return parsed ? { ok: true, data: parsed } : { ok: false, reason: "error" };
    } catch (e) {
      return { ok: false, reason: (e as { name?: string })?.name === "AbortError" ? "timeout" : "error" };
    } finally {
      clearTimeout(timer);
    }
  }

  const records = (results: unknown): ExternalRecord[] => arr(results).map((r) => { const o = obj(r); return o ? recordOf(o, now) : null; }).filter((r): r is ExternalRecord => r !== null);

  return {
    async searchPages(query, limit) {
      const r = await call("POST", "search", { query: query.slice(0, 200), page_size: Math.max(1, Math.min(limit, 25)), sort: { direction: "descending", timestamp: "last_edited_time" } });
      return r.ok ? { ok: true, data: records(r.data.results) } : r;
    },
    async getPage(pageId) {
      const id = normalizeNotionId(pageId);
      if (!id) return { ok: false, reason: "error" };
      const page = await call("GET", `pages/${id}`);
      if (!page.ok) return page;
      // A failed content read still returns the page (title, link); the excerpt is simply absent.
      const blocks = await call("GET", `blocks/${id}/children?page_size=${MAX_BLOCKS}`);
      const rec = recordOf(page.data, now, blocks.ok ? excerptOf(arr(blocks.data.results)) || undefined : undefined);
      return rec ? { ok: true, data: rec } : { ok: false, reason: "error" };
    },
    async queryDatabase(databaseId, limit) {
      const id = normalizeNotionId(databaseId);
      if (!id) return { ok: false, reason: "error" };
      const r = await call("POST", `databases/${id}/query`, { page_size: Math.max(1, Math.min(limit, 25)) });
      return r.ok ? { ok: true, data: records(r.data.results) } : r;
    },

    /**
     * Meeting discovery. Notion search matches titles only, so three searches run in parallel (the keywords, "meeting", and the most recently
     * edited pages) and are merged. The caller filters by date, time and keywords: nothing here decides which meeting is meant.
     */
    async findMeetingCandidates(keywords, limit) {
      const kw = keywords.join(" ").trim().slice(0, 200);
      const plan: { query: string; pages: number }[] = [{ query: "meeting", pages: 1 }, { query: "", pages: 2 }, ...(kw ? [{ query: kw, pages: 1 }] : [])];
      const runs = await Promise.all(plan.map(async ({ query, pages }): Promise<ConnectorResult<Json[]>> => {
        const out: Json[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < pages; i++) {
          const r = await call("POST", "search", { query, page_size: 50, filter: { property: "object", value: "page" }, sort: { direction: "descending", timestamp: "last_edited_time" }, ...(cursor ? { start_cursor: cursor } : {}) });
          if (!r.ok) return i === 0 ? r : { ok: true, data: out };
          out.push(...arr(r.data.results).map(obj).filter((x): x is Json => x !== null));
          cursor = r.data.has_more === true && typeof r.data.next_cursor === "string" ? r.data.next_cursor : undefined;
          if (!cursor) break;
        }
        return { ok: true, data: out };
      }));
      const good = runs.filter((r): r is { ok: true; data: Json[] } => r.ok);
      if (good.length === 0) return runs.find((r): r is { ok: false; reason: ConnectorFailure } => !r.ok) ?? { ok: false, reason: "error" };
      const seen = new Set<string>();
      const found: MeetingCandidate[] = [];
      for (const o of good.flatMap((r) => r.data)) {
        const c = candidateOf(o, now);
        if (c && !seen.has(c.record_id)) { seen.add(c.record_id); found.push(c); }
      }
      found.sort((a, b) => (b.last_edited ?? "").localeCompare(a.last_edited ?? ""));
      return { ok: true, data: found.slice(0, Math.max(1, Math.min(limit, MAX_CANDIDATES))) };
    },

    /**
     * One page with ALL its content: properties, every block (paginated, 100 per request), nested blocks and child pages, in reading order.
     * Bounded by depth, block count, request count and a time limit; anything not read is recorded in `coverage`, never silently dropped.
     * If the page itself or its top-level content cannot be read, that is a failure (typically: not shared with the integration).
     */
    async readMeetingDocument(pageId) {
      const id = normalizeNotionId(pageId);
      if (!id) return { ok: false, reason: "error" };
      const started = Date.now();
      const gaps = new Set<CoverageGap>();
      const budget = { blocks: 0, requests: 0 };
      const sem = new Semaphore(CONCURRENCY);
      const stop = (): CoverageGap | null => (Date.now() - started > READ_DEADLINE_MS ? "time_limit" : budget.requests >= MAX_REQUESTS ? "request_limit" : budget.blocks >= MAX_BLOCKS_TOTAL ? "block_limit" : null);

      const page = await call("GET", `pages/${id}`);
      if (!page.ok) return page;
      budget.requests += 1;

      /** All children of one block, following next_cursor. A failure part-way keeps what was read and records the gap. */
      async function children(parent: string): Promise<ConnectorResult<Json[]>> {
        const out: Json[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 10; i++) {
          const why = stop();
          if (why) { gaps.add(why); break; }
          budget.requests += 1;
          const r = await sem.run(() => call("GET", `blocks/${parent}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`));
          if (!r.ok) return out.length > 0 ? { ok: true, data: out } : r;
          const got = arr(r.data.results).map(obj).filter((x): x is Json => x !== null);
          budget.blocks += got.length;
          out.push(...got);
          cursor = r.data.has_more === true && typeof r.data.next_cursor === "string" ? r.data.next_cursor : undefined;
          if (!cursor) break;
          if (i === 9) gaps.add("request_limit");
        }
        return { ok: true, data: out };
      }

      async function walk(blocks: Json[], depth: number): Promise<SegmentDraft[]> {
        const parts = await Promise.all(blocks.map(async (b): Promise<SegmentDraft[]> => {
          const drafts = draftsOf(b, depth);
          const type = str(b.type);
          if (b.has_children !== true || type === "child_database") return drafts;
          if (depth >= MAX_DEPTH) { gaps.add("depth_limit"); return drafts; }
          const blockId = normalizeNotionId(str(b.id));
          if (!blockId) return drafts;
          const kids = await children(blockId);
          if (!kids.ok) { gaps.add(kids.reason === "rate_limited" ? "rate_limited" : "unreadable_children"); return drafts; }
          return [...drafts, ...(await walk(kids.data, depth + 1))];
        }));
        return parts.flat();
      }

      const top = await children(id);
      if (!top.ok) return top; // not shared, revoked, or Notion unavailable: no partial "document" is invented
      const body = await walk(top.data, 0);

      const segments: SourceSegment[] = [];
      let n = 0;
      const add = (d: SegmentDraft) => segments.push({ id: `S${++n}`, ref: d.ref, kind: d.kind, text: d.text, depth: d.depth, ...(d.checked === undefined ? {} : { checked: d.checked }) });
      const title = titleOf(page.data) || "(untitled)";
      add({ ref: id, kind: "title", text: title, depth: 0 });
      let shown = 0;
      for (const [name, p] of Object.entries(obj(page.data.properties) ?? {})) {
        const prop = obj(p);
        if (!prop || prop.type === "title" || shown >= MAX_PROPERTIES) continue;
        const v = propertyText(prop).trim();
        if (v) { add({ ref: `${id}#${name}`.slice(0, 120), kind: "property", text: `${name}: ${v}`.slice(0, 400), depth: 0 }); shown += 1; }
      }
      body.forEach(add);

      const url = safeUrl(page.data.url);
      const edited = str(page.data.last_edited_time);
      const parent = parentIdOf(page.data);
      return {
        ok: true,
        data: {
          system: "notion", record_id: id, title, ...(url ? { url } : {}), ...(edited ? { last_edited: edited } : {}), ...(parent ? { parent_id: parent } : {}), ...meetingDateOf(page.data),
          retrieved_at: now.toISOString(), segments, coverage: { complete: gaps.size === 0, gaps: [...gaps], blocks_read: budget.blocks },
        } satisfies MeetingDocument,
      };
    },
  };
}

/** The configured token if it has a plausible shape, else null. The ONLY place the variable is read; for server-side callers that make their own read-only requests (the admin panel). */
export function notionTokenFromEnv(env: Record<string, string | undefined>): string | null {
  const token = env.NOTION_API_KEY?.trim();
  return !token || token.length < 20 || token.length > 400 || /\s/.test(token) ? null : token;
}

/** A connector when `NOTION_API_KEY` looks like a Notion token, otherwise null. The value is never logged or returned. */
export function notionConnectorFromEnv(env: Record<string, string | undefined>, now?: Date, fetchImpl?: NotionFetch): NotionConnector | null {
  const token = notionTokenFromEnv(env);
  if (!token) return null;
  return createNotionConnector({ token, ...(now ? { now } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}
