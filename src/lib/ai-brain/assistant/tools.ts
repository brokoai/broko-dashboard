import { z } from "zod";
import type { Profile } from "@/lib/types";
import { scanForInjection } from "../injection";
import { loadKnowledge } from "../chat/knowledge";
import { ADAPTERS, clean, type Outcome, type Outcomes, type ReadableSource } from "../chat/retrieval";
import type { BrainChatContext, RetrievedRecord } from "../chat/types";
import { sanitizeDocument } from "./meetings/analysis";
import { unavailableConnectors, type ConnectorResult, type Connectors, type PreparedDraft, type Slot } from "./connectors";

/**
 * Typed tool registry for the Broko Assistant. The language model never calls a URL, runs SQL or reaches a connector directly;
 * anything it can do is a registered contract that is validated, permission-checked, time-limited and returned with provenance.
 *
 *   read:    returns records. Runs only after input validation and a permission check.
 *   prepare: produces something for a person to review (a draft, a proposal). Changes nothing anywhere.
 *   write:   would change an external system. NEVER runs from here in Phase 1: it needs an approved proposal AND an executor,
 *            and no executor exists yet, so the registry refuses every write.
 */

export type SourceSystem = "broko_tasks" | "broko_activity" | "broko_knowledge" | "broko_memory" | "notion" | "outlook_mail" | "outlook_calendar";
export type ToolAccess = "read" | "prepare" | "write";
export type ToolFailure = "unknown_tool" | "invalid_input" | "permission_denied" | "approval_required" | "not_connected" | "not_implemented" | "rate_limited" | "timeout" | "error";

/** Every record a tool returns carries its provenance. `flagged` marks instruction-like text; flagged text is still only data. */
export const SourceRecordSchema = z.object({
  system: z.enum(["broko_tasks", "broko_activity", "broko_knowledge", "broko_memory", "notion", "outlook_mail", "outlook_calendar"]),
  record_id: z.string().min(1).max(200),
  title: z.string().max(200),
  excerpt: z.string().max(400).optional(),
  url: z.string().max(500).optional(),
  owner_context: z.string().max(120).optional(),
  retrieved_at: z.string().max(40),
  flagged: z.boolean(),
}).strict();
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export const ToolOutputSchema = z.object({ records: z.array(SourceRecordSchema).max(50) }).strict();
export type ToolOutput = z.infer<typeof ToolOutputSchema>;
type RawRecord = Omit<SourceRecord, "flagged">;

export interface ToolContext {
  user: Profile;
  now: Date;
  /** The same user-scoped context the Brain already uses; Broko tools read through its authorized adapters. */
  brain: BrainChatContext;
  connectors: Connectors;
  /** Outcomes already read for this request (an adapter that depends on another, such as activity on tasks, reads them here). */
  got?: Outcomes;
}

/**
 * What a tool backend returns. `native` is the in-process result the Brain already knows how to use (an adapter Outcome, the loaded
 * Knowledge set). It is handed back ONLY to the calling Brain code and never serialised into a reply.
 */
export type ToolRun = ConnectorResult<RawRecord[]> & { native?: unknown };

export interface ToolContract<I = unknown> {
  id: string;
  description: string;
  system: SourceSystem;
  access: ToolAccess;
  input: z.ZodType<I>;
  /** Minimum role. Every tool also requires a signed-in employee. */
  requires: "member" | "admin";
  timeoutMs: number;
  /** Where records come from and how they are cited. */
  provenance: string;
  /** Absent for tools whose backend does not exist yet (write-capable tools never have one in Phase 1). */
  run?: (input: I, ctx: ToolContext) => Promise<ToolRun>;
}

export type ToolResult =
  | { ok: true; tool: string; records: SourceRecord[]; retrieved_at: string; native?: unknown }
  | { ok: false; tool: string; reason: ToolFailure; detail: string; native?: unknown };

