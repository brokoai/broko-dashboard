import { areaLabel, bathsLabel, bedsLabel, isStale, money, STALE_DAYS } from "@/lib/precon/format";
import { UUID_RE } from "@/lib/precon/files";
import type { PreconRepo } from "@/lib/precon/repo";
import { tokens } from "@/lib/precon/search";
import {
  AVAILABILITY_LABEL, PROJECT_STATUS_LABEL, type Availability, type InventoryListItem, type PreconDocument, type PreconProject, type SearchHit,
} from "@/lib/precon/types";
import { scanForInjection } from "../injection";
import { finish } from "./brain";
import { clean } from "./retrieval";
import type { BrainChatContext, ChatItem, ChatReply, ChatSection, RetrievedRecord, SourceReport } from "./types";

/**
 * Pre-Construction questions for the Central AI Brain. There is no second chatbot and no model here.
 *
 *   - Exact numbers (prices, counts, availability, areas) come ONLY from structured inventory queries through the user-scoped
 *     PreconRepo. They are never read out of document text.
 *   - Brochure / floor-plan / completion wording comes from full-text retrieval over the user's visible document chunks, and is
 *     always labelled "unverified document statement", with the document title and page as a link.
 *   - Inventory records say whether a person verified them; stale records are called out.
 *   - Missing, conflicting or outdated information is stated. Nothing is estimated, averaged across missing values or invented.
 * Authorization is the repository's (RLS in Supabase, the same rules in the in-memory repo); the Brain only ever reads.
 */

type Topic = "inventory" | "selling_points" | "floor_plans" | "compare" | "completion" | "price_source" | "missing";

export interface PreconQuery {
  topics: Set<Topic>;
  projectIds: string[];
  bedrooms?: number;
  den: boolean;
  minPrice?: number;
  maxPrice?: number;
  availableOnly: boolean;
  availability?: Availability;
  amounts: number[];
  terms: string[];
}

const STRONG = /\b(bed(room)?s?|bdrm|br|studio|condos?|units?|inventory|suites?|floor ?plans?|brochures?|renderings?|pre-?construction|occupancy|selling points?|sq\.? ?ft|square f(ee|oo)t|townhomes?|towns?)\b/;
const WEAK_TOPIC = /\b(prices?|priced|cost|completion|complete[ds]?|selling points?|amenit(y|ies)|highlights?|developer|developments?|projects?|move[- ]?in|closing)\b/;

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const NOISE = new Set(["tell", "about", "me", "what", "which", "show", "give", "list", "any", "there", "does", "do", "can", "you", "please", "project", "projects", "unit", "units", "how", "many", "much", "when", "where", "who", "our", "your", "all", "get", "find"]);

function amountOf(raw: string, suffix: string | undefined, hasDollar: boolean): number | null {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const s = (suffix ?? "").toLowerCase();
  const v = s === "k" || s === "thousand" ? n * 1_000 : s === "m" || s === "million" ? n * 1_000_000 : n;
  // A bare number only counts as a price when it is clearly one (a "$", a k/m suffix, or at least 5 digits). "2" and "1204" are not.
  return hasDollar || s || v >= 50_000 ? v : null;
}

/** All price-looking amounts in the message, with the words just before each one. */
function amountsIn(text: string): { v: number; before: string }[] {
  const out: { v: number; before: string }[] = [];
  const re = /(\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|thousand|million)?\b/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const v = amountOf(m[2], m[3], !!m[1]);
    if (v !== null) out.push({ v, before: text.slice(Math.max(0, m.index - 24), m.index).toLowerCase() });
  }
  return out;
}

const normalName = (n: string) => n.toLowerCase().replace(/^\[demo\]\s*/, "").trim();

/**
 * Decides whether this question is about Pre-Construction and extracts its parameters, deterministically.
 * Returns null when it is not (the normal Brain flow then handles it). `taskIntentMatched`: the task router already recognised it.
 */
