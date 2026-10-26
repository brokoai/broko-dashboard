// In-memory text search with the same semantics as the database function precon_search_chunks (websearch_to_tsquery + ts_rank_cd):
// words are AND-ed inside a group, the word "or" separates alternative groups, stop words are ignored, and a plural "s" is
// ignored. Used by the in-memory repository (demo and tests). The Supabase repository sends the same query string to Postgres.

const STOP = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is", "it", "of", "on", "that", "the", "this", "to", "was", "were", "will", "with"]);

export function stem(w: string): string {
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

/** "pool or gym" => [["pool"], ["gym"]]; "two bedroom lake" => [["two","bedroom","lake"]]. */
export function parseQuery(query: string): string[][] {
  return query.split(/\s+or\s+/i).map((g) => tokens(g)).filter((g) => g.length > 0);
}

/** 0 = no match. Otherwise the number of query-word occurrences in the best matching group (higher ranks first). */
export function scoreText(text: string, groups: string[][]): number {
  if (groups.length === 0) return 0;
  const bag = new Map<string, number>();
  for (const t of tokens(text)) bag.set(t, (bag.get(t) ?? 0) + 1);
  let best = 0;
  for (const g of groups) {
    if (!g.every((t) => bag.has(t))) continue;
    best = Math.max(best, g.reduce((n, t) => n + (bag.get(t) ?? 0), 0));
  }
  return best;
}
