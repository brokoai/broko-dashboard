import "server-only";
import { isActive, isDueToday, isOverdue } from "@/lib/dates";
import { canAssignTo } from "@/lib/permissions";
import type {
  AppNotification, Integration, Person, Profile, Task, TaskCounts, TaskInput, TeamMember,
} from "@/lib/types";
import { INTEGRATION_ORDER } from "@/lib/types";
import { UserFacingError, type Repo } from "../types";
import type { ClassifierSelection } from "@/lib/ai-brain";
import { createDemoAiInbox } from "./ai-inbox";
import type { DemoAiRuntime } from "./ai-runtime";
import {
  aiIndexOf, aiTaskId, userIdAt, userIndex, decodeState, encodedSize, encodeState, eventTuple, LIMITS, materialize, newTaskId,
  SEED_IDS, statusIndex, toTuple, type DemoState,
} from "./state";
import { DEMO_USERS } from "./users";

export { DEMO_USERS };

/** Where a visitor's demo changes live (a signed cookie in the app, memory in tests). */
export interface StateStore {
  read(): Promise<string | null | undefined>;
  write(value: string): Promise<void>;
}

export function memoryStore(initial?: string): StateStore & { value: string | undefined } {
  const s = { value: initial, read: async () => s.value, write: async (v: string) => { s.value = v; } };
  return s;
}

const FULL = "Demo storage is full. Use “Reset demo” to start over.";
const nameOf = (id: string | null) => DEMO_USERS.find((u) => u.id === id)?.full_name ?? null;

