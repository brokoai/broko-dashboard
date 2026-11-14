import { dayKey, isActive, isOverdueOn } from "@/lib/dates";
import { buildApproval } from "./approval";
import { tryKnowledge, withProjectKnowledge } from "./knowledge";
import { tryMeeting } from "./meetings";
import { tryNotion } from "./notion";
import { answerPrecon, isProjectId, notConnected, parsePreconQuery, projectNotFound } from "./precon";
import { isAnswerFeedback, routeIntent, type DataIntent, type PriorityFilter, type RoutedIntent } from "./intent";
import { retrieveViaTools, runBrainTool, standardRegistry } from "../assistant/brain-tools";
import type { AgentOutcome } from "./tool-agent";
import { prepareProposal, type ProposalType } from "../assistant/proposals";
import { FOLLOW_UPS, MAX_MESSAGE_CHARS, SUGGESTED_PROMPTS } from "./prompts";
import { isCanonical, type InterpretContext } from "./interpreter";
import {
  ADAPTERS, LABELS, MESSAGE_SOURCES, recordText, unreadableSources, type Outcomes, type ReadableSource,
} from "./retrieval";
import type { ActionProposal } from "../assistant/proposals";
import type { ActionKind, BrainChatContext, ChatIntent, ChatItem, ChatReply, ChatSection, Grounding, RetrievedRecord, SourceId, SourceReport } from "./types";

export class ChatInputError extends Error {}
export { SUGGESTED_PROMPTS };

const DEMO_NOTICE = "Demo mode: every answer here comes from synthetic sample data, not operational data.";
const MIXED_NOTICE = "Part of this answer is demo data. The Notion part is live.";
const MAX_ITEMS = 5;
const UPCOMING_DAYS = 7;
const CAPABILITIES =
  "I answer a fixed set of read-only questions about tasks (pending, overdue, upcoming, by priority, by owner), the activity feed, notifications, AI Inbox status and integration status, and I can combine them. I am not a general-purpose AI, I never change anything, and I only report what I actually read.";

/** Fixed wording, no record text: a suggestion, kept visibly apart from the recorded facts above it. */
const RECOMMEND: ChatSection = { kind: "recommendation", heading: "Suggested next step (my suggestion, not recorded data)", text: "Start with the oldest overdue item, then the high-priority ones. Check the due dates yourself before acting." };

/** The reply to a complaint about an earlier answer. Fixed wording: it reads no data, claims nothing about what went wrong, and never says it was or was not right. */
const FEEDBACK_REPLY =
  "I'm sorry that answer didn't help. I can only answer from the data and meeting notes I can read, and I can get a question wrong, for example by picking the wrong meeting when more than one fits the date, or by misreading a typo. From this message alone I can't tell what went wrong. Tell me which question you asked and which meeting you meant, and I'll check it again. Open the source under an answer to see the notes it came from.";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const labelsOf = (ids: SourceId[]) => ids.map((i) => LABELS[i]).join(", ");

// ---- reply assembly ---------------------------------------------------------------------------------------------

function grounding(used: RetrievedRecord[], reports: SourceReport[], evidence: boolean): Grounding {
  const count = new Set(used.map((r) => `${r.source}:${r.ref ?? r.label}`)).size;
  return {
    facts: count, evidence,
    sources_used: [...new Set(reports.filter((r) => r.state !== "unavailable").map((r) => r.id))],
    not_covered: [...new Set(reports.filter((r) => r.state === "unavailable").map((r) => r.id))],
  };
}

export interface Draft {
  intent: ChatIntent;
  text: string;
  sections?: ChatSection[];
  sources?: SourceReport[];
  used?: RetrievedRecord[];
  evidence?: boolean;
  extra?: Partial<ChatReply>;
}

