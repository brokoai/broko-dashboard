import { INTEGRATION_META, type ActivityEvent, type Integration, type IntegrationProvider, type Profile, type Task } from "@/lib/types";
import { scanForInjection } from "../injection";
import type { BrainChatContext, RetrievedRecord, SourceId, SourceReport } from "./types";

/**
 * Authorized context retrieval: a registry of source adapters over the existing user-scoped `Repo`.
 *
 *  1. The Repo already scopes by user (RLS in Supabase, visibility in demo).
 *  2. Each adapter re-applies the same rule BEFORE producing records (defence in depth).
 *  3. Only a minimal projection is copied into a `RetrievedRecord` (no descriptions, emails, bodies, error text).
 *  4. Record text is untrusted data: truncated, scanned for instruction-like content, never interpreted.
 *
 * Adapters never write, never call integrations, and never fall back to another source or to demo data.
 */

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const LABELS: Record<SourceId, string> = {
  tasks: "Tasks", activity: "Activity feed", notifications: "Notifications", ai_inbox: "AI Inbox", integrations: "Integrations",
  email: "Email", teams: "Microsoft Teams", whatsapp: "WhatsApp", calendar: "Calendar", crm: "CRM", documents: "Documents",
  preconstruction: "Pre-Construction (projects, inventory, documents)",
};

export interface Outcome {
  /** false = retrieval failed or was not allowed. true with zero records = a real, empty answer. */
  ok: boolean;
  records: RetrievedRecord[];
  report: SourceReport;
}
export type Outcomes = Partial<Record<SourceId, Outcome>>;

export interface SourceAdapter {
  id: SourceId;
  /** Other sources this one is filtered by (activity is limited to the tasks the user can see). */
  needs?: SourceId[];
  retrieve(ctx: BrainChatContext, got: Outcomes): Promise<Outcome>;
}

/** Sources with no retrieval adapter. Their connection status can be reported, never their content. */
const INTEGRATION_SOURCES: Record<"email" | "teams" | "whatsapp" | "calendar" | "documents", IntegrationProvider[]> = {
  email: ["microsoft_outlook", "gmail"],
  teams: ["microsoft_teams"],
  whatsapp: ["whatsapp_business"],
  calendar: ["microsoft_calendar", "google_calendar"],
  documents: ["onedrive"],
};
export const MESSAGE_SOURCES: SourceId[] = ["email", "teams", "whatsapp", "calendar", "crm", "documents"];

// ---- authorization (same rules as RLS / demo visibility) -------------------------------------------------------

export function visibleTasks(user: Profile, tasks: Task[]): Task[] {
  if (user.role === "admin") return tasks;
  return tasks.filter((t) => t.assigned_to === user.id || t.created_by === user.id);
}

export function visibleActivity(user: Profile, visible: Task[], events: ActivityEvent[]): ActivityEvent[] {
  if (user.role === "admin") return events;
  const ids = new Set(visible.map((t) => t.id));
  return events.filter((e) => e.related_task_id !== null && ids.has(e.related_task_id));
}

// ---- helpers ----------------------------------------------------------------------------------------------------

export function clean(s: string, max: number): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
const safeRef = (id: string | null | undefined) => (id && SAFE_ID.test(id) ? id : null);
const taskHref = (id: string | null) => (id ? `/tasks/${id}` : undefined);
const provenanceOf = (ctx: BrainChatContext): "live" | "demo" => (ctx.mode === "demo" ? "demo" : "live");
const newest = (stamps: (string | null)[]): string | undefined => {
  const ms = stamps.filter((s): s is string => !!s).map((s) => new Date(s).getTime()).filter((n) => Number.isFinite(n));
  return ms.length ? new Date(Math.max(...ms)).toISOString() : undefined;
};

const readable = (ctx: BrainChatContext, id: SourceId, detail: string, records: RetrievedRecord[]): SourceReport => ({
  id, label: LABELS[id], state: provenanceOf(ctx), detail, count: records.length, as_of: newest(records.map((r) => r.timestamp)),
});
const failed = (id: SourceId): Outcome => ({
  ok: false, records: [],
  report: { id, label: LABELS[id], state: "unavailable", reason: "error", detail: "Could not be read right now. Nothing was substituted." },
});
const refused = (id: SourceId, reason: "admin_only" | "not_connected", detail: string): Outcome => ({
  ok: false, records: [], report: { id, label: LABELS[id], state: "unavailable", reason, detail },
});

