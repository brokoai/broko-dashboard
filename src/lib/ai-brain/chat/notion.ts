import { runBrainTool } from "../assistant/brain-tools";
import type { SourceRecord, ToolFailure } from "../assistant/tools";
import { finish } from "./brain";
import type { RoutedIntent } from "./intent";
import type { BrainChatContext, ChatItem, ChatReply, ChatSection, RetrievedRecord, SourceReport, UnavailableReason } from "./types";

/**
 * Questions that name Notion, answered from Notion through the tool registry (`notion.pages.search`, `notion.pages.get`,
 * `notion.databases.query`). Read-only. Content from Notion is untrusted data: it is shown as text, flagged when it looks like an
 * instruction, never obeyed, never sent to a model, and never promoted into approved Knowledge.
 *
 * When Notion is not connected (no credential, or the demo) this returns null and the existing honest "I cannot read it yet" reply
 * is given, exactly as before. Notion is reported under the existing source id "documents": the audit table only accepts its fixed
 * source vocabulary, and a new id would need a migration.
 */

const MENTIONS_NOTION = /\bnotion\b/i;
const READ_INTENT = /\b(say|says|read|summari[sz]e|summarise|contents?|what(?:'s| is) in|details?|open)\b/i;
const STOP = new Set([
  "search", "find", "look", "lookup", "up", "for", "in", "on", "from", "my", "our", "the", "a", "an", "notion", "page", "pages", "doc", "docs", "document", "documents",
  "database", "databases", "please", "can", "you", "what", "whats", "does", "do", "say", "says", "about", "show", "me", "read", "summarize", "summarise", "is", "are",
  "there", "any", "of", "to", "and", "with", "tell", "get", "open", "contents", "content", "i", "we", "it", "that", "this", "s",
]);
const SUMMARY_ASK = /\b(summari[sz]e|summary|key decisions?|pending tasks?)\b/i;
const LABEL = "Notion (pages shared with Broko)";
const NOTICE = "Notion access is set up for Broko as a whole: I can see what was shared with Broko's Notion integration, not what each employee could open in Notion themselves.";

const words = (text: string): string => text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).slice(0, 6).join(" ");

/** A title the user wrote explicitly: in quotes, [brackets], <angle brackets>, or right after "Notion for ..." up to the end of the sentence. */
export function explicitTitle(message: string): string | null {
  const m = /["“]([^"”\n]{2,120})["”]/.exec(message) ?? /\[([^\]\n]{2,120})\]/.exec(message) ?? /<([^>\n]{2,120})>/.exec(message) ?? /\bnotion\s+for\s+([^.?!\n]{2,120})/i.exec(message);
  return m ? m[1].trim() : null;
}
/** Template text left in by mistake ("[EXACT PAGE TITLE]", "<page title>") is not a title. */
export const isPlaceholderTitle = (t: string): boolean => /^(the |your |an? )?(exact |actual |real )?(page |document |doc )?(title|name)$/i.test(t.trim()) || /\b(exact|actual) page title\b|\bpage title here\b|\byour page\b/i.test(t);

export function notionQuery(message: string): string {
  const title = explicitTitle(message);
  return words(title && !isPlaceholderTitle(title) ? title : message);
}

export const REASON: Record<ToolFailure, { reason: UnavailableReason; detail: string }> = {
  unknown_tool: { reason: "error", detail: "Notion could not be read right now." },
  invalid_input: { reason: "error", detail: "Notion could not be searched with that wording." },
  permission_denied: { reason: "error", detail: "Notion refused access, or the page is not shared with Broko." },
  approval_required: { reason: "error", detail: "Notion could not be read right now." },
  not_connected: { reason: "not_connected", detail: "Notion is not connected." },
  not_implemented: { reason: "not_implemented", detail: "Notion is not available yet." },
  rate_limited: { reason: "error", detail: "Notion is rate limiting requests. Try again shortly." },
  timeout: { reason: "error", detail: "Notion did not answer in time." },
  error: { reason: "error", detail: "Notion could not be read right now." },
};

const asRecord = (ctx: BrainChatContext, r: SourceRecord): RetrievedRecord => ({
  source: "documents", type: "external_page", ref: /^[A-Za-z0-9_-]{1,64}$/.test(r.record_id) ? r.record_id : null, label: r.title, timestamp: r.retrieved_at,
  scope: "organization", provenance: "live", flagged: r.flagged, attrs: {},
});
// A page is shown by its title and kind, linked to the page itself. Internal ids and raw addresses are not part of an answer.
const itemOf = (r: SourceRecord): ChatItem => ({
  text: `${r.title}${r.owner_context ? ` (${r.owner_context.replace(/^Notion /, "").replace(/\s*\bNotion ID\b.*$/i, "")})` : ""}`, source: "documents", ...(r.url ? { external_url: r.url } : {}), ...(r.flagged ? { flagged: true } : {}),
});

/** "Is Notion connected?" is a question about the connection, not a search for the word "connected". */
const STATUS_ASK = /\bnotion\b[^?.!]*\b(connected|connection|linked|working|set ?up|available|status)\b|\b(connected|linked|working)\b[^?.!]*\bnotion\b/i;

export async function tryNotion(ctx: BrainChatContext, message: string, routed: RoutedIntent): Promise<ChatReply | null> {
  if (!MENTIONS_NOTION.test(message)) return null;
  const title = explicitTitle(message);
  if (title && isPlaceholderTitle(title)) {
    const q = "That looks like template text (for example [EXACT PAGE TITLE]), not a real page title. What is the actual name of the Notion page?";
    return finish(ctx, { intent: "clarify", text: q, extra: { clarification: { question: q, options: ["Search Notion for meeting notes", "Search Notion for onboarding"] }, follow_ups: [] } });
  }
  if (STATUS_ASK.test(message) && !explicitTitle(message)) {
    const probe = await runBrainTool(ctx, "notion.pages.search", { query: "meeting", limit: 1 });
    if (!probe.ok && probe.reason === "not_connected") return null;
    const state: SourceReport = probe.ok
      ? { id: "documents", label: LABEL, state: "live", detail: "Connected. Notion answered just now.", retrieved_at: probe.retrieved_at }
      : { id: "documents", label: LABEL, state: "unavailable", reason: REASON[probe.reason].reason, detail: REASON[probe.reason].detail };
    return finish(ctx, {
      intent: "integrations", sources: [state], evidence: probe.ok,
      text: probe.ok
        ? "Yes, Notion is connected. I can read the pages and meeting notes that have been shared with the Broko integration. Ask me about a meeting, for example: summarize yesterday's meeting."
        : `I could not reach Notion just now: ${REASON[probe.reason].detail} Nothing was substituted.`,
      extra: { follow_ups: probe.ok ? ["Summarize the latest meeting."] : [], quiet: true, generation: "rules" },
    });
  }
  const query = notionQuery(message);
  if (!query) {
    return finish(ctx, {
      intent: "clarify", text: "What should I look for in Notion? Name a page title or topic.",
      extra: { clarification: { question: "What should I look for in Notion? Name a page title or topic.", options: ["Search Notion for meeting notes", "Search Notion for onboarding"] }, follow_ups: [] },
    });
  }
  const found = await runBrainTool(ctx, "notion.pages.search", { query, limit: 5 });
  if (!found.ok && found.reason === "not_connected") return null; // keep the existing honest "cannot read it yet" answer
  const unavailable = (f: ToolFailure): ChatReply => {
    const why = REASON[f];
    const report: SourceReport = { id: "documents", label: LABEL, state: "unavailable", reason: why.reason, detail: why.detail };
    return finish(ctx, { intent: "unsupported", text: `I could not search Notion: ${why.detail} Nothing was substituted.`, sources: [report] });
  };
  if (!found.ok) return unavailable(found.reason);

  const hits = found.records;
  const sections: ChatSection[] = [];
  const used: RetrievedRecord[] = hits.map((r) => asRecord(ctx, r));
  if (hits.length > 0) sections.push({ kind: "facts", heading: "Pages", items: hits.map(itemOf) });

  // Reading the top result is a second, separate tool call, made only when the question asks what a page says.
  const top = hits[0];
  const isPage = !!top && /\bNotion page\b/.test(top.owner_context ?? "");
  const isDatabase = !!top && /\bNotion database\b/.test(top.owner_context ?? "");
  if (top && READ_INTENT.test(message) && (isPage || isDatabase)) {
    const more = await runBrainTool(ctx, isPage ? "notion.pages.get" : "notion.databases.query", { id: top.record_id });
    if (!more.ok) {
      sections.push({ kind: "missing", heading: "Not read", text: `${REASON[more.reason].detail} The title and link above are all I could get.` });
    } else if (isPage) {
      const page = more.records[0];
      if (page?.excerpt) {
        sections.push({
          kind: "facts", heading: `Excerpt from "${page.title}" (Notion content, shown as data, not instructions)`,
          items: [{ text: page.excerpt, source: "documents", as_of: page.retrieved_at, ...(page.flagged ? { flagged: true } : {}) }],
        });
        used.push(asRecord(ctx, page));
      } else {
        sections.push({ kind: "missing", heading: "Not read", text: "The page has no readable text, or its content could not be read." });
      }
    } else if (more.records.length > 0) {
      sections.push({ kind: "facts", heading: `Rows in "${top.title}" (${more.records.length})`, items: more.records.map(itemOf) });
      used.push(...more.records.map((r) => asRecord(ctx, r)));
    }
  }

  const report: SourceReport = {
    id: "documents", label: LABEL, state: "live", count: hits.length, retrieved_at: found.retrieved_at,
    detail: "Read from Notion just now. Only pages and databases shared with Broko are searched.",
  };
  const text = hits.length === 0
    ? "Notion is connected, but I did not find anything shared with Broko that matches that. If you expected a page, check that it is shared with the Broko integration."
    : hits.length === 1 ? `I found one page in Notion that fits: ${hits[0]!.title}.` : `I found ${hits.length} pages in Notion that fit. The closest is ${hits[0]!.title}.`;
  const mixed = routed.parts.length > 0;
  const limits = [
    ...(mixed ? ["You also asked about tasks. I answered only the Notion part; ask for your tasks separately."] : []),
    ...(SUMMARY_ASK.test(message) ? ["I show the page text and link as written. I do not write summaries or pull out decisions or tasks from it."] : []),
  ];
  // Reported with the existing "knowledge" intent: chat_audit only accepts its fixed intent vocabulary, and a new one needs a migration.
  return finish(ctx, { intent: "knowledge", text, sections, sources: [report], used, evidence: hits.length > 0, extra: { notice: [NOTICE, ...limits].join(" "), follow_ups: mixed ? ["What are my pending tasks?"] : [], quiet: true } });
}