export function finish(ctx: BrainChatContext, d: Draft): ChatReply {
  const sources = d.sources ?? [];
  const sections = [...(d.sections ?? [])];
  const retrievedAt = ctx.now.toISOString();
  const stamped = sources.map((s) => ({ ...s, retrieved_at: retrievedAt }));
  const missing = stamped.filter((s) => s.state === "unavailable");
  if (missing.length && d.intent !== "sources") sections.push({ kind: "missing", heading: "Not checked", text: missing.map((s) => `${s.label}: ${s.detail}`).join(" ") });
  // The data behind THIS answer, which is not always the data behind the app: a demo workspace can still read a real Notion, and that
  // answer must never be labelled demo. A live session is always live.
  const live = stamped.some((s) => s.state === "live" && s.id === "documents");
  const demo = stamped.some((s) => s.state === "demo");
  const data: "demo" | "live" | "mixed" = ctx.mode === "live" ? "live" : live && !demo ? "live" : live && demo ? "mixed" : "demo";
  return {
    intent: d.intent, mode: ctx.mode, data, text: d.text, sections, sources: stamped,
    ...(FOLLOW_UPS[d.intent] ? { follow_ups: [...FOLLOW_UPS[d.intent]!] } : {}),
    grounding: grounding(d.used ?? [], sources, d.evidence ?? false),
    ...(data === "demo" && ctx.mode === "demo" ? { notice: DEMO_NOTICE } : data === "mixed" ? { notice: MIXED_NOTICE } : {}),
    ...d.extra,
    generated_at: ctx.now.toISOString(),
  };
}

const item = (r: RetrievedRecord): ChatItem => ({
  text: recordText(r), href: r.href, source: r.source, ...(r.timestamp ? { as_of: r.timestamp } : {}), ...(r.flagged ? { flagged: true } : {}),
});
const facts = (heading: string, rs: RetrievedRecord[]): ChatSection => ({
  kind: "facts", heading: `${heading} (${rs.length})`, items: rs.slice(0, MAX_ITEMS).map(item),
  ...(rs.length > MAX_ITEMS ? { text: `${rs.length - MAX_ITEMS} more not shown.` } : {}),
});

// ---- entry point ------------------------------------------------------------------------------------------------

/**
 * The AI Brain's conversational entry point. READ-ONLY by construction: it is handed a Repo but only reaches it through the
 * retrieval adapters, which call list/view methods only. A request to change anything becomes a structured approval request
 * (never executed). `ctx.user`, `ctx.mode` and `ctx.repo` must come from the server session, never from the browser.
 *
 *   message → intent router → authorized retrieval (adapters) → policy → grounded reply
 */
