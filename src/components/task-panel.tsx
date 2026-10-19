"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { CheckSquare, MoreHorizontal, Plus, SearchX } from "lucide-react";
import { setTaskStatus } from "@/app/(app)/tasks/actions";
import { TaskDialog } from "@/components/task-form";
import { Avatar, Card, EmptyState, PriorityBadge, StatusBadge, btn, cx } from "@/components/ui";
import { formatDate, isActive, isDueToday, isOverdue } from "@/lib/dates";
import {
  PRIORITY_LABEL, PRIORITY_RANK, STATUS_LABEL, TASK_PRIORITIES, TASK_STATUSES,
  type Person, type Profile, type Task, type TaskPriority, type TaskStatus,
} from "@/lib/types";

type Tab = "all" | "today" | "overdue" | TaskStatus;
type Sort = "due" | "priority" | "newest" | "title";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "today", label: "Due Today" },
  { id: "overdue", label: "Overdue" },
  { id: "open", label: "Open" },
  { id: "in_progress", label: "In Progress" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
];

const matchTab = (t: Task, tab: Tab) =>
  tab === "all" ? true : tab === "today" ? isDueToday(t) : tab === "overdue" ? isOverdue(t) : t.status === tab;

const sorters: Record<Sort, (a: Task, b: Task) => number> = {
  due: (a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"),
  priority: (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority],
  newest: (a, b) => b.created_at.localeCompare(a.created_at),
  title: (a, b) => a.title.localeCompare(b.title),
};

function RowMenu({ task, onEdit, onError }: { task: Task; onEdit: () => void; onError: (m: string) => void }) {
  const [pending, start] = useTransition();
  const change = (status: TaskStatus, el: HTMLElement) => {
    el.closest("details")?.removeAttribute("open");
    start(async () => {
      const r = await setTaskStatus(task.id, status);
      if (r.error) onError(r.error);
    });
  };
  const item = "block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-page";
  return (
    <details className="relative">
      <summary aria-label={`Actions for ${task.title}`} className={cx("flex cursor-pointer list-none rounded p-1.5 text-muted hover:bg-page", pending && "opacity-50")}>
        <MoreHorizontal size={18} aria-hidden />
      </summary>
      <div className="absolute right-0 z-10 mt-1 w-48 rounded-md border border-line bg-surface p-1 shadow-lg">
        <Link href={`/tasks/${task.id}`} className={item}>View details</Link>
        <button type="button" className={item} onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); onEdit(); }}>Edit task</button>
        <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Set status</p>
        {TASK_STATUSES.filter((s) => s !== task.status).map((s) => (
          <button key={s} type="button" className={item} onClick={(e) => change(s, e.currentTarget)}>{STATUS_LABEL[s]}</button>
        ))}
      </div>
    </details>
  );
}

