/**
 * Word-by-word matching for the memory search (K1/K2 fix). The model phrases a query the way the user asked ("Halcyon warehouse slot"), while a stored record
 * is named and described in its own words ("Confirm warehouse slot"). Matching the WHOLE phrase as one substring finds nothing there, and an empty search
 * ends in the generic reply. Matching the words, ranked by how many of them occur and capped by the caller's limit, finds the record without hiding
 * anything: every statement still needs a citation to a segment that was actually delivered, and authorization is untouched (this only chooses WHICH of
 * the already-permitted rows are returned first).
 */

/** Words too common to identify a record. A short fixed list: this is a recall aid, not language understanding. */
const STOP = new Set([
  "the", "and", "for", "are", "what", "who", "does", "did", "say", "says", "about", "our", "stored", "notes", "note", "from", "with", "that", "this", "was",
  "how", "when", "where", "which", "tell", "show", "find",
]);

export const MAX_QUERY_TOKENS = 6;

/** The searchable words of a query: lower-case letters and digits (plus `. -`; `_` and `%` are separators, so no LIKE wildcard ever reaches the database and the adapter and the in-memory twin agree), at least 3 characters, no stop words, no repeats, at most 6. Empty = use the whole phrase. */
export function queryTokens(query: string): string[] {
  const words = query.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N} .-]/gu, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, MAX_QUERY_TOKENS);
}

/** How many of the words occur in the text. The ranking score: more matched words first. */
export function tokenHits(words: readonly string[], text: string): number {
  const t = text.toLowerCase();
  let n = 0;
  for (const w of words) if (t.includes(w)) n += 1;
  return n;
}

/** The words to search with: the tokens, or the whole (cleaned) phrase when no token survives, or none when there is no query. */
export function searchWords(query: string | undefined): string[] {
  if (!query) return [];
  const tokens = queryTokens(query);
  if (tokens.length) return tokens;
  const whole = query.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N} .-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return whole ? [whole] : [];
}

/** Stable sort: more matched words first; rows with equal scores keep the order they came in (newest first). */
export function rankByHits<T>(rows: readonly T[], words: readonly string[], text: (row: T) => string): T[] {
  if (words.length < 2) return [...rows];
  return rows.map((row, i) => ({ row, i, hits: tokenHits(words, text(row)) })).sort((a, b) => b.hits - a.hits || a.i - b.i).map((x) => x.row);
}

/** Work limits of one search (database side): rows per page, pages per search. Reaching the last page full is reported as `budget_reached`, never as 'no match'. */
export const SEARCH_PAGE_SIZE = 200;
export const MAX_SEARCH_PAGES = 10;
/** Endpoint-name lookups for relationship search, and how many ids go into ONE request (50 ids ~ 4 KB of URL, well under any gateway limit). */
export const MAX_ENDPOINT_IDS = 1000;
export const ENDPOINT_BATCH = 50;

/**
 * Incremental top-K: merge the next page into the best rows so far. Rows already kept come first, so among equal scores the earlier (newer) row wins, exactly as
 * one big stable sort would. Memory stays at `limit + one page`, however many rows are scanned.
 */
export function mergeTop<T>(kept: readonly T[], page: readonly T[], words: readonly string[], text: (row: T) => string, limit: number): T[] {
  return rankByHits([...kept, ...page], words, text).slice(0, limit);
}

/** True when nothing later in the scan can displace the kept rows: the list is full and every kept row matches ALL the words. */
export function cannotImprove<T>(kept: readonly T[], words: readonly string[], text: (row: T) => string, limit: number): boolean {
  return kept.length >= limit && kept.every((r) => tokenHits(words, text(r)) === words.length);
}