export async function askBrain(ctx: BrainChatContext, message: string, opts: { projectId?: string } = {}): Promise<ChatReply> {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (!trimmed) throw new ChatInputError("Type a question first.");
  if (trimmed.length > MAX_MESSAGE_CHARS) throw new ChatInputError(`Please keep questions under ${MAX_MESSAGE_CHARS} characters.`);

  let routed = routeIntent(trimmed);
  // A complaint about an earlier answer asks for no data: it is answered here, before any model or source, so the word "meeting" in it can never be read as a calendar question.
  if (routed.intent !== "blocked" && routed.intent !== "action_request" && isAnswerFeedback(trimmed)) return finish(ctx, { intent: "help", text: FEEDBACK_REPLY });
  // What the Brain reads. Normally the message as typed; with a language-understanding step it is what the user MEANT (typos, Hinglish, follow-ups).
  // A message the deterministic rules already block or recognise as a change request is never sent to the model.
  let q = trimmed;
  let interpreted = false;
  // Claude tool use (flag BROKO_AI_TOOLS; ctx.toolAgent is absent otherwise). Only for a sentence the rules did not recognise, outside a meeting
  // follow-up and a project scope. It reads ONLY through runTool() and replaces the language step when it answers. When it declines for ANY reason
  // the ordinary path below runs exactly as it does without the flag, so a denied request can never be answered here but refused there (or the reverse).
  if (ctx.toolAgent && routed.intent === "unsupported" && !ctx.focus && !opts.projectId && !isCanonical(trimmed)) {
    const outcome = await ctx.toolAgent.run({
      userId: ctx.user.id, role: ctx.user.role === "admin" ? "admin" : "member", message: trimmed, today: interpretContext(ctx).today, nowMs: ctx.now.getTime(), timeZone: ctx.timeZone || "UTC", recent: ctx.history ?? [],
      contracts: (ctx.tools ?? standardRegistry()).list(), run: (id, input) => runBrainTool(ctx, id, input),
    });
    if (outcome.kind === "answered") return toolAnswer(ctx, outcome);
  }
  if (ctx.interpreter && routed.intent !== "blocked" && routed.intent !== "action_request" && routed.intent !== "help" && !isCanonical(trimmed)) {
    const meant = await ctx.interpreter.interpret(ctx.user.id, trimmed, interpretContext(ctx));
    if (meant?.kind === "ambiguous") {
      return finish(ctx, { intent: "clarify", text: meant.question, extra: { clarification: { question: meant.question, options: meant.options }, follow_ups: [], routing: "model", generation: "model_routed" } });
    }
    if (meant?.kind === "restated" && meant.question !== trimmed) {
      const again = routeIntent(meant.question);
      // A meaning that trips the injection tripwire is discarded. One that is a change request ("delet yesterdys meeting") is kept: it only ever
      // produces the existing "approval required, not executed" card, so a badly typed request is handled like a well typed one.
      if (again.intent !== "blocked") { q = meant.question; routed = again; interpreted = true; }
    }
  }
  // When the conversation is already about a meeting, a short follow-up ("who owns that?", "the previous meeting") belongs to it. It is checked first,
  // because the questions below would otherwise take wording like "what was decided" for something else. It is skipped for anything that is
  // not plainly about meetings (tasks, notifications, ...), and the blocked, action and help rules above still come first.
  if (ctx.focus && routed.intent !== "blocked" && routed.intent !== "action_request" && routed.intent !== "help") {
    const follow = await tryMeeting(ctx, q, routed);
    if (follow) return follow;
  }
  // Pre-Construction questions are recognised deterministically, BEFORE the model is ever consulted, and only after the
  // tripwire / action / greeting rules above have had their say. The model never sees them and never writes the answer.
  if (routed.intent !== "blocked" && routed.intent !== "action_request" && routed.intent !== "help") {
    const precon = await tryPrecon(ctx, q, routed, opts.projectId);
    if (precon) return precon;
  }
  // Approved organizational knowledge is next: explicit "what did we decide / what is our procedure" questions, and questions that are
  // otherwise unsupported but really match approved knowledge. It never runs for blocked, action, help or clarify, and when knowledge
  // is absent or unavailable everything below behaves exactly as it did before.
  if (routed.intent !== "blocked" && routed.intent !== "action_request" && routed.intent !== "help" && routed.intent !== "clarify") {
    const knowledge = await tryKnowledge(ctx, q, routed, opts.projectId);
    if (knowledge) return knowledge;
  }
  // Questions about what happened in a meeting (summary, decisions, action items) are located, read and analysed through the registry.
  // Never for blocked, action, help or clarify; when the source is not connected they say so honestly.
  if (routed.intent !== "blocked" && routed.intent !== "action_request" && routed.intent !== "help" && routed.intent !== "clarify") {
    const meeting = await tryMeeting(ctx, q, routed);
    if (meeting) return meeting;
  }
  // Questions that name Notion are answered from Notion through the registry when it is connected (otherwise this returns null and the
  // existing "cannot read it yet" reply below is unchanged). Never for blocked, action, help or clarify.
  if (routed.intent !== "blocked" && routed.intent !== "action_request" && routed.intent !== "help" && routed.intent !== "clarify") {
    const notion = await tryNotion(ctx, q, routed);
    if (notion) return notion;
  }
  let viaModel = false;
  // The model is consulted ONLY for a sentence the deterministic router did not understand and that names no unreadable source.
  // Blocked, action, help, clarify and every deterministic data match never reach it, so the tripwire and approval rules are
  // unchanged. The model can only choose a read-only question; retrieval, authorization and wording below stay deterministic.
  if (ctx.router && routed.intent === "unsupported" && routed.domains.length === 0) {
    const m = await ctx.router.route(ctx.user.id, q);
    if (m) {
      routed = { intent: m.intent, parts: m.parts, signals: [], domains: [], priority: m.priority, action: m.action };
      viaModel = true;
    }
  }
  const reply = await answer(ctx, routed, q);
  return viaModel || interpreted ? { ...reply, routing: "model", ...(reply.generation === "model_synthesised" ? {} : { generation: "model_routed" as const }) } : reply;
}

