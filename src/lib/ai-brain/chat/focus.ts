import type { ChatFocus } from "./types";

/**
 * The conversation focus arrives from the browser, so it is untrusted: this accepts only the exact shape the server itself produces, with
 * every field bounded and plain, and drops anything else. A valid-looking focus still grants nothing: the meeting it names must be found again
 * through the normal authorized search before anything is read.
 */
const OUTPUTS = ["summary", "decisions", "action_items", "content", "all"] as const;
const ID = /^[A-Za-z0-9-]{8,64}$/;
const STARTS = /^\d{4}-\d{2}-\d{2}(T[0-9:.]{4,20}(Z|[+-]\d{2}:\d{2})?)?$/;
const TERM = /^[a-z0-9][a-z0-9-]{2,29}$/;

export function parseFocus(raw: unknown): ChatFocus | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "meeting" || typeof r.id !== "string" || !ID.test(r.id)) return undefined;
  const output = OUTPUTS.find((o) => o === r.output);
  if (!output) return undefined;
  const title = typeof r.title === "string" ? r.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : "";
  const startsAt = typeof r.starts_at === "string" && STARTS.test(r.starts_at) && !Number.isNaN(Date.parse(r.starts_at)) ? r.starts_at : undefined;
  const topics = Array.isArray(r.topics) ? r.topics.filter((t): t is string => typeof t === "string" && TERM.test(t)).slice(0, 4) : [];
  return { kind: "meeting", id: r.id, title: title || "Meeting", ...(startsAt ? { starts_at: startsAt } : {}), output, topics };
}

/** The user's own last few questions, from the open chat tab. Only ever shown to the interpreter as data; bounded and stripped of control characters. */
export function parseHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300))
    .filter((q) => q.length > 0)
    .slice(-3);
}