const DETAIL: Record<ToolFailure, string> = {
  unknown_tool: "No such tool.", invalid_input: "The tool input was not valid.", permission_denied: "You are not permitted to use this tool.",
  approval_required: "This would change an external system and needs an approved proposal.", not_connected: "This source is not connected.",
  not_implemented: "This capability is not available yet.", rate_limited: "The source is rate limiting requests. Try again shortly.", timeout: "The source did not answer in time.", error: "The source could not be read right now.",
};
const fail = (tool: string, reason: ToolFailure): ToolResult => ({ ok: false, tool, reason, detail: DETAIL[reason] });
const MAX_TIMEOUT_MS = 10_000;
const ID_RE = /^[a-z][a-z0-9_.]{2,60}$/;

export class ToolRegistry {
  private readonly byId = new Map<string, ToolContract<unknown>>();
  constructor(contracts: readonly ToolContract<unknown>[]) {
    for (const c of contracts) {
      if (!ID_RE.test(c.id)) throw new Error(`invalid tool id: ${c.id}`);
      if (this.byId.has(c.id)) throw new Error(`duplicate tool id: ${c.id}`);
      if (c.timeoutMs <= 0 || c.timeoutMs > MAX_TIMEOUT_MS) throw new Error(`tool ${c.id}: timeout must be 1..${MAX_TIMEOUT_MS} ms`);
      this.byId.set(c.id, c);
    }
  }
  list(): ToolContract<unknown>[] { return [...this.byId.values()]; }
  get(id: string): ToolContract<unknown> | undefined { return this.byId.get(id); }
}

/** Untrusted-data handling for anything a tool returns: trimmed, control characters removed, instruction-like text flagged (never obeyed). */
function toRecord(raw: RawRecord): SourceRecord {
  const title = clean(raw.title, 200);
  const excerpt = raw.excerpt === undefined ? undefined : clean(raw.excerpt, 400);
  const url = raw.url && /^(\/(?!\/)[A-Za-z0-9/_-]*|https:\/\/[^\s]{1,480})$/.test(raw.url) ? raw.url : undefined;
  return SourceRecordSchema.parse({
    system: raw.system, retrieved_at: raw.retrieved_at,
    record_id: clean(raw.record_id, 200) || "unknown", title,
    ...(excerpt !== undefined ? { excerpt } : {}), ...(url ? { url } : {}),
    ...(raw.owner_context !== undefined ? { owner_context: clean(raw.owner_context, 120) } : {}),
    flagged: scanForInjection(title, excerpt ?? "").suspected,
  });
}

/**
 * The single way the Assistant runs a tool. Order matters: known tool, permission, input validation, write gate, timeout-bounded run,
 * output validation. It never throws; every refusal is a fixed-vocabulary result with no source text or error message in it.
 */
export async function runTool(registry: ToolRegistry, id: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = registry.get(id);
  if (!tool) return fail(String(id).slice(0, 60), "unknown_tool");
  if (!ctx.user || (tool.requires === "admin" && ctx.user.role !== "admin")) return fail(id, "permission_denied");
  const parsed = tool.input.safeParse(rawInput);
  if (!parsed.success) return fail(id, "invalid_input");
  if (tool.access === "write") return fail(id, "approval_required"); // Phase 1: no write ever runs from the registry, approved or not
  if (!tool.run) return fail(id, "not_implemented");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), tool.timeoutMs); });
    const out = await Promise.race([tool.run(parsed.data, ctx), timeout]);
    if (out === "timeout") return fail(id, "timeout");
    if (!out.ok) return { ...fail(id, out.reason), ...(out.native !== undefined ? { native: out.native } : {}) };
    const records = out.data.slice(0, 50).map(toRecord);
    return { ok: true, tool: id, records: ToolOutputSchema.parse({ records }).records, retrieved_at: ctx.now.toISOString(), ...(out.native !== undefined ? { native: out.native } : {}) };
  } catch {
    return fail(id, "error");
  } finally {
    clearTimeout(timer);
  }
}

// ---- Phase 1 contracts ------------------------------------------------------------------------------------------