/** The reply for a tool-use answer: Claude wrote the text from meeting segments it was shown, and the sources are only those it validly cited. */
function toolAnswer(ctx: BrainChatContext, out: Extract<AgentOutcome, { kind: "answered" }>): ChatReply {
  const used: RetrievedRecord[] = out.sources.map((s) => ({ source: "documents", type: "external_page", ref: s.record_id, label: s.title, timestamp: null, scope: "organization", provenance: "live", flagged: false, attrs: {} }));
  const items: ChatItem[] = out.sources.map((s) => ({ text: `${s.title}${s.when ? ` — ${s.when}` : ""}`, source: "documents", cite: s.cites, ...(s.url ? { external_url: s.url } : {}) }));
  const fromMemory = out.sources.length > 0 && out.sources.every((s) => s.memory);
  return finish(ctx, {
    intent: "knowledge", text: out.text,
    sections: [{ kind: "facts", heading: fromMemory ? "From stored Notion memory (proposed unless marked reviewed)" : "From the meeting notes", items }],
    sources: [{ id: "documents", label: "Notion (pages shared with Broko)", state: "live", detail: "Read just now through Broko's tool registry.", count: out.sources.length }],
    used, evidence: true,
    // No `generation` here on purpose: "model_synthesised" tells the user every statement was validated against the page, which only the meeting analysis does.
    extra: { follow_ups: [], quiet: true, notice: "An AI model wrote this answer from the meeting notes it read through Broko's tools. Statements cite passages of the source. Open the source to review the supporting context." },
  });
}

/** What the language step is told about the conversation. Today's date is computed here, in the user's time zone, never by the model. */
function interpretContext(ctx: BrainChatContext): InterpretContext {
  const timeZone = ctx.timeZone || "UTC";
  let today: string;
  try { today = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(ctx.now); } catch { today = ctx.now.toISOString().slice(0, 10); }
  return {
    today, timeZone, recent: ctx.history ?? [],
    ...(ctx.focus ? { meeting: { title: ctx.focus.title, ...(ctx.focus.starts_at ? { date: ctx.focus.starts_at.slice(0, 10) } : {}), last_answer: ctx.focus.output.replace("_", " ") } } : {}),
  };
}

async function tryPrecon(ctx: BrainChatContext, message: string, routed: RoutedIntent, projectId: string | undefined): Promise<ChatReply | null> {
  const repo = ctx.repo.precon;
  const scoped = projectId !== undefined && projectId !== "";
  if (!repo) {
    // Say "not connected" only when the question is plainly about Pre-Construction; otherwise carry on as before.
    return !scoped && parsePreconQuery(message, [], { scoped: false, taskIntentMatched: routed.parts.length > 0 })?.topics.size ? notConnected(ctx) : null;
  }
  try {
    let scope = null;
    if (scoped) {
      // Context supplied by the browser is only a hint: it is validated and authorized here, for this user, on every question.
      scope = isProjectId(projectId) ? await repo.getProject(projectId) : null;
      if (!scope || scope.archived_at) return projectNotFound(ctx);
    }
    const projects = await repo.listProjects();
    const q = parsePreconQuery(message, projects, { scoped, taskIntentMatched: routed.parts.length > 0 });
    const reply = q ? await answerPrecon(ctx, q, scope, repo, message) : null;
    // A project-scoped question also gets that project's approved notes (added after the Pre-Construction answer, never changing it).
    return reply && scope ? await withProjectKnowledge(ctx, reply, scope) : reply;
  } catch (e) {
    console.error("[chat] preconstruction", e);
    return finish(ctx, {
      intent: "preconstruction", text: "I could not read Pre-Construction data right now, so I can't answer. Nothing was substituted.",
      sources: [{ id: "preconstruction", label: "Pre-Construction (projects, inventory, documents)", state: "unavailable", reason: "error", detail: "Could not be read right now. Nothing was substituted." }],
    });
  }
}

