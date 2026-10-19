import type { Profile, Task, TaskInput } from "@/lib/types";

// Backend-independent business rules. Server actions apply these before any write,
// and the backend (e.g. database RLS) must enforce the same rules independently.

export const canEditTask = (u: Profile, t: Pick<Task, "assigned_to" | "created_by">): boolean =>
  u.role === "admin" || t.assigned_to === u.id || t.created_by === u.id;

/** Administrators may assign to anyone; members only to themselves or nobody. */
export const canAssignTo = (u: Profile, assigneeId: string | null): boolean =>
  u.role === "admin" || assigneeId === null || assigneeId === u.id;

/** Returns a user-facing reason if the change is not allowed, otherwise null. */
export function checkTaskChange(
  u: Profile,
  current: Pick<Task, "assigned_to" | "created_by"> | null,
  patch: Partial<TaskInput>,
): string | null {
  if (current && !canEditTask(u, current)) return "Task not found.";
  const assigneeChanged = patch.assigned_to !== undefined && patch.assigned_to !== (current?.assigned_to ?? null);
  if (assigneeChanged && !canAssignTo(u, patch.assigned_to ?? null)) {
    return "Only administrators can assign tasks to other people.";
  }
  return null;
}
