"use client";

import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { setTaskStatus } from "@/app/(app)/tasks/actions";
import { TaskDialog } from "@/components/task-form";
import { btn, cx } from "@/components/ui";
import { STATUS_LABEL, TASK_STATUSES, type Person, type Profile, type Task, type TaskStatus } from "@/lib/types";

export function TaskDetailActions({ task, people, user }: { task: Task; people: Person[]; user: Profile }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const onStatus = (s: TaskStatus) => start(async () => { setError((await setTaskStatus(task.id, s)).error ?? ""); });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="td-status" className="sr-only">Update status</label>
      <select id="td-status" value={task.status} disabled={pending} onChange={(e) => onStatus(e.target.value as TaskStatus)} className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-2 text-base sm:min-h-0 sm:flex-none sm:text-sm">
        {TASK_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
      <button type="button" onClick={() => setOpen(true)} className={cx(btn.base, btn.primary)}><Pencil size={14} aria-hidden /> Edit task</button>
      {error && <p role="alert" className="w-full break-words text-sm text-brand-dark">{error}</p>}
      <TaskDialog open={open} task={task} people={people} user={user} onClose={() => setOpen(false)} />
    </div>
  );
}