async function answer(ctx: BrainChatContext, routed: RoutedIntent, message: string): Promise<ChatReply> {
  switch (routed.intent) {
    case "blocked":
      return finish(ctx, { intent: "blocked", text: "I can't help with that request. It looks like an attempt to change my instructions or reach secrets or system details, and I don't share those. Ask me about your tasks, activity or sources instead." });
    case "action_request": {
      const approval = buildApproval(ctx.user, routed.action ?? "update_task");
      const who = approval.permitted === false ? ` ${approval.reason}` : "";
      return finish(ctx, {
        intent: "action_request",
        text: `I can't make changes or send anything from chat, and nothing was done. "${approval.label}" needs a person's approval on the normal screen, where the usual permission checks and audit trail apply.${who}`,
        extra: { approval, ...proposalFor(ctx, routed.action ?? "update_task", message) },
      });
    }
    case "help":
      return finish(ctx, { intent: "help", text: CAPABILITIES, sections: [{ kind: "facts", heading: "Try asking", items: SUGGESTED_PROMPTS.map((text) => ({ text })) }] });
    case "clarify":
      return finish(ctx, { intent: "clarify", text: routed.clarify!.question, extra: { clarification: routed.clarify! } });
    case "unsupported":
      return answerUnsupported(ctx, routed);
    default:
      return answerData(ctx, routed);
  }
}

const PROPOSAL_FOR_ACTION: Record<ActionKind, ProposalType> = {
  create_task: "create_task", assign_task: "assign_task", update_task: "update_task", delete_record: "delete_record", send_message: "send_email",
  schedule_event: "create_calendar_event", review_ai_message: "review_ai_message", change_configuration: "change_configuration",
};
/** A prepared, display-only proposal for the requested change. Not stored, not executable, never run from chat. */
function proposalFor(ctx: BrainChatContext, action: ActionKind, message: string): { proposal?: ActionProposal } {
  const made = prepareProposal(ctx.user, PROPOSAL_FOR_ACTION[action], { request_text: message.slice(0, 200) }, ctx.now);
  return made.ok ? { proposal: made.proposal } : {};
}

// ---- unsupported ------------------------------------------------------------------------------------------------

async function answerUnsupported(ctx: BrainChatContext, routed: RoutedIntent): Promise<ChatReply> {
  if (routed.domains.length === 0) {
    return finish(ctx, {
      intent: "unsupported",
      text: `I can't answer that: ${CAPABILITIES}`,
      sections: [{ kind: "facts", heading: "Try asking", items: SUGGESTED_PROMPTS.map((text) => ({ text })) }],
    });
  }
  const got = await retrieveViaTools(ctx, ["integrations"]);
  const reports = unreadableSources(routed.domains, got.integrations?.ok ? got.integrations.records : null);
  return finish(ctx, {
    intent: "unsupported",
    text: `I can't answer questions about ${labelsOf(routed.domains)}. I cannot read ${routed.domains.length === 1 ? "it" : "them"} yet, so I did not search ${routed.domains.length === 1 ? "it" : "them"} and have no information from there.`,
    sources: reports,
  });
}

// ---- data questions ---------------------------------------------------------------------------------------------

const NEEDS: Record<DataIntent, ReadableSource[]> = {
  attention: ["tasks", "notifications", "ai_inbox"],
  pending_tasks: ["tasks"], overdue: ["tasks"], upcoming: ["tasks"], priority: ["tasks"], owners: ["tasks"],
  today: ["tasks", "activity"],
  notifications: ["notifications"],
  ai_inbox: ["ai_inbox"],
  integrations: ["integrations"],
  sources: ["tasks", "activity", "notifications", "ai_inbox", "integrations"],
};
/** Message-like sources the user would reasonably expect to be included, per question. */
const ALSO_RELEVANT: Partial<Record<DataIntent, SourceId[]>> = {
  attention: MESSAGE_SOURCES, today: ["email", "teams", "whatsapp", "calendar"], overdue: ["email", "teams", "whatsapp"],
  upcoming: ["calendar"], integrations: ["email", "teams", "whatsapp", "calendar", "documents"], sources: MESSAGE_SOURCES,
};
const ORDER: SourceId[] = ["tasks", "activity", "notifications", "ai_inbox", "integrations", "email", "teams", "whatsapp", "calendar", "crm", "documents"];

interface Part { lines: string[]; sections: ChatSection[]; used: RetrievedRecord[]; ok: boolean }
const failedPart = (what: string, ids: SourceId[]): Part => ({ lines: [`I could not read ${labelsOf(ids).toLowerCase()} right now, so I can't ${what}.`], sections: [], used: [], ok: false });

