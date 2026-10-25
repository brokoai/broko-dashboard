import { scanForInjection } from "../injection";
import type { ActionKind, ChatIntent, SourceId } from "./types";

/**
 * Deterministic intent router. This is keyword matching, NOT language understanding: it can answer a fixed set of
 * questions about data the Brain can actually read, ask a clarifying question when a request is vague, and say plainly
 * when a question is outside what it supports. It never guesses at an intent it did not match.
 */

export type DataIntent = Extract<ChatIntent, "attention" | "pending_tasks" | "today" | "overdue" | "upcoming" | "priority" | "owners" | "notifications" | "ai_inbox" | "integrations" | "sources">;
export type PriorityFilter = "urgent" | "high_or_urgent" | "medium" | "low";

export interface RoutedIntent {
  intent: ChatIntent;
  /** For data questions: every intent to answer, in order (a question may span several sources). */
  parts: DataIntent[];
  /** Pattern ids from the injection tripwire (ids only, never message text). */
  signals: string[];
  priority?: PriorityFilter;
  action?: ActionKind;
  /** Message-like sources the user mentioned that the Brain cannot read (email, Teams, WhatsApp, calendar, CRM, documents). */
  domains: SourceId[];
  clarify?: { question: string; options: string[] };
}

export const CLARIFY_OPTIONS = [
  "What needs my attention?",
  "Summarize my pending tasks.",
  "What happened today?",
  "Which integrations are connected?",
];

const ACTION_VERBS =
  "create|add|assign|reassign|delete|remove|cancel|complete|close|reopen|mark|send|reply|respond|email|message|forward|approve|reject|schedule|book|update|change|set|reschedule|snooze|edit|move|archive|connect|disconnect|reset|invite|grant|revoke";
// An imperative ("assign this to Sam", "can you approve the email"), not a question about data ("tasks I need to complete").
const ACTION_RE = new RegExp(
  `^\\s*(?:please\\s+)?(?:(?:can|could|would|will) you\\s+(?:please\\s+)?|i (?:want|need|'d like) you to\\s+|go ahead and\\s+)?(${ACTION_VERBS})\\b`,
  "i",
);

export function actionKind(text: string): ActionKind {
  const m = ACTION_RE.exec(text);
  const verb = (m?.[1] ?? "").toLowerCase();
  const t = text.toLowerCase();
  if (/^(send|reply|respond|email|message|forward)$/.test(verb)) return "send_message";
  if (/^(delete|remove)$/.test(verb)) return "delete_record";
  if (/^(approve|reject)$/.test(verb)) return "review_ai_message";
  if (/^(schedule|book|reschedule)$/.test(verb) && !/\btasks?\b/.test(t)) return "schedule_event";
  if (/^(connect|disconnect|reset|invite|grant|revoke)$/.test(verb)) return "change_configuration";
  if (/^(assign|reassign)$/.test(verb)) return "assign_task";
  if (/^(create|add)$/.test(verb)) return /\b(email|message|reply)\b/.test(t) ? "send_message" : "create_task";
  return "update_task";
}

