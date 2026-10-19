import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { todayKey } from "@/lib/dates";
import type {
  ActivityEvent, AppNotification, Integration, Person, Task, TaskCounts, TaskInput, TeamMember,
} from "@/lib/types";
import { INTEGRATION_ORDER } from "@/lib/types";
import { UserFacingError, type Repo } from "../types";

// NOT VERIFIED AGAINST A LIVE DATABASE. Every query runs as the signed-in user so
// Row Level Security (see supabase/migrations/0001_init.sql) does the filtering.
const TASK_SELECT = "*, assignee:profiles!tasks_assigned_to_fkey(full_name)";

type TaskRow = Omit<Task, "assignee_name"> & { assignee: { full_name: string } | null };
const toTask = ({ assignee, ...rest }: TaskRow): Task => ({ ...rest, assignee_name: assignee?.full_name ?? null });

function check<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    // 42501 = insufficient_privilege (RLS). Anything else stays internal (logged by the caller).
    if (res.error.code === "42501") throw new UserFacingError("You do not have permission to do that.");
    throw new Error(res.error.message);
  }
  return res.data as T;
}

const ACTIVE = ["open", "in_progress"];

export function createSupabaseRepo(db: SupabaseClient, userId: string): Repo {
  const count = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count: n, error } = await q;
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  const head = () => db.from("tasks").select("id", { count: "exact", head: true });

  return {
    async listTasks() {
      const rows = check(await db.from("tasks").select(TASK_SELECT).order("created_at", { ascending: false }));
      return (rows as unknown as TaskRow[]).map(toTask);
    },
    async getTask(id) {
      const row = check(await db.from("tasks").select(TASK_SELECT).eq("id", id).maybeSingle());
      return row ? toTask(row as unknown as TaskRow) : null;
    },
    async taskCounts(): Promise<TaskCounts> {
      const start = `${todayKey()}T00:00:00.000Z`;
      const end = new Date(new Date(start).getTime() + 86_400_000).toISOString();
      const [open, due_today, overdue, completed] = await Promise.all([
        count(head().in("status", ACTIVE)),
        count(head().in("status", ACTIVE).gte("due_at", start).lt("due_at", end)),
        count(head().in("status", ACTIVE).lt("due_at", start)),
        count(head().eq("status", "completed")),
      ]);
      return { open, due_today, overdue, completed };
    },
    async createTask(input: TaskInput) {
      const row = check(await db.from("tasks").insert({ ...input, created_by: userId }).select(TASK_SELECT).single());
      return toTask(row as unknown as TaskRow);
    },
    async updateTask(id, patch) {
      const row = check(await db.from("tasks").update(patch).eq("id", id).select(TASK_SELECT).maybeSingle());
      if (!row) throw new UserFacingError("Task not found.");
      return toTask(row as unknown as TaskRow);
    },
    async listPeople(): Promise<Person[]> {
      return check(await db.from("profiles").select("id, full_name").order("full_name")) as Person[];
    },
    async listActivity(limit) {
      const rows = check(
        await db.from("activity_events")
          .select("id, event_type, description, status, actor_id, related_task_id, created_at, task:tasks(title)")
          .order("created_at", { ascending: false }).limit(limit),
      ) as unknown as (Omit<ActivityEvent, "related_task_title"> & { task: { title: string } | null })[];
      return rows.map(({ task, ...e }) => ({ ...e, related_task_title: task?.title ?? null }));
    },
    async listTaskActivity(taskId, limit) {
      const rows = check(
        await db.from("activity_events")
          .select("id, event_type, description, status, actor_id, related_task_id, created_at, task:tasks(title)")
          .eq("related_task_id", taskId)
          .order("created_at", { ascending: false }).limit(limit),
      ) as unknown as (Omit<ActivityEvent, "related_task_title"> & { task: { title: string } | null })[];
      return rows.map(({ task, ...e }) => ({ ...e, related_task_title: task?.title ?? null }));
    },
    async listIntegrations() {
      const rows = check(await db.from("integrations").select("provider, status, last_sync_at, last_error")) as Integration[];
      return INTEGRATION_ORDER.map(
        (p) => rows.find((r) => r.provider === p) ?? { provider: p, status: "pending_setup" as const, last_sync_at: null, last_error: null },
      );
    },
    async teamWorkload() {
      const rows = check(await db.rpc("team_workload")) as TeamMember[];
      // bigint counts may arrive as strings depending on the driver
      return rows.map((r) => ({ ...r, assigned_count: Number(r.assigned_count), open_count: Number(r.open_count), completed_count: Number(r.completed_count) }));
    },
    async listNotifications() {
      return check(
        await db.from("notifications").select("id, title, created_at, read_at").order("created_at", { ascending: false }).limit(20),
      ) as AppNotification[];
    },
  };
}