/** DEMO BACKEND ONLY: synthetic data, per-visitor, bounded. Never connects to anything real. */
export function createDemoRepo(user: Profile, store: StateStore, now: () => number = Date.now, opts: { classifier?: ClassifierSelection; runtime?: DemoAiRuntime } = {}): Repo {
  const admin = user.role === "admin";
  const visible = (t: Task) => admin || t.assigned_to === user.id || t.created_by === user.id;
  const load = async () => decodeState(await store.read());
  const view = async () => materialize(await load(), now());
  const visibleTasks = async () => (await view()).tasks.filter(visible);

  async function save(s: DemoState) {
    if (encodedSize(s) > LIMITS.maxEncodedBytes) throw new UserFacingError(FULL);
    await store.write(encodeState(s));
  }
  function checkText(title: string, description: string | null) {
    if (title.length > LIMITS.title) throw new UserFacingError(`In the demo, titles are limited to ${LIMITS.title} characters.`);
    if ((description ?? "").length > LIMITS.description) throw new UserFacingError(`In the demo, descriptions are limited to ${LIMITS.description} characters.`);
  }
  function upsert(s: DemoState, task: Task) {
    const i = s.t.findIndex((t) => t[0] === task.id);
    if (i >= 0) s.t[i] = toTuple(task);
    else if (s.t.length >= LIMITS.tasks) {
      throw new UserFacingError(`The demo keeps up to ${LIMITS.tasks} changed or new tasks. Use “Reset demo” to start over.`);
    } else s.t.unshift(toTuple(task));
  }
  const pushEvent = (s: DemoState, ev: ReturnType<typeof eventTuple>) => {
    s.e.push(ev);
    while (s.e.length > LIMITS.events) s.e.shift();
  };

  /** Task created from a synthetic AI-inbox message. Deterministic id = idempotent: a repeat creates nothing. */
  async function createAiTask(input: TaskInput, index: number) {
    if (!canAssignTo(user, input.assigned_to)) throw new UserFacingError("Only administrators can assign tasks to other people.");
    checkText(input.title, input.description);
    const s = await load();
    const id = aiTaskId(index);
    if (s.t.some((t) => t[0] === id)) return { task_id: id, created: false };
    const ts = Math.floor(now() / 1000);
    const iso = new Date(ts * 1000).toISOString();
    const task: Task = {
      id, ...input, assignee_name: nameOf(input.assigned_to), created_by: user.id, source: "email",
      external_reference: `synthetic-email:${index}`, created_at: iso, updated_at: iso, completed_at: null,
    };
    upsert(s, task);
    pushEvent(s, eventTuple("task_created", id, ts, user.id));
    if (task.assigned_to) pushEvent(s, eventTuple("task_assigned", id, ts, user.id));
    await save(s);
    return { task_id: id, created: true };
  }

  const aiInbox = createDemoAiInbox({
    user,
    now,
    async decisions() {
      const st = await load();
      const approved = st.t.flatMap((t) => {
        const index = aiIndexOf(t[0]);
        return index === null ? [] : [{ index, task_id: t[0], title: t[1], actor_id: userIdAt(t[7]), assigned_to: t[5] < 0 ? null : userIdAt(t[5]), at: new Date(t[8] * 1000).toISOString() }];
      });
      return { approved, rejected: st.r.map(([index, actor, ts]) => ({ index, actor_id: userIdAt(actor), at: new Date(ts * 1000).toISOString() })) };
    },
    createTask: createAiTask,
    async reject(index) {
      const st = await load();
      if (!st.r.some((r) => r[0] === index)) st.r.push([index, userIndex(user.id), Math.floor(now() / 1000)]);
      await save(st);
    },
  }, opts.classifier, opts.runtime);

  return {
    aiInbox,
    async listTasks() { return visibleTasks(); },
    async getTask(id) { return (await visibleTasks()).find((t) => t.id === id) ?? null; },
    async taskCounts(): Promise<TaskCounts> {
      const ts = await visibleTasks();
      return {
        open: ts.filter(isActive).length,
        due_today: ts.filter(isDueToday).length,
        overdue: ts.filter(isOverdue).length,
        completed: ts.filter((t) => t.status === "completed").length,
      };
    },
    async createTask(input: TaskInput) {
      // Mirrors the rule a real backend must enforce itself.
      if (!canAssignTo(user, input.assigned_to)) throw new UserFacingError("Only administrators can assign tasks to other people.");
      checkText(input.title, input.description);
      const s = await load();
      const ts = Math.floor(now() / 1000);
      const iso = new Date(ts * 1000).toISOString();
      const task: Task = {
        id: newTaskId(), ...input, assignee_name: nameOf(input.assigned_to), created_by: user.id,
        source: "manual", external_reference: null, created_at: iso, updated_at: iso,
        completed_at: input.status === "completed" ? iso : null,
      };
      upsert(s, task);
      pushEvent(s, eventTuple("task_created", task.id, ts, user.id));
      if (task.assigned_to) pushEvent(s, eventTuple("task_assigned", task.id, ts, user.id));
      await save(s);
      return task;
    },
    async updateTask(id, patch) {
      const s = await load();
      const current = materialize(s, now()).tasks.filter(visible).find((t) => t.id === id);
      if (!current) throw new UserFacingError("Task not found.");
      if (patch.assigned_to !== undefined && patch.assigned_to !== current.assigned_to && !canAssignTo(user, patch.assigned_to)) {
        throw new UserFacingError("Only administrators can assign tasks to other people.");
      }
      const next: Task = { ...current, ...patch };
      checkText(next.title, next.description);
      const ts = Math.floor(now() / 1000);
      next.assignee_name = nameOf(next.assigned_to);
      next.updated_at = new Date(ts * 1000).toISOString();
      next.completed_at = next.status === "completed" ? (current.status === "completed" ? current.completed_at : next.updated_at) : null;
      upsert(s, next);
      if (next.assigned_to && next.assigned_to !== current.assigned_to) pushEvent(s, eventTuple("task_assigned", id, ts, user.id));
      if (next.status !== current.status) {
        pushEvent(s, eventTuple(next.status === "completed" ? "task_completed" : "task_updated", id, ts, user.id, statusIndex(current.status), statusIndex(next.status)));
      }
      await save(s);
      return next;
    },
    async listPeople(): Promise<Person[]> { return DEMO_USERS.map(({ id, full_name }) => ({ id, full_name })); },
    async listActivity(limit) {
      const { tasks, events } = await view();
      const ids = new Set(tasks.filter(visible).map((t) => t.id));
      // Same visibility rule for AI events: admins see all; others only events they caused or tied to a task they can see.
      const all = [...events, ...(await aiInbox.activity())].sort((a, b) => b.created_at.localeCompare(a.created_at));
      return all.filter((e) => admin || e.actor_id === user.id || (e.related_task_id && ids.has(e.related_task_id))).slice(0, limit);
    },
    async listTaskActivity(taskId, limit) {
      const { tasks, events } = await view();
      if (!tasks.some((t) => t.id === taskId && visible(t))) return [];
      const all = [...events, ...(await aiInbox.activity(false))].sort((a, b) => b.created_at.localeCompare(a.created_at));
      return all.filter((e) => e.related_task_id === taskId).slice(0, limit);
    },
    async listIntegrations(): Promise<Integration[]> {
      return INTEGRATION_ORDER.map((provider) => ({ provider, status: "pending_setup", last_sync_at: null, last_error: null }));
    },
    async teamWorkload(): Promise<TeamMember[]> {
      const { tasks } = await view();
      return DEMO_USERS.map((u) => {
        const mine = tasks.filter((t) => t.assigned_to === u.id);
        return {
          member_id: u.id, full_name: u.full_name, title: u.title, role: u.role,
          assigned_count: mine.length,
          open_count: mine.filter((t) => t.status === "open" || t.status === "in_progress").length,
          completed_count: mine.filter((t) => t.status === "completed").length,
        };
      });
    },
    async listNotifications(): Promise<AppNotification[]> {
      const { tasks, events } = await view();
      const byId = new Map(tasks.map((t) => [t.id, t]));
      return events
        .filter((e) => e.event_type === "task_assigned" && e.actor_id !== user.id && !SEED_IDS.has(e.related_task_id ?? "")
          && byId.get(e.related_task_id ?? "")?.assigned_to === user.id)
        .slice(0, 20)
        .map((e) => ({ id: e.id, title: `Task assigned to you: ${e.related_task_title}`, created_at: e.created_at, read_at: null }));
    },
  };
}