export function parsePreconQuery(text: string, projects: PreconProject[], opts: { scoped: boolean; taskIntentMatched: boolean }): PreconQuery | null {
  const t = text.toLowerCase();
  const named = projects.filter((p) => t.includes(normalName(p.name)));
  const strong = STRONG.test(t);
  const weak = WEAK_TOPIC.test(t);
  if (!(opts.scoped || strong || named.length > 0 || (weak && !opts.taskIntentMatched))) return null;

  const topics = new Set<Topic>();
  const bed = /\b(\d|one|two|three|four|five)[ -]?(?:bed(?:room)?s?|br|bdrm)\b/.exec(t);
  const studio = /\bstudios?\b/.test(t);
  const bedrooms = studio ? 0 : bed ? (NUMBER_WORDS[bed[1]] ?? Number(bed[1])) : undefined;
  const amounts = amountsIn(t);
  let minPrice: number | undefined;
  let maxPrice: number | undefined;
  const between = /between\s+\$?\s*([\d,.]+\s*(?:k|m|million|thousand)?)\s+(?:and|to)\s+\$?\s*([\d,.]+\s*(?:k|m|million|thousand)?)/.exec(t);
  if (between) {
    const [a, b] = [between[1], between[2]].map((s) => amountsIn(`$${s}`)[0]?.v);
    if (a !== undefined && b !== undefined) { minPrice = Math.min(a, b); maxPrice = Math.max(a, b); }
  }
  for (const a of amounts) {
    if (between) break;
    if (/(under|below|less than|up to|at most|max(imum)?|no more than|cheaper than|within|budget of|<)\s*$/.test(a.before)) maxPrice = a.v;
    else if (/(over|above|more than|at least|min(imum)?|starting (at|from)|from|>)\s*$/.test(a.before)) minPrice = a.v;
  }
  const availableOnly = /\b(available|unsold|still for sale|for sale)\b/.test(t) && !/\bunavailable\b/.test(t);
  const availability: Availability | undefined = /\breserved\b/.test(t) ? "reserved" : /\bsold( out)?\b/.test(t) && !/\bunsold\b/.test(t) ? "sold" : undefined;

  if (bedrooms !== undefined || minPrice !== undefined || maxPrice !== undefined || /\b(units?|inventory|suites?|condos?|prices?|priced|cost|how much|cheapest|available|availability|sq\.? ?ft|square f(ee|oo)t|townhomes?)\b/.test(t)) topics.add("inventory");
  if (/\b(selling points?|highlights?|amenit(y|ies)|features?|why (buy|invest)|key points?|perks?|what makes)\b/.test(t)) topics.add("selling_points");
  if (/\bfloor ?plans?\b|\blayouts?\b/.test(t)) topics.add("floor_plans");
  if (/\b(compare|comparison|difference|differences|versus|vs\.?)\b/.test(t)) topics.add("compare");
  if (/\b(completion|complete[ds]?|occupancy|move[- ]?in|closing|ready|deliver(y|ed)|finish(ed)?|when (will|is|does))\b/.test(t)) topics.add("completion");
  if (/\b(source|where (does|did|is|do)|which (document|file|doc)|come from|comes from|based on|cite|citation)\b/.test(t) && (amounts.length > 0 || /\b(price|prices|pricing|cost)\b/.test(t))) topics.add("price_source");
  if (/\b(missing|outdated|out of date|stale|incomplete|not (been )?updated|needs? updating|gaps?)\b/.test(t) && /\b(inventory|units?|prices?|pricing|projects?|data)\b/.test(t)) topics.add("missing");
  // "compare" / "floor plans" / "selling points" are about documents and layouts, not an inventory search.
  if (topics.has("floor_plans") || topics.has("compare") || topics.has("selling_points") || topics.has("completion") || topics.has("missing") || topics.has("price_source")) {
    if (bedrooms === undefined && minPrice === undefined && maxPrice === undefined && !/\b(units?|inventory|prices?|available|availability)\b/.test(t)) topics.delete("inventory");
  }

  const names = named.flatMap((p) => normalName(p.name).split(/\s+/));
  const terms = [...new Set(tokens(text).filter((w) => !NOISE.has(w) && !names.includes(w) && !/^\d{1,2}$/.test(w) && w.length > 2))].slice(0, 8);
  return {
    topics, projectIds: named.map((p) => p.id), bedrooms, den: /\b(den|\+ ?den)\b/.test(t), minPrice, maxPrice, availableOnly, availability, amounts: amounts.map((a) => a.v), terms,
  };
}