const Empty = z.object({}).strict();
const Query = z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(25).default(10) }).strict();
const Id = z.object({ id: z.string().regex(/^[A-Za-z0-9_=-]{1,200}$/) }).strict();
const MeetingKeywords = z.object({ keywords: z.array(z.string().trim().min(1).max(40)).max(8), limit: z.number().int().min(1).max(100).default(100) }).strict();
const Window = z.object({ from: z.string().datetime(), to: z.string().datetime(), limit: z.number().int().min(1).max(25).default(10) }).strict();
const Duration = z.object({ from: z.string().datetime(), to: z.string().datetime(), minutes: z.number().int().min(5).max(480) }).strict();
const Instruction = z.object({ thread_id: z.string().regex(/^[A-Za-z0-9_=-]{1,200}$/), instruction: z.string().trim().min(1).max(300) }).strict();
const Meeting = z.object({ title: z.string().trim().min(1).max(120), from: z.string().datetime(), to: z.string().datetime() }).strict();
const ProposalRef = z.object({ proposal_id: z.string().uuid() }).strict();

const publicRecords = (ctx: ToolContext, system: SourceSystem, records: RetrievedRecord[]): RawRecord[] =>
  records.map((r): RawRecord => ({
    system, record_id: r.ref ?? r.label.slice(0, 60), title: r.label, ...(r.href ? { url: r.href } : {}),
    owner_context: r.scope === "own" ? "your records" : "organization-wide", retrieved_at: ctx.now.toISOString(),
    ...(r.attrs.knowledge ? { excerpt: r.attrs.knowledge.excerpt } : {}),
  }));

/** An adapter outcome as a tool result. The Outcome itself travels as `native`, so a refusal keeps its honest reason and report. */
const outcomeRun = (ctx: ToolContext, system: SourceSystem, o: Outcome): ToolRun =>
  o.ok
    ? { ok: true, data: publicRecords(ctx, system, o.records), native: o }
    : { ok: false, reason: o.report.reason === "not_connected" ? "not_connected" : o.report.reason === "not_implemented" ? "not_implemented" : "error", native: o };

/** Broko data is read through the EXISTING adapters (same code, same authorization); the tool only wraps them. */
const brokoAdapterTool = (id: string, source: ReadableSource, system: SourceSystem, description: string, provenance: string): ToolContract<unknown> =>
  asc({ ...base, id, description, system, access: "read", input: Empty, provenance, run: async (_i, ctx) => outcomeRun(ctx, system, await ADAPTERS[source].retrieve(ctx.brain, ctx.got ?? {})) });

/** Tool id for each existing Brain source. The Brain looks tools up here; there is no second implementation of any of them. */
export const BROKO_TOOL_FOR_SOURCE: Record<ReadableSource | "knowledge", string> = {
  tasks: "broko.tasks.list", activity: "broko.activity.list", notifications: "broko.notifications.list", ai_inbox: "broko.ai_inbox.status",
  integrations: "broko.integrations.status", knowledge: "broko.knowledge.list",
};

const draftRecord = (system: SourceSystem, d: PreparedDraft, at: string): RawRecord => ({
  system, record_id: "draft", title: d.summary, excerpt: Object.entries(d.fields).map(([k, v]) => `${k}: ${v}`).join("; "), retrieved_at: at,
});
const slotRecords = (slots: Slot[], at: string): RawRecord[] => slots.map((s) => ({ system: "outlook_calendar", record_id: s.start, title: `Free ${s.start} to ${s.end}`, retrieved_at: at }));

const asc = <I>(t: ToolContract<I>): ToolContract<unknown> => t as unknown as ToolContract<unknown>;
const base = { requires: "member" as const, timeoutMs: 8000 };