export function TaskPanel({
  tasks, people, user, compact = false, initialQuery = "", title = "My Tasks",
}: { tasks: Task[]; people: Person[]; user: Profile; compact?: boolean; initialQuery?: string; title?: string }) {
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState(initialQuery);
  const [priority, setPriority] = useState<TaskPriority | "">("");
  const [owner, setOwner] = useState<string>(compact ? "" : "me");
  const [sort, setSort] = useState<Sort>("due");
  const [dialog, setDialog] = useState<{ open: boolean; task?: Task }>({ open: false });
  const [error, setError] = useState("");

  const scoped = useMemo(() => tasks.filter((t) => {
    if (owner === "me" && t.assigned_to !== user.id) return false;
    if (owner === "none" && t.assigned_to) return false;
    if (owner && owner !== "me" && owner !== "none" && t.assigned_to !== owner) return false;
    if (priority && t.priority !== priority) return false;
    const needle = q.trim().toLowerCase();
    return !needle || t.title.toLowerCase().includes(needle) || (t.description ?? "").toLowerCase().includes(needle) || (t.assignee_name ?? "").toLowerCase().includes(needle);
  }), [tasks, owner, priority, q, user.id]);

  const visible = useMemo(() => {
    const rows = scoped.filter((t) => matchTab(t, tab)).sort(sorters[sort]);
    return compact ? rows.slice(0, 6) : rows;
  }, [scoped, tab, sort, compact]);

  const filtered = q.trim() !== "" || priority !== "" || (!compact && owner !== "" ) || tab !== "all";
  const clear = () => { setQ(""); setPriority(""); setOwner(compact ? "" : "me"); setTab("all"); };
  const select = "rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm";

  return (
    <Card
      title={title}
      action={
        <div className="flex items-center gap-2">
          {compact && <Link href="/tasks" className="text-sm font-medium text-brand hover:underline">View all →</Link>}
          <button type="button" onClick={() => setDialog({ open: true })} className={cx(btn.base, btn.primary)}><Plus size={16} aria-hidden /> Create Task</button>
        </div>
      }
    >
      <div role="tablist" aria-label="Task status" className="-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-line px-1">
        {TABS.map((t) => {
          const n = scoped.filter((x) => matchTab(x, t.id)).length;
          return (
            <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}
              className={cx("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", tab === t.id ? "border-brand text-brand" : "border-transparent text-muted hover:text-fg")}>
              {t.label} <span className="text-xs">({n})</span>
            </button>
          );
        })}
      </div>

      {!compact && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="tp-q">Search tasks</label>
          <input id="tp-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, description, owner…" className={cx(select, "min-w-56 flex-1")} />
          <label className="sr-only" htmlFor="tp-owner">Owner</label>
          <select id="tp-owner" value={owner} onChange={(e) => setOwner(e.target.value)} className={select}>
            <option value="me">Assigned to me</option>
            <option value="">Everyone I can see</option>
            <option value="none">Unassigned</option>
            {people.filter((p) => p.id !== user.id).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
          <label className="sr-only" htmlFor="tp-pri">Priority</label>
          <select id="tp-pri" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority | "")} className={select}>
            <option value="">All priorities</option>
            {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
          <label className="sr-only" htmlFor="tp-sort">Sort by</label>
          <select id="tp-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={select}>
            <option value="due">Sort: Due date</option>
            <option value="priority">Sort: Priority</option>
            <option value="newest">Sort: Newest</option>
            <option value="title">Sort: Title A–Z</option>
          </select>
        </div>
      )}

      {error && <p role="alert" className="mb-3 rounded-md bg-brand-soft px-3 py-2 text-sm text-brand-dark">{error}</p>}

      {visible.length === 0 ? (
        tasks.length === 0 ? (
          <EmptyState icon={<CheckSquare size={22} />} title="No tasks yet" action={<button type="button" onClick={() => setDialog({ open: true })} className={cx(btn.base, btn.primary)}><Plus size={16} /> Create your first task</button>}>
            Tasks you create or that are assigned to you will appear here.
          </EmptyState>
        ) : (
          <EmptyState icon={<SearchX size={22} />} title="No matching tasks" action={filtered ? <button type="button" onClick={clear} className={cx(btn.base, btn.secondary)}>Clear search &amp; filters</button> : undefined}>
            Nothing matches the current search or filters. Try a different keyword or clear the filters.
          </EmptyState>
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Task</th><th className="px-3 font-medium">Priority</th><th className="px-3 font-medium">Owner</th>
                <th className="px-3 font-medium">Due</th><th className="px-3 font-medium">Status</th>{!compact && <th className="px-3 font-medium">Created</th>}
                <th className="w-8"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visible.map((t) => (
                <tr key={t.id} className="hover:bg-page/60">
                  <td className="max-w-xs py-3 pr-3"><Link href={`/tasks/${t.id}`} className="font-medium text-ink hover:text-brand">{t.title}</Link></td>
                  <td className="px-3"><PriorityBadge priority={t.priority} /></td>
                  <td className="px-3">{t.assignee_name ? <span className="flex items-center gap-2"><Avatar name={t.assignee_name} size={24} />{t.assignee_name}</span> : <span className="text-muted">Unassigned</span>}</td>
                  <td className={cx("px-3 whitespace-nowrap", isOverdue(t) && "font-medium text-brand", !isActive(t) && "text-muted")}>{isDueToday(t) ? "Today" : formatDate(t.due_at)}</td>
                  <td className="px-3"><StatusBadge status={t.status} /></td>
                  {!compact && <td className="px-3 whitespace-nowrap text-muted">{formatDate(t.created_at)}</td>}
                  <td className="pr-1"><RowMenu task={t} onEdit={() => setDialog({ open: true, task: t })} onError={setError} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TaskDialog open={dialog.open} task={dialog.task} people={people} user={user} onClose={() => setDialog({ open: false })} />
    </Card>
  );
}