// ---- answering --------------------------------------------------------------------------------------------------

const MAX_ITEMS = 8;
const LIST_LIMIT = 500;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => iso.slice(0, 10);

const SEARCH_TERMS: Record<string, string> = {
  selling_points: "selling or amenities or features or highlights or included",
  floor_plans: "floor plan or layout",
  completion: "occupancy or completion or closing or completed or delivery or ready",
};

function record(ctx: BrainChatContext, type: RetrievedRecord["type"], ref: string, href: string, label: string, ts: string | null): RetrievedRecord {
  return { source: "preconstruction", type, ref, href, label, timestamp: ts, scope: "organization", provenance: ctx.mode === "demo" ? "demo" : "live", flagged: false, attrs: {} };
}

function snippet(content: string, terms: string[]): string {
  const sentences = content.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const wanted = new Set(terms.flatMap((w) => tokens(w)));
  const hit = sentences.filter((s) => tokens(s).some((w) => wanted.has(w)));
  return clean((hit.length ? hit : sentences).slice(0, 2).join(" "), 280);
}

function inventoryItem(u: InventoryListItem, now: number): ChatItem {
  const bits = [
    u.unit_type ?? bedsLabel(u), `${bedsLabel(u)}, ${bathsLabel(u.bathrooms)}`, areaLabel(u.area_sqft), money(u.price, u.currency), AVAILABILITY_LABEL[u.availability].toLowerCase(),
  ];
  const trust = u.verified_at ? `verified ${day(u.verified_at)}` : "not verified by a person";
  const stale = isStale(u.updated_at, now) ? `; may be outdated (last updated ${day(u.updated_at)})` : "";
  return { text: `${u.project_name}: ${bits.join(" · ")} (${trust}${stale}; source: ${u.source})`, source: "preconstruction", href: `/precon/projects/${u.project_id}`, as_of: u.updated_at };
}

const flaggedOf = (s: string) => scanForInjection(s).suspected;