const dueKey = (r: RetrievedRecord) => (r.attrs.due_at ? r.attrs.due_at : "9999");
const byDue = (a: RetrievedRecord, b: RetrievedRecord) => dueKey(a).localeCompare(dueKey(b));

function taskParts(o: Outcomes, ctx: BrainChatContext) {
  const day = dayKey(ctx.now);
  const t = o.tasks;
  const all = t?.ok ? t.records : [];
  const active = all.filter((r) => isActive({ status: r.attrs.status! }));
  const overdue = active.filter((r) => isOverdueOn({ status: r.attrs.status!, due_at: r.attrs.due_at ?? null }, day)).sort(byDue);
  const dueToday = active.filter((r) => r.attrs.due_at && dayKey(new Date(r.attrs.due_at)) === day);
  const horizon = dayKey(new Date(ctx.now.getTime() + UPCOMING_DAYS * 86_400_000));
  const upcoming = active.filter((r) => r.attrs.due_at && dayKey(new Date(r.attrs.due_at)) >= day && dayKey(new Date(r.attrs.due_at)) <= horizon).sort(byDue);
  return { ok: !!t?.ok, all, active, overdue, dueToday, upcoming };
}

const PRIORITY_MATCH: Record<PriorityFilter, string[]> = { urgent: ["urgent"], high_or_urgent: ["high", "urgent"], medium: ["medium"], low: ["low"] };
const PRIORITY_NAME: Record<PriorityFilter, string> = { urgent: "urgent", high_or_urgent: "high-priority or urgent", medium: "medium-priority", low: "low-priority" };
const STATUS_TEXT = { connected: "connected", disconnected: "not connected", pending_setup: "setup pending", error: "reporting an error" } as const;

async function answerData(ctx: BrainChatContext, routed: RoutedIntent): Promise<ChatReply> {
  const parts = routed.parts;
  const unreadable = [...new Set([...parts.flatMap((p) => ALSO_RELEVANT[p] ?? []), ...routed.domains])];
  const need = new Set<ReadableSource>(parts.flatMap((p) => NEEDS[p]));
  if (unreadable.length) need.add("integrations"); // only to state WHY a source is unavailable
  const o = await retrieveViaTools(ctx, [...need]);

  const results = parts.map((p) => answerPart(ctx, p, o, routed));
  const shownIds = new Set<SourceId>(parts.flatMap((p) => NEEDS[p]));
  const reports: SourceReport[] = [
    ...ORDER.filter((id) => shownIds.has(id)).map((id) => o[id as ReadableSource]!.report),
    ...unreadableSources(ORDER.filter((id) => unreadable.includes(id)), o.integrations?.ok ? o.integrations.records : null),
  ].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

  const failed = reports.filter((r) => r.state === "unavailable" && r.reason === "error").map((r) => r.label);
  const asked = routed.domains.length ? ` You also mentioned ${labelsOf(routed.domains)}, which I cannot read, so I did not search ${routed.domains.length === 1 ? "it" : "them"}.` : "";
  const text = results.flatMap((r) => r.lines).join("\n") + asked;
  const anyOk = reports.some((r) => r.state !== "unavailable");
  return finish(ctx, {
    intent: routed.intent, text, sections: results.flatMap((r) => r.sections), sources: reports,
    used: results.flatMap((r) => r.used), evidence: anyOk && results.some((r) => r.ok),
    extra: failed.length ? { notice: `${ctx.mode === "demo" ? `${DEMO_NOTICE} ` : ""}I could not read: ${failed.join(", ")}. Those parts are missing, not empty.` } : {},
  });
}

