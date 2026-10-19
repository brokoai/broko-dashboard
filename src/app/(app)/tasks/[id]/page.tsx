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
    <div><dt className="text-xs font-medium uppercase tracking-wider text-muted">{label}</dt><dd className="mt-1 text-sm text-ink">{value}</dd></div>
  );
  return (
    <>
      <Link href="/tasks" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Back to tasks</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{task.title}</h1>
        <TaskDetailActions task={task} people={people} user={user} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <dl className="grid gap-5 sm:grid-cols-3">
            {row("Status", <StatusBadge status={task.status} />)}
            {row("Priority", <PriorityBadge priority={task.priority} />)}
            {row("Assigned owner", task.assignee_name ?? "Unassigned")}
            {row("Due date", formatDate(task.due_at))}
            {row("Created", formatDateTime(task.created_at))}
            {row("Completed", task.completed_at ? formatDateTime(task.completed_at) : "—")}
            {row("Source", task.source)}
          </dl>
          <h2 className="mt-6 text-xs font-medium uppercase tracking-wider text-muted">Description</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{task.description || <span className="text-muted">No description.</span>}</p>
        </Card>
        <Card title="History"><ActivityFeed events={history} emptyTitle="No history" emptyText="Changes to this task will be recorded here." /></Card>
      </div>
    </>
  );
}