export async function answerPrecon(ctx: BrainChatContext, q: PreconQuery, scopeProject: PreconProject | null, repo: PreconRepo, message: string): Promise<ChatReply> {
  const now = ctx.now.getTime();
  const [allProjects, docs] = await Promise.all([repo.listProjects(), repo.listDocuments()]);
  const projects = scopeProject ? [scopeProject] : q.projectIds.length ? allProjects.filter((p) => q.projectIds.includes(p.id)) : allProjects;
  const inScope = new Set(projects.map((p) => p.id));
  const docById = new Map<string, PreconDocument>(docs.map((d) => [d.id, d]));
  const projectById = new Map(allProjects.map((p) => [p.id, p]));

  const lines: string[] = [];
  const sections: ChatSection[] = [];
  const gaps: string[] = [];
  const used: RetrievedRecord[] = [];
  let evidence = false;

  const scopeWords = scopeProject ? ` in ${scopeProject.name}` : q.projectIds.length ? ` in ${projects.map((p) => p.name).join(", ")}` : "";
  const topics = q.topics.size ? q.topics : new Set<Topic>(["inventory"]); // an unspecific question about a project falls through to the overview below
  const general = q.topics.size === 0;

  // ---- inventory (structured; the only source of prices, counts and availability) ----
  let units: InventoryListItem[] = [];
  const needUnits = topics.has("inventory") || topics.has("compare") || topics.has("floor_plans") || topics.has("missing") || topics.has("price_source") || topics.has("completion") || general;
  if (needUnits) {
    const raw = await repo.listInventory({
      bedrooms: q.bedrooms, min_price: q.minPrice, max_price: q.maxPrice, availability: q.availability ?? (q.availableOnly ? "available" : undefined), limit: LIST_LIMIT,
    });
    units = raw.filter((u) => inScope.has(u.project_id) && (!q.den || u.den));
  }
  const filtered = q.bedrooms !== undefined || q.minPrice !== undefined || q.maxPrice !== undefined || q.availableOnly || !!q.availability || q.den;

  if (topics.has("inventory") && !general) {
    const desc = [
      q.bedrooms === undefined ? null : q.bedrooms === 0 ? "studio" : `${q.bedrooms}-bedroom`, q.den ? "with a den" : null,
      q.minPrice !== undefined && q.maxPrice !== undefined ? `priced ${money(q.minPrice, "CAD")} to ${money(q.maxPrice, "CAD")}` : q.maxPrice !== undefined ? `priced at or under ${money(q.maxPrice, "CAD")}` : q.minPrice !== undefined ? `priced at or over ${money(q.minPrice, "CAD")}` : null,
      q.availableOnly ? "available" : q.availability,
    ].filter(Boolean).join(", ");
    const by = (a: Availability) => units.filter((u) => u.availability === a).length;
    if (units.length === 0) {
      lines.push(`No inventory records${desc ? ` (${desc})` : ""} are recorded${scopeWords}. That means none are recorded, not that none exist.`);
    } else {
      const trunc = units.length >= LIST_LIMIT ? "at least " : "";
      lines.push(`${trunc}${plural(units.length, "inventory record")}${desc ? ` ${units.length === 1 ? "matches" : "match"} (${desc})` : ""}${scopeWords}: ${by("available")} available, ${by("reserved")} reserved, ${by("sold")} sold, ${by("unknown")} with unknown availability. Counts and prices come from structured inventory records.`);
      const sorted = [...units].sort((a, b) => (a.price === null ? 1 : b.price === null ? -1 : a.price - b.price));
      sections.push({ kind: "facts", heading: `Inventory records (${units.length})`, items: sorted.slice(0, MAX_ITEMS).map((u) => inventoryItem(u, now)), ...(units.length > MAX_ITEMS ? { text: `${units.length - MAX_ITEMS} more not shown. Open the Inventory page to filter and see all.` } : {}) });
      used.push(...units.slice(0, MAX_ITEMS).map((u) => record(ctx, "precon_inventory", u.id, `/precon/projects/${u.project_id}`, u.project_name, u.updated_at)));
      evidence = true;
      const unverified = units.filter((u) => !u.verified_at).length;
      if (unverified > 0) gaps.push(`${plural(unverified, "of these records is", "of these records are")} not verified by a person, so treat them as unconfirmed.`);
      const old = units.filter((u) => isStale(u.updated_at, now)).length;
      if (old > 0) gaps.push(`${plural(old, "record")} not updated in over ${STALE_DAYS} days may be outdated.`);
    }
    if (q.minPrice !== undefined || q.maxPrice !== undefined) gaps.push("Units with no recorded price never match a price question; they are unknown, not cheap.");
    const noInv = projects.filter((p) => !units.some((u) => u.project_id === p.id) && !filtered);
    if (noInv.length > 0) gaps.push(`No inventory is recorded for: ${noInv.map((p) => p.name).join(", ")}.`);
  }

  // ---- layouts (structured comparison) ----
  if ((topics.has("compare") || topics.has("floor_plans")) && units.length > 0) {
    const groups = new Map<string, InventoryListItem[]>();
    for (const u of units) groups.set(bedsLabel(u), [...(groups.get(bedsLabel(u)) ?? []), u]);
    const range = (vals: number[], f: (n: number) => string) => (vals.length === 0 ? "not recorded" : Math.min(...vals) === Math.max(...vals) ? f(vals[0]) : `${f(Math.min(...vals))} to ${f(Math.max(...vals))}`);
    const rows = [...groups.entries()].sort((a, b) => (a[1][0].bedrooms ?? 99) - (b[1][0].bedrooms ?? 99)).map(([label, us]): ChatItem => ({
      text: `${label}: ${plural(us.length, "record")}; area ${range(us.flatMap((u) => (u.area_sqft === null ? [] : [u.area_sqft])), (n) => `${n.toLocaleString("en-CA")} sq ft`)}; price ${range(us.flatMap((u) => (u.price === null ? [] : [u.price])), (n) => money(n, us[0].currency))}`,
      source: "preconstruction",
    }));
    sections.push({ kind: "derived", heading: "Layouts compared (computed from inventory records)", items: rows });
    used.push(...units.slice(0, MAX_ITEMS).map((u) => record(ctx, "precon_inventory", u.id, `/precon/projects/${u.project_id}`, u.project_name, u.updated_at)));
    evidence = true;
  }

  // ---- price source ----
  if (topics.has("price_source")) {
    const matches = q.amounts.length ? units.filter((u) => u.price !== null && q.amounts.includes(u.price)) : [];
    if (q.amounts.length === 0) {
      const bySource = new Map<string, number>();
      for (const u of units) bySource.set(u.source, (bySource.get(u.source) ?? 0) + 1);
      lines.push(bySource.size ? `Prices${scopeWords} come from: ${[...bySource.entries()].map(([s, n]) => `${s} (${plural(n, "record")})`).join("; ")}.` : `No inventory records${scopeWords} are recorded, so no price has a source.`);
    } else if (matches.length === 0) {
      lines.push(`No inventory record${scopeWords} has a price of ${q.amounts.map((a) => money(a, "CAD")).join(" or ")}. A price in a brochure that is not in the inventory records is an unverified document statement, and I do not search documents by amount.`);
    } else {
      lines.push(`${plural(matches.length, "inventory record")} ${matches.length === 1 ? "has" : "have"} that price. Each one lists where it came from.`);
      sections.push({
        kind: "facts", heading: "Where the price comes from",
        items: matches.slice(0, MAX_ITEMS).map((u): ChatItem => {
          const d = u.source_document_id ? docById.get(u.source_document_id) : undefined;
          return {
            text: `${u.project_name}: ${money(u.price, u.currency)} (${u.verified_at ? `verified ${day(u.verified_at)}` : "not verified by a person"}); source: ${u.source}${d ? `, document “${clean(d.title, 80)}”` : u.source_document_id ? ", a document that is no longer available" : ""}`,
            source: "preconstruction", href: d ? `/precon/documents/${d.id}` : `/precon/projects/${u.project_id}`, as_of: u.updated_at,
          };
        }),
      });
      used.push(...matches.slice(0, MAX_ITEMS).map((u) => record(ctx, "precon_inventory", u.id, `/precon/projects/${u.project_id}`, u.project_name, u.updated_at)));
      evidence = true;
    }
  }

  // ---- completion (project record + inventory occupancy + document statements; conflicts are reported) ----
  const structuredYears = new Set<number>();
  if (topics.has("completion")) {
    const facts: ChatItem[] = [];
    for (const p of projects) {
      if (p.expected_completion) structuredYears.add(Number(p.expected_completion.slice(0, 4)));
      const occ = units.filter((u) => u.project_id === p.id && u.expected_occupancy).map((u) => u.expected_occupancy!).sort();
      for (const o of occ) structuredYears.add(Number(o.slice(0, 4)));
      const parts = [
        p.expected_completion ? `project record: expected completion ${p.expected_completion}` : "project record: no completion date recorded",
        occ.length ? `inventory: expected occupancy ${occ[0] === occ[occ.length - 1] ? occ[0] : `${occ[0]} to ${occ[occ.length - 1]}`}` : "inventory: no occupancy dates recorded",
      ];
      facts.push({ text: `${p.name}: ${parts.join("; ")} (last updated ${day(p.updated_at)})`, source: "preconstruction", href: `/precon/projects/${p.id}`, as_of: p.updated_at });
      used.push(record(ctx, "precon_project", p.id, `/precon/projects/${p.id}`, p.name, p.updated_at));
    }
    if (facts.length) { sections.push({ kind: "facts", heading: "Recorded dates (structured records)", items: facts.slice(0, MAX_ITEMS) }); evidence = true; }
    lines.push(projects.some((p) => p.expected_completion) ? `Completion dates${scopeWords} are shown from the project records, which are only as current as their last update.` : `No completion date is recorded${scopeWords}.`);
  }

  // ---- document statements (full-text retrieval; unverified by definition) ----
  const docTopics = ["selling_points", "floor_plans", "completion"].filter((k) => topics.has(k as Topic));
  const wantsDocs = docTopics.length > 0 || topics.has("compare") || general || (topics.has("inventory") && q.terms.length > 0 && !filtered && units.length === 0);
  let hits: SearchHit[] = [];
  if (wantsDocs) {
    const groups = [...docTopics.map((k) => SEARCH_TERMS[k]), ...(docTopics.length === 0 && q.terms.length ? [q.terms.join(" or ")] : [])];
    const query = groups.join(" or ");
    if (query) {
      const raw = await repo.searchChunks(query, { projectId: projects.length === 1 ? projects[0].id : undefined, limit: 12 });
      hits = raw.filter((h) => inScope.has(h.project_id)).slice(0, MAX_ITEMS);
    }
    if (hits.length === 0) {
      lines.push(`No uploaded document${scopeWords} contains a passage about that, so I have nothing to quote and I will not guess.`);
      const noDocs = projects.filter((p) => !docs.some((d) => d.project_id === p.id && d.status === "processed"));
      if (noDocs.length) gaps.push(`No processed documents for: ${noDocs.map((p) => p.name).join(", ")}.`);
    } else {
      const words = q.terms.length ? q.terms : tokens(SEARCH_TERMS[docTopics[0]] ?? "");
      const items = hits.map((h): ChatItem => {
        const d = docById.get(h.document_id);
        const p = projectById.get(h.project_id);
        const text = snippet(h.content, words);
        return {
          text: `“${text}” — ${d ? clean(d.title, 80) : "a document"}${h.page ? `, page ${h.page}` : ""}${p ? ` (${p.name})` : ""}`,
          source: "preconstruction", href: `/precon/documents/${h.document_id}${h.page ? `#p${h.page}` : ""}`, ...(d ? { as_of: d.created_at } : {}),
          ...(flaggedOf(h.content) ? { flagged: true } : {}),
        };
      });
      sections.push({ kind: "facts", heading: `From uploaded documents: unverified statements (${hits.length})`, items });
      used.push(...hits.map((h) => record(ctx, "precon_passage", h.chunk_id, `/precon/documents/${h.document_id}`, docById.get(h.document_id)?.title ?? "document", docById.get(h.document_id)?.created_at ?? null)));
      evidence = true;
      lines.push(`Found ${plural(hits.length, "relevant passage")} in uploaded documents. These are what the documents say; they are not verified records.`);
      const old = hits.filter((h) => { const d = docById.get(h.document_id); return d && d.status === "needs_reprocessing"; }).length;
      if (old) gaps.push(`${plural(old, "passage")} come from documents indexed by an older version of the reader and may be incomplete.`);

      // Conflict check: years in passages about completion against the structured dates.
      if (topics.has("completion")) {
        const docYears = new Map<number, string[]>();
        for (const h of hits) {
          if (!/(occupanc|completion|complete|closing|deliver|ready)/i.test(h.content)) continue;
          for (const m of h.content.matchAll(/\b(20\d{2})\b/g)) docYears.set(Number(m[1]), [...(docYears.get(Number(m[1])) ?? []), docById.get(h.document_id)?.title ?? "a document"]);
        }
        if (structuredYears.size > 0) {
          const disagreeing = [...docYears.entries()].filter(([y]) => !structuredYears.has(y));
          if (disagreeing.length) {
            gaps.push(`Conflict: the records say ${[...structuredYears].sort().join(" / ")}, but ${disagreeing.map(([y, t]) => `“${clean([...new Set(t)][0], 60)}” says ${y}`).join("; ")}. I can't tell which is current. Please confirm with the developer.`);
          }
        } else if (docYears.size > 0) gaps.push("The only completion information is in documents (unverified); no project record or inventory record confirms it.");
      }
    }
  }

  // ---- missing / outdated ----
  if (topics.has("missing")) {
    const items: ChatItem[] = [];
    for (const p of projects) {
      const pu = units.filter((u) => u.project_id === p.id);
      const issues: string[] = [];
      if (pu.length === 0) issues.push("no inventory recorded");
      else {
        const newest = pu.map((u) => u.updated_at).sort().at(-1)!;
        if (isStale(newest, now)) issues.push(`inventory last updated ${day(newest)} (over ${STALE_DAYS} days ago)`);
        const noPrice = pu.filter((u) => u.price === null).length;
        if (noPrice) issues.push(`${plural(noPrice, "unit")} without a price`);
        const unknown = pu.filter((u) => u.availability === "unknown").length;
        if (unknown) issues.push(`${plural(unknown, "unit")} with unknown availability`);
      }
      if (!docs.some((d) => d.project_id === p.id && d.status === "processed")) issues.push("no processed documents");
      if (issues.length) items.push({ text: `${p.name}: ${issues.join("; ")}`, source: "preconstruction", href: `/precon/projects/${p.id}`, as_of: p.updated_at });
      used.push(record(ctx, "precon_project", p.id, `/precon/projects/${p.id}`, p.name, p.updated_at));
    }
    lines.push(items.length ? `${plural(items.length, "project")} of ${projects.length} ${items.length === 1 ? "has" : "have"} missing or possibly outdated information.` : `Nothing is missing or stale among the ${plural(projects.length, "project")} checked. This only checks what is recorded; it cannot know what is not.`);
    if (items.length) sections.push({ kind: "facts", heading: `Needs attention (${items.length})`, items: items.slice(0, MAX_ITEMS) });
    evidence = true;
  }

  // ---- general: project overview ----
  if (general) {
    const items = projects.slice(0, MAX_ITEMS).map((p): ChatItem => {
      const pu = units.filter((u) => u.project_id === p.id);
      return {
        text: `${p.name}: ${PROJECT_STATUS_LABEL[p.status]}${p.developer ? `, ${p.developer}` : ""}${p.city ? `, ${p.city}` : ""}; expected completion ${p.expected_completion ?? "not recorded"}; ${pu.length ? `${plural(pu.length, "inventory record")} (${pu.filter((u) => u.availability === "available").length} available)` : "no inventory recorded"}`,
        source: "preconstruction", href: `/precon/projects/${p.id}`, as_of: p.updated_at,
      };
    });
    if (items.length) {
      sections.unshift({ kind: "facts", heading: `Projects (${projects.length})`, items });
      used.push(...projects.slice(0, MAX_ITEMS).map((p) => record(ctx, "precon_project", p.id, `/precon/projects/${p.id}`, p.name, p.updated_at)));
      evidence = true;
      lines.unshift(`${plural(projects.length, "project")}${scopeWords || " you can see"}.`);
    } else lines.unshift("There are no projects to answer from.");
  }

  void message;
  if (gaps.length) sections.push({ kind: "missing", heading: "Gaps and caveats", items: gaps.map((text): ChatItem => ({ text })) });

  const stamps = used.map((r) => r.timestamp).filter((s): s is string => !!s).sort();
  const report: SourceReport = {
    id: "preconstruction", label: "Pre-Construction (projects, inventory, documents)", state: ctx.mode === "demo" ? "demo" : "live",
    detail: "Projects, inventory records and uploaded-document text this user is allowed to see. Prices and counts come from inventory records; document passages are unverified.",
    count: used.length, ...(stamps.length ? { as_of: stamps[stamps.length - 1] } : {}),
  };
  return finish(ctx, { intent: "preconstruction", text: lines.join("\n"), sections, sources: [report], used, evidence });
}

export function notConnected(ctx: BrainChatContext): ChatReply {
  return finish(ctx, {
    intent: "preconstruction", text: "Pre-Construction is not connected to this environment, so I did not search any projects, inventory or documents and have nothing to report.",
    sources: [{ id: "preconstruction", label: "Pre-Construction (projects, inventory, documents)", state: "unavailable", reason: "not_connected", detail: "No Pre-Construction data connection exists here." }],
  });
}

export function projectNotFound(ctx: BrainChatContext): ChatReply {
  return finish(ctx, { intent: "preconstruction", text: "I can't find that project, or you don't have access to it, so I did not answer from it." });
}

export const isProjectId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
