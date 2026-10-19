import Link from "next/link";
import {
  AlertTriangle, Bell, CheckCircle2, ClipboardPlus, Mail, MessageSquare, Sparkles, UserPlus, Pencil,
  Activity, type LucideIcon,
} from "lucide-react";
import { Badge, EmptyState } from "@/components/ui";
import { timeAgo } from "@/lib/dates";
import type { ActivityEvent, EventType } from "@/lib/types";

const ICON: Record<EventType, LucideIcon> = {
  email_received: Mail, message_classified: MessageSquare, potential_task_identified: Sparkles,
  task_created: ClipboardPlus, task_assigned: UserPlus, task_updated: Pencil, task_completed: CheckCircle2,
  notification_sent: Bell, workflow_failed: AlertTriangle,
};

export function ActivityFeed({ events, emptyTitle = "No activity yet", emptyText = "Task activity will appear here as work happens in the dashboard." }: {
  events: ActivityEvent[]; emptyTitle?: string; emptyText?: string;
}) {
  if (events.length === 0) {
    return <EmptyState icon={<Activity size={22} />} title={emptyTitle}>{emptyText}</EmptyState>;
  }
  return (
    <ol className="-my-2 divide-y divide-line">
      {events.map((e) => {
        const Icon = ICON[e.event_type];
        return (
          <li key={e.id} className="flex gap-3 py-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"><Icon size={16} aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">{e.description}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                <time dateTime={e.created_at}>{timeAgo(e.created_at)}</time>
                {e.related_task_id && e.related_task_title && (
                  <Link href={`/tasks/${e.related_task_id}`} className="truncate text-brand hover:underline">{e.related_task_title}</Link>
                )}
                <Badge tone={e.status === "failed" ? "red" : e.status === "pending" ? "amber" : "green"}>
                  {e.status === "processed" ? "Processed" : e.status === "pending" ? "Pending" : "Failed"}
                </Badge>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