// ---- adapters ---------------------------------------------------------------------------------------------------

const tasksAdapter: SourceAdapter = {
  id: "tasks",
  async retrieve(ctx) {
    try {
      const tasks = visibleTasks(ctx.user, await ctx.repo.listTasks());
      const scope = ctx.user.role === "admin" ? "organization" : "own";
      const records = tasks.map((t): RetrievedRecord => {
        const ref = safeRef(t.id);
        return {
          source: "tasks", type: "task", ref, href: taskHref(ref), label: clean(t.title, 120), timestamp: t.updated_at, scope, provenance: provenanceOf(ctx),
          // The description is scanned for instructions but NOT copied into the record.
          flagged: scanForInjection(t.title, t.description).suspected,
          attrs: { status: t.status, priority: t.priority, due_at: t.due_at, owner: t.assignee_name ? clean(t.assignee_name, 40) : null },
        };
      });
      return { ok: true, records, report: readable(ctx, "tasks", ctx.user.role === "admin" ? "All tasks" : "Tasks assigned to or created by you", records) };
    } catch {
      return failed("tasks");
    }
  },
};

const activityAdapter: SourceAdapter = {
  id: "activity",
  needs: ["tasks"],
  async retrieve(ctx, got) {
    const tasks = got.tasks;
    // Members' activity is filtered by the tasks they can see. If that set could not be established, do not guess.
    if (ctx.user.role !== "admin" && !tasks?.ok) return failed("activity");
    try {
      const visible = new Set((tasks?.records ?? []).map((r) => r.ref));
      const events = await ctx.repo.listActivity(50);
      const allowed = ctx.user.role === "admin" ? events : events.filter((e) => e.related_task_id !== null && visible.has(e.related_task_id));
      const records = allowed.map((e): RetrievedRecord => {
        const ref = safeRef(e.related_task_id);
        return {
          source: "activity", type: "activity_event", ref, href: taskHref(ref), label: clean(e.description, 140), timestamp: e.created_at,
          scope: ctx.user.role === "admin" ? "organization" : "own", provenance: provenanceOf(ctx), flagged: scanForInjection(e.description).suspected, attrs: {},
        };
      });
      const report = readable(ctx, "activity", "Recent workflow and task events", records);
      const age = report.as_of ? ctx.now.getTime() - new Date(report.as_of).getTime() : 0;
      if (records.length > 0 && age > STALE_AFTER_MS) {
        report.state = "stale";
        report.detail = "Newest event is more than 24 hours old; it may not reflect current activity.";
      }
      return { ok: true, records, report };
    } catch {
      return failed("activity");
    }
  },
};

const notificationsAdapter: SourceAdapter = {
  id: "notifications",
  async retrieve(ctx) {
    try {
      // AppNotification carries no owner id: scoping is entirely the repository's (RLS: own rows only).
      const rows = await ctx.repo.listNotifications();
      const records = rows.map((n): RetrievedRecord => {
        const ref = safeRef(n.id);
        return {
          source: "notifications", type: "notification", ref, label: clean(n.title, 140), timestamp: n.created_at, scope: "own", provenance: provenanceOf(ctx),
          flagged: scanForInjection(n.title).suspected, attrs: { unread: n.read_at === null },
        };
      });
      return { ok: true, records, report: readable(ctx, "notifications", "Your notifications", records) };
    } catch {
      return failed("notifications");
    }
  },
};

const aiInboxAdapter: SourceAdapter = {
  id: "ai_inbox",
  async retrieve(ctx) {
    // Authorization first: a member never reaches the counts reader, so nothing about the inbox can be inferred.
    if (ctx.user.role !== "admin") return refused("ai_inbox", "admin_only", "Only administrators can review AI Inbox messages.");
    // Counts-only reader. The page's `aiInbox.view()` (subjects, senders, bodies) is deliberately never used by chat.
    if (!ctx.repo.aiInboxCounts) return refused("ai_inbox", "not_connected", "The AI Inbox is not connected to this backend.");
    try {
      const counts = await ctx.repo.aiInboxCounts.counts();
      const pending = counts.by_status.REVIEW_REQUIRED ?? 0;
      const synthetic = counts.mode === "synthetic";
      // One summary record: counts only.
      const record: RetrievedRecord = {
        source: "ai_inbox", type: "ai_inbox_summary", ref: null, href: "/inbox", label: `${pending} message${pending === 1 ? "" : "s"} awaiting review`,
        timestamp: null, scope: "organization", provenance: synthetic ? "demo" : "live", flagged: false,
        attrs: { review_pending: pending },
      };
      return {
        ok: true, records: [record],
        report: {
          id: "ai_inbox", label: LABELS.ai_inbox, state: synthetic ? "demo" : "live", count: counts.total,
          detail: synthetic ? "Built-in sample emails, not a real mailbox" : "Status counts from the connected provider",
        },
      };
    } catch {
      return failed("ai_inbox");
    }
  },
};

