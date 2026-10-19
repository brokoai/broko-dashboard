"use server";

import { revalidatePath } from "next/cache";
import { getRepo, requireUser } from "@/lib/auth";
import { UserFacingError } from "@/lib/backend/types";
import { checkTaskChange } from "@/lib/permissions";
import { TASK_PRIORITIES, TASK_STATUSES } from "@/lib/types";
import type { TaskInput, TaskPriority, TaskStatus } from "@/lib/types";

export interface TaskActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<"title" | "due_at", string>>;
}

/** Show UserFacingError text; log and hide everything else (no database details to the browser). */
function toMessage(e: unknown, fallback: string): string {
  if (e instanceof UserFacingError) return e.message;
  console.error("[tasks]", e);
  return fallback;
}

function parse(form: FormData): { input?: TaskInput; state?: TaskActionState } {
  const title = String(form.get("title") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const status = String(form.get("status") ?? "open") as TaskStatus;
  const priority = String(form.get("priority") ?? "medium") as TaskPriority;
  const assigned = String(form.get("assigned_to") ?? "");
  const due = String(form.get("due_at") ?? "");

  const fieldErrors: TaskActionState["fieldErrors"] = {};
  if (!title) fieldErrors.title = "Title is required.";
  else if (title.length > 200) fieldErrors.title = "Title must be 200 characters or fewer.";
  let due_at: string | null = null;
  if (due) {
    const d = new Date(due);
    if (Number.isNaN(d.getTime())) fieldErrors.due_at = "Enter a valid date.";
    else due_at = d.toISOString();
  }
  if (Object.keys(fieldErrors).length) return { state: { fieldErrors } };
  if (!TASK_STATUSES.includes(status) || !TASK_PRIORITIES.includes(priority)) {
    return { state: { error: "Invalid status or priority." } };
  }
  return { input: { title, description: description || null, status, priority, assigned_to: assigned || null, due_at } };
}

export async function createTask(_prev: TaskActionState, form: FormData): Promise<TaskActionState> {
  const user = await requireUser(); // authenticate before touching any input
  const { input, state } = parse(form);
  if (!input) return state!;
  const denied = checkTaskChange(user, null, input);
  if (denied) return { error: denied };
  try {
    await (await getRepo(user)).createTask(input);
  } catch (e) {
    return { error: toMessage(e, "Could not create the task. Please try again.") };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Loads the task through the user-scoped repo (so invisible tasks look nonexistent), then applies the shared rules. */
async function changeTask(id: string, patch: Partial<TaskInput>): Promise<string | null> {
  const user = await requireUser();
  const repo = await getRepo(user);
  try {
    const current = await repo.getTask(id);
    if (!current) return "Task not found.";
    const denied = checkTaskChange(user, current, patch);
    if (denied) return denied;
    await repo.updateTask(id, patch);
  } catch (e) {
    return toMessage(e, "Could not update the task. Please try again.");
  }
  revalidatePath("/", "layout");
  return null;
}

export async function updateTask(id: string, _prev: TaskActionState, form: FormData): Promise<TaskActionState> {
  await requireUser(); // authenticate before touching any input
  const { input, state } = parse(form);
  if (!input) return state!;
  const error = await changeTask(id, input);
  return error ? { error } : { ok: true };
}

export async function setTaskStatus(id: string, status: TaskStatus): Promise<{ error?: string }> {
  await requireUser(); // authenticate before touching any input
  if (!TASK_STATUSES.includes(status)) return { error: "Invalid status." };
  const error = await changeTask(id, { status });
  return error ? { error } : {};
}
