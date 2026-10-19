"use client";

import { useActionState, useEffect, useRef } from "react";
import { createTask, updateTask, type TaskActionState } from "@/app/(app)/tasks/actions";
import { btn, cx } from "@/components/ui";
import { dateInputValue } from "@/lib/dates";
import {
  PRIORITY_LABEL, STATUS_LABEL, TASK_PRIORITIES, TASK_STATUSES,
  type Person, type Profile, type Task,
} from "@/lib/types";

const field = "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm";

function Form({ task, people, user, onDone }: { task?: Task; people: Person[]; user: Profile; onDone: () => void }) {
  const action = task ? updateTask.bind(null, task.id) : createTask;
  const [state, formAction, pending] = useActionState<TaskActionState, FormData>(action, {});
  useEffect(() => { if (state.ok) onDone(); }, [state.ok, onDone]);

  // Members may only assign to themselves; the server and RLS enforce this too.
  const assignable = user.role === "admin" ? people : people.filter((p) => p.id === user.id);

  return (
    <form action={formAction} className="space-y-4">
      <h2 className="text-lg font-semibold text-ink">{task ? "Edit task" : "Create task"}</h2>
      {state.error && <p role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-sm text-brand-dark">{state.error}</p>}
      <div>
        <label htmlFor="tf-title" className="text-sm font-medium">Title</label>
        <input id="tf-title" name="title" required autoFocus maxLength={200} defaultValue={task?.title} aria-invalid={!!state.fieldErrors?.title} className={field} />
        {state.fieldErrors?.title && <p className="mt-1 text-xs text-brand-dark">{state.fieldErrors.title}</p>}
      </div>
      <div>
        <label htmlFor="tf-desc" className="text-sm font-medium">Description</label>
        <textarea id="tf-desc" name="description" rows={3} defaultValue={task?.description ?? ""} className={field} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="tf-status" className="text-sm font-medium">Status</label>
          <select id="tf-status" name="status" defaultValue={task?.status ?? "open"} className={field}>
            {TASK_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="tf-priority" className="text-sm font-medium">Priority</label>
          <select id="tf-priority" name="priority" defaultValue={task?.priority ?? "medium"} className={field}>
            {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="tf-owner" className="text-sm font-medium">Assigned owner</label>
          <select id="tf-owner" name="assigned_to" defaultValue={task?.assigned_to ?? (task ? "" : user.id)} className={field}>
            <option value="">Unassigned</option>
            {assignable.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.id === user.id ? " (you)" : ""}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="tf-due" className="text-sm font-medium">Due date</label>
          <input id="tf-due" name="due_at" type="date" defaultValue={dateInputValue(task?.due_at ?? null)} aria-invalid={!!state.fieldErrors?.due_at} className={field} />
          {state.fieldErrors?.due_at && <p className="mt-1 text-xs text-brand-dark">{state.fieldErrors.due_at}</p>}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={onDone} className={cx(btn.base, btn.secondary)}>Cancel</button>
        <button type="submit" disabled={pending} className={cx(btn.base, btn.primary)}>{pending ? "Saving…" : task ? "Save changes" : "Create task"}</button>
      </div>
    </form>
  );
}

/** Native <dialog>: gives focus trapping, Escape to close and a backdrop for free. */
export function TaskDialog({ open, task, people, user, onClose }: { open: boolean; task?: Task; people: Person[]; user: Profile; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-6 shadow-xl backdrop:bg-black/40">
      {open && <Form key={task?.id ?? "new"} task={task} people={people} user={user} onDone={onClose} />}
    </dialog>
  );
}
