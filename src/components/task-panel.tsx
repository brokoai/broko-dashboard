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
  const item = "flex min-h-11 w-full items-center rounded px-3 py-2 text-left text-sm hover:bg-page md:min-h-0 md:py-1.5";
  return (
    <details data-dismissable className="relative">
      <summary aria-label={`Actions for ${task.title}`} className={cx("flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded text-muted hover:bg-page md:h-8 md:w-8", pending && "opacity-50")}>
        <MoreHorizontal size={18} aria-hidden />
      </summary>
      <div className="absolute right-0 z-10 mt-1 w-52 max-w-[calc(100vw-2rem)] rounded-md border border-line bg-surface p-1 shadow-lg md:w-48">
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
  // 16px text and 44px height on phones (no iOS zoom-on-focus, easy to tap); compact from `sm` up.
  const control = "min-h-11 rounded-md border border-line bg-surface px-2.5 py-1.5 text-base sm:min-h-0 sm:text-sm";
  const select = cx(control, "shrink-0");

  return (
    <Card
      title={title}
      action={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {compact && <Link href="/tasks" className="inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline sm:min-h-0">View all →</Link>}
          <button type="button" onClick={() => setDialog({ open: true })} className={cx(btn.base, btn.primary)}><Plus size={16} aria-hidden /> Create Task</button>
        </div>
      }
    >
      <div role="tablist" aria-label="Task status" className="-mx-1 mb-4 flex gap-1 overflow-x-auto overscroll-x-contain border-b border-line px-1 [scrollbar-width:thin]">
        {TABS.map((t) => {
          const n = scoped.filter((x) => matchTab(x, t.id)).length;
          return (
            <button key={t.id} role="tab" aria-selected={tab === t.id} type="button" onClick={() => setTab(t.id)}
              className={cx("-mb-px min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium sm:min-h-0", tab === t.id ? "border-brand text-brand" : "border-transparent text-muted hover:text-fg")}>
              {t.label} <span className="text-xs">({n})</span>
            </button>
          );
        })}
      </div>

      {!compact && (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <label className="sr-only" htmlFor="tp-q">Search tasks</label>
          <input id="tp-q" type="search" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, description, owner…" className={cx(control, "w-full sm:min-w-56 sm:flex-1")} />
          {/* On phones the three filters sit in one horizontally scrollable row; from `sm` up they join the main row. */}
          <div className="-mx-1 flex gap-2 overflow-x-auto overscroll-x-contain px-1 pb-1 [scrollbar-width:thin] sm:contents">
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
        <>
        {/* Phones: one card per task, every field and action preserved (no sideways scrolling). */}
        <ul aria-label="Tasks" className="space-y-3 md:hidden">
          {visible.map((t) => (
            <li key={t.id} className="min-w-0 rounded-lg border border-line p-3">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/tasks/${t.id}`} className="flex min-h-11 min-w-0 flex-1 items-center break-words text-base font-medium leading-snug text-ink hover:text-brand">{t.title}</Link>
                <RowMenu task={t} onEdit={() => setDialog({ open: true, task: t })} onError={setError} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <PriorityBadge priority={t.priority} />
                <StatusBadge status={t.status} />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 text-sm">
                <div className="col-span-2 min-w-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Owner</dt>
                  <dd className="mt-1 flex min-w-0 items-center gap-2 break-words">
                    {t.assignee_name ? <><Avatar name={t.assignee_name} size={24} /><span className="min-w-0 break-words">{t.assignee_name}</span></> : <span className="text-muted">Unassigned</span>}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Due</dt>
                  <dd className={cx("mt-1", isOverdue(t) && "font-medium text-brand", !isActive(t) && "text-muted")}>{isDueToday(t) ? "Today" : formatDate(t.due_at)}</dd>
                </div>
                {!compact && (
                  <div className="min-w-0">
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Created</dt>
                    <dd className="mt-1 text-muted">{formatDate(t.created_at)}</dd>
                  </div>
                )}
              </dl>
            </li>
          ))}
        </ul>

        {/* Tablet and desktop: the original table. `relative` keeps the sr-only header from escaping the scroller. */}
        <div className="relative hidden overflow-x-auto md:block">
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
                  <td className="max-w-xs break-words py-3 pr-3"><Link href={`/tasks/${t.id}`} className="font-medium text-ink hover:text-brand">{t.title}</Link></td>
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
        </>
      )}

      <TaskDialog open={dialog.open} task={dialog.task} people={people} user={user} onClose={() => setDialog({ open: false })} />
    </Card>
  );
}