export function phase1Tools(): ToolContract<unknown>[] {
  return [
    brokoAdapterTool("broko.tasks.list", "tasks", "broko_tasks", "Tasks the signed-in employee may see (administrators: all).", "Broko tasks via the user-scoped repository; cited by task id and /tasks link."),
    brokoAdapterTool("broko.activity.list", "activity", "broko_activity", "Recent team activity limited to tasks the employee may see.", "Broko activity feed via the user-scoped repository."),
    brokoAdapterTool("broko.notifications.list", "notifications", "broko_activity", "The employee own notifications.", "Broko notifications for the signed-in employee only."),
    brokoAdapterTool("broko.ai_inbox.status", "ai_inbox", "broko_activity", "AI Inbox review counts (no message content).", "AI Inbox counts from the user-scoped repository."),
    brokoAdapterTool("broko.integrations.status", "integrations", "broko_activity", "Integration connection status (never integration content).", "Broko integration status rows."),
    asc({ ...base, id: "broko.knowledge.list", description: "Approved, current Knowledge Base items the employee may see. Proposed, rejected, expired, superseded and redacted items are never returned.", system: "broko_knowledge", access: "read", input: Empty, provenance: "Approved Knowledge items; cited by title with /knowledge link.", run: async (_i, ctx) => { const loaded = await loadKnowledge(ctx.brain); return { ...outcomeRun(ctx, "broko_knowledge", loaded.outcome), native: loaded }; } }),
    // Future connectors: contracts exist, backends are the unavailable stubs, so every call reports not_connected.
    asc({ ...base, id: "notion.pages.search", description: "Search Notion pages the employee may read.", system: "notion", access: "read", input: Query, provenance: "Notion page id and URL.", run: (i: z.infer<typeof Query>, ctx) => ctx.connectors.notion.searchPages(i.query, i.limit) }),
    asc({ ...base, id: "notion.pages.get", description: "Read one Notion page the employee may read.", system: "notion", access: "read", input: Id, provenance: "Notion page id and URL.", run: async (i: z.infer<typeof Id>, ctx) => { const r = await ctx.connectors.notion.getPage(i.id); return r.ok ? { ok: true, data: [r.data] } : r; } }),
    asc({ ...base, id: "notion.databases.query", description: "List the rows (titles and links) of a Notion database shared with Broko.", system: "notion", access: "read", input: Id, provenance: "Notion page id and URL.", run: (i: z.infer<typeof Id>, ctx) => ctx.connectors.notion.queryDatabase(i.id, 10) }),
    // Meeting intelligence. ADMIN ONLY: the Notion integration sees whatever was shared with Broko as a whole, not what each employee could
    // open, so employee-level authorization cannot be established. The tools fail closed for members instead of widening access.
    asc({ ...base, requires: "admin", timeoutMs: 10_000, id: "notion.meetings.find", description: "Find Notion pages that may be meeting notes (titles, links and dates only).", system: "notion", access: "read", input: MeetingKeywords, provenance: "Notion page id, URL and date.",
      run: async (i: z.infer<typeof MeetingKeywords>, ctx) => {
        const r = await ctx.connectors.notion.findMeetingCandidates(i.keywords, i.limit);
        return r.ok ? { ok: true, data: r.data.map((c): RawRecord => ({ system: "notion", record_id: c.record_id, title: c.title, ...(c.url ? { url: c.url } : {}), owner_context: `Notion page${c.starts_at ? `, ${c.starts_at.slice(0, 10)}` : ""}`, retrieved_at: c.retrieved_at })), native: r.data } : r;
      } }),
    asc({ ...base, requires: "admin", timeoutMs: 10_000, id: "notion.meetings.read", description: "Read one Notion meeting page with its nested content, as numbered source segments.", system: "notion", access: "read", input: Id, provenance: "Notion page id, block ids and URL.",
      run: async (i: z.infer<typeof Id>, ctx) => {
        const r = await ctx.connectors.notion.readMeetingDocument(i.id);
        if (!r.ok) return r;
        const doc = sanitizeDocument(r.data);
        return { ok: true, data: [{ system: "notion", record_id: doc.record_id, title: doc.title, ...(doc.url ? { url: doc.url } : {}), owner_context: `Notion page, ${doc.segments.length} segments`, retrieved_at: doc.retrieved_at }], native: doc };
      } }),
    asc({ ...base, id: "outlook.mail.search", description: "Search the employee own mailbox.", system: "outlook_mail", access: "read", input: Query, provenance: "Outlook message id and web link; the employee own mailbox only.", run: (i: z.infer<typeof Query>, ctx) => ctx.connectors.mail.searchMessages(i.query, i.limit) }),
    asc({ ...base, id: "outlook.mail.thread", description: "Read one conversation thread in the employee own mailbox.", system: "outlook_mail", access: "read", input: Id, provenance: "Outlook conversation id.", run: (i: z.infer<typeof Id>, ctx) => ctx.connectors.mail.getThread(i.id) }),
    asc({ ...base, id: "outlook.mail.unanswered", description: "Messages in the employee mailbox that have no reply yet.", system: "outlook_mail", access: "read", input: Window, provenance: "Outlook message id.", run: (i: z.infer<typeof Window>, ctx) => ctx.connectors.mail.findUnanswered({ from: i.from, to: i.to }, i.limit) }),
    asc({ ...base, id: "outlook.mail.prepare_reply", description: "Prepare (not send) a reply draft for the employee to review.", system: "outlook_mail", access: "prepare", input: Instruction, provenance: "A draft shown in Broko only.", run: async (i: z.infer<typeof Instruction>, ctx) => { const r = await ctx.connectors.mail.prepareReplyDraft(i.thread_id, i.instruction); return r.ok ? { ok: true, data: [draftRecord("outlook_mail", r.data, ctx.now.toISOString())] } : r; } }),
    asc({ ...base, id: "outlook.calendar.events", description: "List events on the employee own calendar.", system: "outlook_calendar", access: "read", input: Window, provenance: "Outlook event id and web link.", run: (i: z.infer<typeof Window>, ctx) => ctx.connectors.calendar.listEvents({ from: i.from, to: i.to }, i.limit) }),
    asc({ ...base, id: "outlook.calendar.conflicts", description: "Meeting conflicts in a time window.", system: "outlook_calendar", access: "read", input: Window, provenance: "Outlook event id.", run: (i: z.infer<typeof Window>, ctx) => ctx.connectors.calendar.findConflicts({ from: i.from, to: i.to }) }),
    asc({ ...base, id: "outlook.calendar.availability", description: "Free slots of a given length.", system: "outlook_calendar", access: "read", input: Duration, provenance: "Free/busy computed from Outlook.", run: async (i: z.infer<typeof Duration>, ctx) => { const r = await ctx.connectors.calendar.checkAvailability({ from: i.from, to: i.to }, i.minutes); return r.ok ? { ok: true, data: slotRecords(r.data, ctx.now.toISOString()) } : r; } }),
    asc({ ...base, id: "outlook.calendar.prepare_event", description: "Prepare (not create) a meeting proposal.", system: "outlook_calendar", access: "prepare", input: Meeting, provenance: "A proposal shown in Broko only.", run: async (i: z.infer<typeof Meeting>, ctx) => { const r = await ctx.connectors.calendar.prepareEventProposal(i.title, { from: i.from, to: i.to }); return r.ok ? { ok: true, data: [draftRecord("outlook_calendar", r.data, ctx.now.toISOString())] } : r; } }),
    // Write-capable contracts: declared so they can be reviewed and gated; deliberately no `run`.
    asc({ ...base, id: "outlook.mail.send", description: "Send an email. Requires an approved proposal.", system: "outlook_mail", access: "write", input: ProposalRef, provenance: "Outlook sent item." }),
    asc({ ...base, id: "outlook.calendar.create_event", description: "Create a calendar event. Requires an approved proposal.", system: "outlook_calendar", access: "write", input: ProposalRef, provenance: "Outlook event." }),
    asc({ ...base, id: "outlook.calendar.update_event", description: "Change or delete a calendar event. Requires an approved proposal.", system: "outlook_calendar", access: "write", input: ProposalRef, provenance: "Outlook event." }),
    asc({ ...base, id: "notion.pages.update", description: "Modify a Notion page. Requires an approved proposal.", system: "notion", access: "write", input: ProposalRef, provenance: "Notion page." }),
    asc({ ...base, id: "broko.tasks.change", description: "Change a Broko task. Requires an approved proposal.", system: "broko_tasks", access: "write", input: ProposalRef, provenance: "Broko task." }),
  ];
}

export const phase1Registry = (): ToolRegistry => new ToolRegistry(phase1Tools());
export const defaultToolContext = (brain: BrainChatContext): ToolContext => ({ user: brain.user, now: brain.now, brain, connectors: unavailableConnectors() });
