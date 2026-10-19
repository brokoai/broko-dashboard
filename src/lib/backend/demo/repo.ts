import "server-only";
import { randomUUID } from "node:crypto";
import { isActive, isDueToday, isOverdue } from "@/lib/dates";
import { canAssignTo } from "@/lib/permissions";
import type {
  ActivityEvent, AppNotification, Integration, Person, Profile, Task, TaskCounts, TaskInput, TeamMember,
} from "@/lib/types";
import { INTEGRATION_ORDER } from "@/lib/types";
import { UserFacingError, type Repo } from "../types";

/**
 * DEMO BACKEND ONLY. In-memory, resets on server restart. All names are
 * placeholders and are not real Broko employees. Never loaded in production.
 */
export const DEMO_USERS: Profile[] = [
  { id: "demo-admin", full_name: "Demo Administrator", email: null, role: "admin", title: "Application Administrator" },
  { id: "demo-member-a", full_name: "Demo Member A", email: null, role: "member", title: null },
  { id: "demo-member-b", full_name: "Demo Member B", email: null, role: "member", title: null },
];

interface Store { tasks: Task[]; events: ActivityEvent[]; notifications: Map<string, AppNotification[]> }

const day = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();
const nameOf = (id: string | null) => DEMO_USERS.find((u) => u.id === id)?.full_name ?? null;

function logEvent(s: Store, e: Pick<ActivityEvent, "event_type" | "description" | "actor_id" | "related_task_id">) {
  const t = s.tasks.find((x) => x.id === e.related_task_id);
  s.events.unshift({ ...e, id: randomUUID(), status: "processed", related_task_title: t?.title ?? null, created_at: new Date().toISOString() });
}

function seed(): Store {
  const s: Store = { tasks: [], events: [], notifications: new Map() };
  const rows: [string, TaskInput["status"], TaskInput["priority"], string | null, number | null][] = [
    ["[Demo] Review sample proposal", "open", "high", "demo-member-a", 0],
    ["[Demo] Follow up on sample enquiry", "in_progress", "urgent", "demo-member-b", -2],
    ["[Demo] Update sample record", "open", "medium", "demo-admin", 1],
    ["[Demo] Prepare sample deck", "completed", "low", "demo-member-a", -3],
    ["[Demo] Schedule sample visit", "open", "low", "demo-member-b", 5],
  ];
  for (const [title, status, priority, assigned_to, due] of rows) {
    const created = iso(-4);
    s.tasks.push({
      id: randomUUID(), title, description: null, status, priority, assigned_to,
      assignee_name: nameOf(assigned_to), created_by: "demo-admin",
      due_at: due === null ? null : iso(due), source: "manual", external_reference: null,
      created_at: created, updated_at: created,
      completed_at: status === "completed" ? iso(-3) : null,
    });
    const t = s.tasks[s.tasks.length - 1];
    logEvent(s, { event_type: "task_created", description: `Task created: ${title}`, actor_id: "demo-admin", related_task_id: t.id });
  }
  return s;
}

const g = globalThis as unknown as { __brokoDemo?: Store };
const store = (): Store => (g.__brokoDemo ??= seed());
/** Test helper: discard in-memory state. */
export const resetDemoStore = () => { g.__brokoDemo = undefined; };