const MATCHERS: [DataIntent, RegExp][] = [
  ["sources", /\b(sources?|what can you (read|see|access)|which (data|systems|apps)|where .{0,20}(data|information))\b/],
  ["integrations", /\b(integrations?|connected|connections?|linked|synced?|syncing)\b/],
  ["overdue", /\b(overdue|follow[- ]?ups?|past due|late|behind schedule|missed deadlines?)\b/],
  ["upcoming", /\b(upcoming|due (soon|this week|next week|tomorrow|in the next)|next (7|seven) days|coming up|due dates?)\b/],
  ["priority", /\b(urgent|high[- ]priority|low[- ]priority|medium[- ]priority|priorit(y|ies)|important|critical)\b/],
  ["owners", /\b(who (is|are|has|owns?|got)|owners?|assignees?|responsible|workload|per person|by person)\b|\bassigned to (?!me\b|myself\b)/],
  ["attention", /\b(attention|focus on|what should i|needs? (me|my))\b/],
  ["notifications", /\b(notifications?|alerts?|unread)\b/],
  ["ai_inbox", /\b(ai inbox|inbox|review queue|awaiting review|pending (review|approval)s?)\b/],
  ["today", /\b(today|happened|recent(ly)?|activity|latest|what'?s new|(operational|recent|latest) updates?|events?)\b/],
  ["pending_tasks", /\b(pending|open|outstanding|to-?dos?|task list|my tasks|tasks?)\b/],
];
const TASK_SPECIFIC = new Set<DataIntent>(["overdue", "upcoming", "priority", "owners", "attention"]);

const SUMMARY_RE = /\b(summary|summari[sz]e (everything|all|my day|it all)|overview|brief(ing)?|catch me up|round[- ]?up|everything|big picture|how('s| is) (my|the) day)\b/;
export const SUMMARY_PARTS: DataIntent[] = ["pending_tasks", "overdue", "today", "notifications", "ai_inbox"];
const MAX_PARTS = 4;

const DOMAIN_MATCHERS: [SourceId[], RegExp][] = [
  [["email"], /\b(e-?mails?|mail|outlook|gmail)\b/],
  [["whatsapp"], /\b(whatsapp|text messages?|texts)\b/],
  [["teams"], /\b(teams|chats?|channels?)\b/],
  [["email", "teams", "whatsapp"], /\b(messages?|dms?|conversations?)\b/],
  [["calendar"], /\b(calendar|meetings?|appointments?)\b/],
  [["crm"], /\b(crm|leads?|customers?|clients?|deals?)\b/],
  [["documents"], /\b(documents?|files?|contracts?|onedrive|attachments?)\b/],
];

const GREETING_RE = /^\s*(hi|hello|hey|help|thanks?|thank you|what can you do|who are you)\b/i;
const PRONOUN_RE = /\b(that|this|it|those|them|him|her|he|she|they|the same|again|more|previous|earlier|above)\b/;
const VAGUE_RE = /^\s*(status|update|updates|anything|something|stuff|things|news|what'?s up|how is it going|any news)\W*$/i;

const none = (over: Partial<RoutedIntent>): RoutedIntent => ({ intent: "unsupported", parts: [], signals: [], domains: [], ...over });

export function routeIntent(raw: string): RoutedIntent {
  const text = raw.trim().toLowerCase();

  const scan = scanForInjection(raw);
  if (scan.suspected) return none({ intent: "blocked", signals: scan.matches });

  if (ACTION_RE.test(text)) return none({ intent: "action_request", action: actionKind(text) });

  if (GREETING_RE.test(text)) return none({ intent: "help" });

  const wantsSummary = SUMMARY_RE.test(text);
  const scrubbed = text.replace(/\bassigned to (me|myself)\b/g, "my tasks");
  let parts = MATCHERS.filter(([, re]) => re.test(scrubbed)).map(([id]) => id);
  if (parts.includes("sources")) parts = parts.filter((p) => p !== "integrations");
  if (parts.some((p) => TASK_SPECIFIC.has(p))) parts = parts.filter((p) => p !== "pending_tasks");
  if (wantsSummary && parts.length === 0) parts = [...SUMMARY_PARTS];
  parts = parts.slice(0, wantsSummary ? SUMMARY_PARTS.length : MAX_PARTS);

  const aiInboxAsked = parts.includes("ai_inbox");
  const domains = [...new Set(DOMAIN_MATCHERS.filter(([, re]) => re.test(text)).flatMap(([ids]) => ids))].filter((d) => !(aiInboxAsked && d === "email"));

  let priority: PriorityFilter | undefined;
  if (parts.includes("priority")) {
    priority = /\b(urgent|critical)\b/.test(text) ? "urgent" : /\bhigh\b/.test(text) ? "high_or_urgent" : /\blow\b/.test(text) ? "low" : /\bmedium\b/.test(text) ? "medium" : "high_or_urgent";
  }

  if (parts.length > 0) {
    return { intent: parts.length === 1 ? parts[0] : "summary", parts, signals: [], priority, domains };
  }

  if (domains.length > 0) return none({ intent: "unsupported", domains });

  const words = text.split(/\s+/).filter(Boolean);
  if (VAGUE_RE.test(text) || words.length <= 2 || PRONOUN_RE.test(text) && words.length <= 8) {
    const pronoun = PRONOUN_RE.test(text);
    return none({
      intent: "clarify",
      clarify: {
        question: pronoun
          ? "I don't keep earlier messages as context, so I can't tell what you are referring to. Which do you mean?"
          : "I'm not sure what you want to know. Do you mean tasks, activity, notifications, the AI Inbox or integrations?",
        options: CLARIFY_OPTIONS,
      },
    });
  }
  return none({ intent: "unsupported" });
}
