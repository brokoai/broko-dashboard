"use client";

import { useActionState, useEffect, useRef } from "react";
import { createTask, updateTask, type TaskActionState } from "@/app/(app)/tasks/actions";
import { btn, cx, field } from "@/components/ui";
import { dateInputValue } from "@/lib/dates";
import {
  PRIORITY_LABEL, STATUS_LABEL, TASK_PRIORITIES, TASK_STATUSES,
  type Person, type Profile, type Task,
} from "@/lib/types";

const input = cx(field, "mt-1");

function Form({ task, people, user, onDone }: { task?: Task; people: Person[]; user: Profile; onDone: () => void }) {
  const action = task ? updateTask.bind(null, task.id) : createTask;
  const [state, formAction, pending] = useActionState<TaskActionState, FormData>(action, {});
  useEffect(() => { if (state.ok) onDone(); }, [state.ok, onDone]);

  // Members may only assign to themselves; the server and RLS enforce this too.
  const assignable = user.role === "admin" ? people : people.filter((p) => p.id === user.id);

  return (
    <form action={formAction} className="space-y-4 p-4 sm:p-6">
      <h2 id="tf-heading" className="break-words text-lg font-semibold text-ink">{task ? "Edit task" : "Create task"}</h2>
      {state.error && <p role="alert" className="rounded-md bg-brand-soft px-3 py-2 text-sm text-brand-dark">{state.error}</p>}
      <div>
        <label htmlFor="tf-title" className="text-sm font-medium">Title</label>
        <input id="tf-title" name="title" required autoFocus autoComplete="off" autoCapitalize="sentences" enterKeyHint="next" maxLength={200} defaultValue={task?.title} aria-invalid={!!state.fieldErrors?.title} className={input} />
        {state.fieldErrors?.title && <p className="mt-1 text-xs text-brand-dark">{state.fieldErrors.title}</p>}
      </div>
      <div>
        <label htmlFor="tf-desc" className="text-sm font-medium">Description</label>
        <textarea id="tf-desc" name="description" rows={3} autoCapitalize="sentences" defaultValue={task?.description ?? ""} className={input} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="tf-status" className="text-sm font-medium">Status</label>
          <select id="tf-status" name="status" defaultValue={task?.status ?? "open"} className={input}>
            {TASK_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="tf-priority" className="text-sm font-medium">Priority</label>
          <select id="tf-priority" name="priority" defaultValue={task?.priority ?? "medium"} className={input}>
            {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="tf-owner" className="text-sm font-medium">Assigned owner</label>
          <select id="tf-owner" name="assigned_to" defaultValue={task?.assigned_to ?? (task ? "" : user.id)} className={input}>
            <option value="">Unassigned</option>
            {assignable.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.id === user.id ? " (you)" : ""}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="tf-due" className="text-sm font-medium">Due date</label>
          <input id="tf-due" name="due_at" type="date" defaultValue={dateInputValue(task?.due_at ?? null)} aria-invalid={!!state.fieldErrors?.due_at} className={input} />
          {state.fieldErrors?.due_at && <p className="mt-1 text-xs text-brand-dark">{state.fieldErrors.due_at}</p>}
        </div>
      </div>
      {/* Sticky, so Cancel/Save stay reachable on short screens and above the on-screen keyboard. */}
      <div className="sticky bottom-0 -mx-4 -mb-4 flex gap-2 border-t border-line bg-surface px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:-mx-6 sm:-mb-6 sm:justify-end sm:px-6 sm:pb-6">
        <button type="button" onClick={onDone} className={cx(btn.base, btn.secondary, "flex-1 sm:flex-none")}>Cancel</button>
        <button type="submit" disabled={pending} className={cx(btn.base, btn.primary, "flex-1 sm:flex-none")}>{pending ? "Saving…" : task ? "Save changes" : "Create task"}</button>
      </div>
    </form>
  );
}

/**
 * Native <dialog>: focus trapping, Escape to close and a backdrop for free. It never exceeds the
 * visible area (tracks the visual viewport, so it shrinks when a phone keyboard opens) and scrolls
 * inside itself.
 */
export function TaskDialog({ open, task, people, user, onClose }: { open: boolean; task?: Task; people: Person[]; user: Profile; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    const vv = window.visualViewport;
    if (!open || !vv) return;
    const sync = () => d.style.setProperty("--vvh", `${vv.height}px`);
    sync();
    vv.addEventListener("resize", sync);
    return () => { vv.removeEventListener("resize", sync); d.style.removeProperty("--vvh"); };
  }, [open]);
  return (
    <dialog
      ref={ref} onClose={onClose} aria-labelledby="tf-heading"
      className="m-auto max-h-[calc(var(--vvh,100dvh)-1rem)] w-[calc(100vw-1rem)] max-w-lg overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface p-0 shadow-xl backdrop:bg-black/40 sm:w-[32rem]"
    >
      {open && <Form key={task?.id ?? "new"} task={task} people={people} user={user} onDone={onClose} />}
    </dialog>
  );
}