function answerPart(ctx: BrainChatContext, p: DataIntent, o: Outcomes, routed: RoutedIntent): Part {
  const tp = taskParts(o, ctx);
  switch (p) {
    case "pending_tasks": {
      if (!tp.ok) return failedPart("summarise your tasks", ["tasks"]);
      if (tp.active.length === 0) return { lines: ["You have no pending tasks."], sections: [], used: [], ok: true };
      const prog = tp.active.filter((r) => r.attrs.status === "in_progress");
      const open = tp.active.filter((r) => r.attrs.status === "open");
      return {
        lines: [`You have ${plural(tp.active.length, "pending task")}: ${open.length} open and ${prog.length} in progress.`],
        sections: [prog.length ? facts("In progress", prog) : null, open.length ? facts("Open", open) : null].filter((s): s is ChatSection => s !== null),
        used: tp.active, ok: true,
      };
    }
    case "overdue": {
      if (!tp.ok) return failedPart("check for overdue work", ["tasks"]);
      const caveat = "Follow-ups that exist only in email, Teams or WhatsApp are not visible to me yet.";
      return {
        lines: [tp.overdue.length ? `${plural(tp.overdue.length, "task")} overdue, oldest first. ${caveat}` : `Nothing is overdue in your tasks. ${caveat}`],
        sections: tp.overdue.length ? [facts("Overdue", tp.overdue), RECOMMEND] : [], used: tp.overdue, ok: true,
      };
    }
    case "upcoming": {
      if (!tp.ok) return failedPart("check upcoming due dates", ["tasks"]);
      return {
        lines: [tp.upcoming.length ? `${plural(tp.upcoming.length, "task")} due in the next ${UPCOMING_DAYS} days (including today), soonest first. Calendar events are not visible to me.` : `No active tasks are due in the next ${UPCOMING_DAYS} days. Calendar events are not visible to me.`],
        sections: tp.upcoming.length ? [facts("Due soon", tp.upcoming)] : [], used: tp.upcoming, ok: true,
      };
    }
    case "priority": {
      if (!tp.ok) return failedPart("check priorities", ["tasks"]);
      const f = routed.priority ?? "high_or_urgent";
      const hits = tp.active.filter((r) => PRIORITY_MATCH[f].includes(r.attrs.priority!)).sort(byDue);
      return {
        lines: [hits.length ? `${plural(hits.length, "active task")} ${hits.length === 1 ? "is" : "are"} ${PRIORITY_NAME[f]}.` : `No active tasks are ${PRIORITY_NAME[f]}.`],
        sections: hits.length ? [facts("By priority", hits)] : [], used: hits, ok: true,
      };
    }
    case "owners": {
      if (!tp.ok) return failedPart("show who owns tasks", ["tasks"]);
      if (tp.active.length === 0) return { lines: ["There are no active tasks, so nobody currently owns any."], sections: [], used: [], ok: true };
      const groups = new Map<string, RetrievedRecord[]>();
      for (const r of tp.active) groups.set(r.attrs.owner ?? "Unassigned", [...(groups.get(r.attrs.owner ?? "Unassigned") ?? []), r]);
      const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      const scope = ctx.user.role === "admin" ? "across all tasks" : "among the tasks you can see";
      return {
        lines: [`Active tasks by owner ${scope}.`],
        sections: [{ kind: "facts", heading: `Owners (${rows.length})`, items: rows.slice(0, 8).map(([name, rs]) => ({ text: `${name}: ${plural(rs.length, "active task")}`, source: "tasks" as const })) }],
        used: tp.active, ok: true,
      };
    }
    case "today": {
      const act = o.activity;
      if (!act?.ok) return failedPart("say what happened today", ["activity"]);
      const day = dayKey(ctx.now);
      const today = act.records.filter((r) => r.timestamp && dayKey(new Date(r.timestamp)) === day);
      const due = tp.dueToday;
      const stale = act.report.state === "stale" ? " The newest recorded event is more than 24 hours old." : "";
      const sections = [today.length ? facts("Activity today", today) : null, due.length ? facts("Due today", due) : null].filter((s): s is ChatSection => s !== null);
      return {
        lines: [today.length === 0 && due.length === 0 ? `No activity is recorded for today and nothing is due today.${stale}` : `${plural(today.length, "event")} recorded today and ${plural(due.length, "task")} due today.${stale}`],
        sections, used: [...today, ...due], ok: true,
      };
    }
    case "notifications": {
      const n = o.notifications;
      if (!n?.ok) return failedPart("check notifications", ["notifications"]);
      const unread = n.records.filter((r) => r.attrs.unread);
      return {
        lines: [unread.length ? `You have ${plural(unread.length, "unread notification")} (${n.records.length} in total).` : n.records.length ? `No unread notifications (${n.records.length} in total).` : "You have no notifications."],
        sections: unread.length ? [facts("Unread", unread)] : [], used: unread, ok: true,
      };
    }
    case "ai_inbox": {
      const a = o.ai_inbox;
      if (!a?.ok) {
        const reason = a?.report.reason;
        if (reason === "error") return failedPart("report the AI Inbox status", ["ai_inbox"]);
        return { lines: [`I can't report AI Inbox status: ${a?.report.detail ?? "it is unavailable"}`], sections: [], used: [], ok: false };
      }
      const rec = a.records[0];
      const sample = a.report.state === "demo" ? " These are built-in sample emails, not a real mailbox." : "";
      return { lines: [`AI Inbox: ${rec.label}.${sample} I report counts only; review happens in the AI Inbox.`], sections: [facts("AI Inbox", a.records)], used: a.records, ok: true };
    }
    case "integrations": {
      const i = o.integrations;
      if (!i?.ok) return failedPart("report integration status", ["integrations"]);
      const connected = i.records.filter((r) => r.attrs.integration_status === "connected");
      return {
        lines: [`${connected.length} of ${i.records.length} integrations show as connected. This is connection status only: I cannot read the content of any of them yet.`],
        sections: [{
          kind: "facts", heading: `Integrations (${i.records.length})`,
          items: i.records.map((r): ChatItem => ({
            text: `${r.label}: ${STATUS_TEXT[r.attrs.integration_status ?? "disconnected"]}${r.timestamp ? `, last sync ${r.timestamp.slice(0, 10)}` : ""}`,
            href: r.href, source: "integrations", ...(r.timestamp ? { as_of: r.timestamp } : {}),
          })),
        }],
        used: i.records, ok: true,
      };
    }
    case "attention": {
      const lines: string[] = [];
      const sections: ChatSection[] = [];
      const used: RetrievedRecord[] = [];
      let ok = false;
      const parts: string[] = [];
      if (tp.ok) {
        ok = true;
        const lateIds = new Set(tp.overdue.map((r) => r.ref));
        const urgent = tp.active.filter((r) => (r.attrs.priority === "urgent" || r.attrs.priority === "high") && !lateIds.has(r.ref)).sort(byDue);
        if (tp.overdue.length) { parts.push(plural(tp.overdue.length, "overdue task")); sections.push(facts("Overdue", tp.overdue)); used.push(...tp.overdue); }
        if (urgent.length) { parts.push(plural(urgent.length, "high-priority task")); sections.push(facts("High priority", urgent)); used.push(...urgent); }
      }
      const n = o.notifications;
      if (n?.ok) {
        ok = true;
        const unread = n.records.filter((r) => r.attrs.unread);
        if (unread.length) { parts.push(plural(unread.length, "unread notification")); used.push(...unread); }
      }
      const a = o.ai_inbox;
      if (a?.ok) {
        ok = true;
        const pending = a.records[0].attrs.review_pending ?? 0;
        if (pending) { parts.push(`${plural(pending, "AI Inbox message")} awaiting your review${a.report.state === "demo" ? " (sample emails)" : ""}`); used.push(...a.records); }
      }
      if (sections.some((x) => x.heading?.startsWith("Overdue") || x.heading?.startsWith("High priority"))) sections.push(RECOMMEND);
      lines.push(parts.length ? `Needs attention: ${parts.join(", ")}.` : ok ? "Nothing in your tasks, notifications or AI Inbox needs attention right now." : "I could not read your tasks right now.");
      return { lines, sections, used, ok };
    }
    case "sources": {
      const reports = ORDER.map((id) => (id in ADAPTERS ? o[id as ReadableSource]?.report : undefined)).filter((r): r is SourceReport => !!r);
      const un = unreadableSources(MESSAGE_SOURCES, o.integrations?.ok ? o.integrations.records : null);
      const readable = reports.filter((r) => r.state !== "unavailable").length;
      return { lines: [`I can read ${readable} of ${reports.length + un.length} sources right now. The rest are listed with the reason, and I never fill a gap with guessed or sample data.`], sections: [], used: [], ok: readable > 0 };
    }
  }
}

