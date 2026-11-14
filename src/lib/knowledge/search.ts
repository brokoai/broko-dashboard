import { tokens } from "@/lib/precon/search";
import type { KnowledgeItem, KnowledgeKind } from "./types";

// Ranking of approved knowledge for a question. Plain keyword matching over title, topic and body: no model, no embeddings, no
// new infrastructure. A question must cover most of its significant words before anything is returned, so a vague question does
// not pull in unrelated knowledge.

const NOISE = new Set([
  "tell", "me", "about", "what", "which", "show", "give", "list", "any", "there", "does", "doe", "do", "can", "you", "please", "how", "many", "much", "when",
  "where", "who", "our", "your", "all", "get", "find", "we", "i", "should", "would", "could", "did", "know", "us", "my", "company", "organization",
  "organisation", "team", "decide", "decided", "decision", "procedure", "process", "policy", "policie", "guideline", "rule", "standard", "convention",
  "correction", "note", "knowledge", "base", "approved", "current", "currently", "latest", "regarding", "around", "say", "says", "use", "using", "done", "handle",
]);

/** Words that say what KIND of knowledge is wanted. They help ranking and are never required to match. */
const KIND_HINT: [KnowledgeKind, RegExp][] = [
  ["procedure", /\b(procedures?|process(es)?|how (do|should|to)|steps?|guidelines?|standards?|conventions?|policy|policies)\b/i],
  ["decision", /\b(decid(e|ed|ing)|decisions?|agreed|resolved)\b/i],
  ["correction", /\b(corrections?|corrected|actually|instead)\b/i],
  ["project_note", /\b(project notes?|notes? (on|about|for))\b/i],
];

export function significantTerms(query: string): string[] {
  return [...new Set(tokens(query).filter((t) => !NOISE.has(t) && t.length > 1))];
}

export function kindHints(query: string): KnowledgeKind[] {
  return KIND_HINT.filter(([, re]) => re.test(query)).map(([k]) => k);
}

/** Equal, or the same word with a different ending (approve / approver / approval). Needs a shared stem of at least five letters. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i >= Math.max(5, n - 2);
}
const hasWord = (set: ReadonlySet<string>, t: string): boolean => set.has(t) || (t.length >= 5 && [...set].some((w) => sameWord(w, t)));

export interface KnowledgeMatch { item: KnowledgeItem; score: number; matched: number }

export function searchKnowledge(items: readonly KnowledgeItem[], query: string, limit = 5): KnowledgeMatch[] {
  const terms = significantTerms(query);
  if (terms.length === 0) return [];
  const need = Math.max(1, Math.ceil(terms.length * 0.6));
  const hints = kindHints(query);
  const out: KnowledgeMatch[] = [];
  for (const item of items) {
    const head = new Set([...tokens(item.title), ...tokens(item.topic ?? "")]);
    const body = new Set(tokens(item.body));
    let matched = 0, score = 0;
    for (const t of terms) {
      if (hasWord(head, t)) { matched++; score += 3; } else if (hasWord(body, t)) { matched++; score += 1; }
    }
    if (matched < need) continue;
    if (hints.includes(item.kind)) score += 1;
    out.push({ item, score, matched });
  }
  return out
    .sort((a, b) => b.score - a.score || (b.item.reviewed_at ?? "").localeCompare(a.item.reviewed_at ?? "") || a.item.id.localeCompare(b.item.id))
    .slice(0, limit);
}