export function createDemoRepo(user: Profile): Repo {
  const admin = user.role === "admin";
  const visible = (t: Task) => admin || t.assigned_to === user.id || t.created_by === user.id;
  const visibleTasks = () => store().tasks.filter(visible);
  // Resolve titles at read time so renamed tasks show their current name (as a SQL join would).
  const withTitles = (events: ActivityEvent[]) =>
    events.map((e) => ({ ...e, related_task_title: store().tasks.find((t) => t.id === e.related_task_id)?.title ?? e.related_task_title }));

  return {
    async listTasks() { return visibleTasks().map((t) => ({ ...t })); },
    async getTask(id) {
      const t = store().tasks.find((x) => x.id === id && visible(x));
      return t ? { ...t } : null;
    },
    async taskCounts(): Promise<TaskCounts> {
      const ts = visibleTasks();
      return {
        open: ts.filter(isActive).length,
        due_today: ts.filter(isDueToday).length,
        overdue: ts.filter(isOverdue).length,
        completed: ts.filter((t) => t.status === "completed").length,
      };
    },
    async createTask(input) {
      const s = store();
      // Mirrors the database rule a real backend must enforce itself.
      if (!canAssignTo(user, input.assigned_to)) throw new UserFacingError("Only administrators can assign tasks to other people.");
      const now = new Date().toISOString();
      const t: Task = {
        id: randomUUID(), ...input, assignee_name: nameOf(input.assigned_to), created_by: user.id,
        source: "manual", external_reference: null, created_at: now, updated_at: now,
        completed_at: input.status === "completed" ? now : null,
      };
      s.tasks.unshift(t);
      logEvent(s, { event_type: "task_created", description: `Task created: ${t.title}`, actor_id: user.id, related_task_id: t.id });
      if (t.assigned_to) logEvent(s, { event_type: "task_assigned", description: `Task assigned: ${t.title}`, actor_id: user.id, related_task_id: t.id });
      return { ...t };
    },
    async updateTask(id, patch) {
      const s = store();
      const t = s.tasks.find((x) => x.id === id && visible(x));
      if (!t) throw new UserFacingError("Task not found.");
      if (patch.assigned_to !== undefined && patch.assigned_to !== t.assigned_to && !canAssignTo(user, patch.assigned_to)) {
        throw new UserFacingError("Only administrators can assign tasks to other people.");
      }
      const before = { status: t.status, assigned_to: t.assigned_to };
      Object.assign(t, patch);
      t.assignee_name = nameOf(t.assigned_to);
      t.updated_at = new Date().toISOString();
      t.completed_at = t.status === "completed" ? (before.status === "completed" ? t.completed_at : t.updated_at) : null;
      if (t.assigned_to && t.assigned_to !== before.assigned_to) {
        logEvent(s, { event_type: "task_assigned", description: `Task assigned: ${t.title}`, actor_id: user.id, related_task_id: t.id });
        const list = s.notifications.get(t.assigned_to) ?? [];
        list.unshift({ id: randomUUID(), title: `Task assigned to you: ${t.title}`, created_at: t.updated_at, read_at: null });
        s.notifications.set(t.assigned_to, list);
      }
      if (t.status !== before.status) {
        logEvent(s, { event_type: t.status === "completed" ? "task_completed" : "task_updated", description: `Task "${t.title}" status: ${before.status} -> ${t.status}`, actor_id: user.id, related_task_id: t.id });
      }
      return { ...t };
    },
    async listPeople(): Promise<Person[]> { return DEMO_USERS.map(({ id, full_name }) => ({ id, full_name })); },
    async listActivity(limit) {
      const s = store();
      const ids = new Set(visibleTasks().map((t) => t.id));
      return withTitles(
        s.events
          .filter((e) => admin || e.actor_id === user.id || (e.related_task_id && ids.has(e.related_task_id)))
          .slice(0, limit),
      );
    },
    async listTaskActivity(taskId, limit) {
      const s = store();
      if (!s.tasks.some((t) => t.id === taskId && visible(t))) return [];
      return withTitles(s.events.filter((e) => e.related_task_id === taskId).slice(0, limit));
    },
    async listIntegrations(): Promise<Integration[]> {
      return INTEGRATION_ORDER.map((provider) => ({ provider, status: "pending_setup", last_sync_at: null, last_error: null }));
    },
    async teamWorkload(): Promise<TeamMember[]> {
      const all = store().tasks;
      return DEMO_USERS.map((u) => {
        const mine = all.filter((t) => t.assigned_to === u.id);
        return {
          member_id: u.id, full_name: u.full_name, title: u.title, role: u.role,
          assigned_count: mine.length,
          open_count: mine.filter((t) => t.status === "open" || t.status === "in_progress").length,
          completed_count: mine.filter((t) => t.status === "completed").length,
        };
      });
    },
    async listNotifications() { return store().notifications.get(user.id) ?? []; },
  };
}
