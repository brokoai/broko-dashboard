import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ActivityFeed } from "@/components/activity-feed";
import { TaskDetailActions } from "@/components/task-detail-actions";
import { Card, PriorityBadge, StatusBadge } from "@/components/ui";
import { getRepo, requireUser } from "@/lib/auth";
import { formatDate, formatDateTime } from "@/lib/dates";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, user] = await Promise.all([params, requireUser()]);
  const repo = await getRepo(user);
  const task = await repo.getTask(id).catch(() => null);
  if (!task) notFound();
  const [people, history] = await Promise.all([repo.listPeople(), repo.listTaskActivity(task.id, 50)]);
  const row = (label: string, value: ReactNode) => (
    <div className="min-w-0"><dt className="text-xs font-medium uppercase tracking-wider text-muted">{label}</dt><dd className="mt-1 break-words text-sm text-ink">{value}</dd></div>
  );
  return (
    <>
      <Link href="/tasks" className="-ml-2 mb-1 inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> Back to tasks</Link>
      <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-ink sm:text-2xl">{task.title}</h1>
        <TaskDetailActions task={task} people={people} user={user} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <dl className="grid grid-cols-1 gap-5 min-[420px]:grid-cols-2 sm:grid-cols-3">
            {row("Status", <StatusBadge status={task.status} />)}
            {row("Priority", <PriorityBadge priority={task.priority} />)}
            {row("Assigned owner", task.assignee_name ?? "Unassigned")}
            {row("Due date", formatDate(task.due_at))}
            {row("Created", formatDateTime(task.created_at))}
            {row("Completed", task.completed_at ? formatDateTime(task.completed_at) : "—")}
            {row("Source", task.source)}
          </dl>
          <h2 className="mt-6 text-xs font-medium uppercase tracking-wider text-muted">Description</h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{task.description || <span className="text-muted">No description.</span>}</p>
        </Card>
        <Card title="History"><ActivityFeed events={history} emptyTitle="No history" emptyText="Changes to this task will be recorded here." /></Card>
      </div>
    </>
  );
}