const integrationsAdapter: SourceAdapter = {
  id: "integrations",
  async retrieve(ctx) {
    try {
      const rows: Integration[] = await ctx.repo.listIntegrations();
      // Status only. `last_error` text is not copied.
      const records = rows.map((i): RetrievedRecord => ({
        source: "integrations", type: "integration", ref: safeRef(i.provider), href: "/integrations", label: INTEGRATION_META[i.provider] ?? "Integration", timestamp: i.last_sync_at,
        scope: "organization", provenance: provenanceOf(ctx), flagged: false, attrs: { integration_status: i.status },
      }));
      const report = readable(ctx, "integrations", "Connection status only; the content of these services is not read", records);
      const staleOnes = rows.filter((i) => i.status === "connected" && i.last_sync_at && ctx.now.getTime() - new Date(i.last_sync_at).getTime() > STALE_AFTER_MS);
      if (staleOnes.length) { report.state = "stale"; report.detail = "At least one connected integration has not synced in over 24 hours."; }
      return { ok: true, records, report };
    } catch {
      return failed("integrations");
    }
  },
};

export const ADAPTERS: Record<"tasks" | "activity" | "notifications" | "ai_inbox" | "integrations", SourceAdapter> = {
  tasks: tasksAdapter, activity: activityAdapter, notifications: notificationsAdapter, ai_inbox: aiInboxAdapter, integrations: integrationsAdapter,
};
export type ReadableSource = keyof typeof ADAPTERS;
export const isReadable = (id: SourceId): id is ReadableSource => id in ADAPTERS;

/** Runs the requested adapters (and what they need) in dependency order; independent ones run in parallel. */
export async function retrieve(ctx: BrainChatContext, ids: ReadableSource[]): Promise<Outcomes> {
  const wanted = new Set<ReadableSource>(ids);
  for (const id of ids) for (const dep of ADAPTERS[id].needs ?? []) if (isReadable(dep)) wanted.add(dep);
  const got: Outcomes = {};
  const first = [...wanted].filter((id) => !(ADAPTERS[id].needs?.length));
  await Promise.all(first.map(async (id) => { got[id] = await ADAPTERS[id].retrieve(ctx, got); }));
  const second = [...wanted].filter((id) => ADAPTERS[id].needs?.length);
  await Promise.all(second.map(async (id) => { got[id] = await ADAPTERS[id].retrieve(ctx, got); }));
  return got;
}

/** Sources that have no retrieval adapter. Always unavailable: connection status only changes the stated reason. */
export function unreadableSources(ids: SourceId[], integrations: RetrievedRecord[] | null): SourceReport[] {
  return ids.map((id): SourceReport => {
    if (id === "crm") return { id, label: LABELS.crm, state: "unavailable", reason: "not_connected", detail: "No CRM integration exists." };
    const providers = INTEGRATION_SOURCES[id as keyof typeof INTEGRATION_SOURCES] ?? [];
    const rows = (integrations ?? []).filter((i) => providers.includes(i.ref as IntegrationProvider));
    const connected = rows.filter((i) => i.attrs.integration_status === "connected").map((i) => i.label);
    if (connected.length > 0) {
      return { id, label: LABELS[id], state: "unavailable", reason: "not_implemented", detail: `${connected.join(", ")} shows as connected, but the assistant cannot read it yet.` };
    }
    return { id, label: LABELS[id], state: "unavailable", reason: "not_connected", detail: integrations === null ? "Connection status could not be read." : "Not connected." };
  });
}

/** Display text for a record. Built from the minimal projection only. */
export function recordText(r: RetrievedRecord): string {
  if (r.type !== "task") return r.label;
  const bits = [r.attrs.priority, r.attrs.due_at ? `due ${r.attrs.due_at.slice(0, 10)}` : null, r.attrs.owner ? `for ${r.attrs.owner}` : null].filter(Boolean);
  return bits.length ? `${r.label} (${bits.join(", ")})` : r.label;
}
