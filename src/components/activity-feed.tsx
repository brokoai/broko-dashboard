import Link from "next/link";
import {
  AlertTriangle, Bell, CheckCircle2, ClipboardPlus, Mail, MessageSquare, Sparkles, UserPlus, Pencil,
  Activity, type LucideIcon,
} from "lucide-react";
import { Badge, EmptyState } from "@/components/ui";
import { aiBadges, statusBadge } from "@/lib/activity-presentation";
import { timeAgo } from "@/lib/dates";
import type { ActivityEvent, EventType } from "@/lib/types";

const ICON: Partial<Record<EventType, LucideIcon>> = {
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
        // An event type this build does not know (e.g. added later by a backend) still renders, with a neutral icon.
        const Icon = ICON[e.event_type] ?? Activity;
        const status = statusBadge(e.status);
        return (
          <li key={e.id} className="flex gap-3 py-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"><Icon size={16} aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm text-ink">{e.description}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <time dateTime={e.created_at} className="whitespace-nowrap">{timeAgo(e.created_at)}</time>
                {e.related_task_id && e.related_task_title && (
                  // Padding enlarges the tap area without changing the layout (offset by the negative margin).
                  <Link href={`/tasks/${e.related_task_id}`} className="-my-3.5 inline-flex min-h-11 min-w-0 max-w-full items-center break-words text-brand hover:underline sm:-my-2 sm:min-h-0 sm:py-2">{e.related_task_title}</Link>
                )}
                <Badge tone={status.tone}>{status.label}</Badge>
                {aiBadges(e).map((b) => <Badge key={b.label} tone={b.tone}>{b.label}</Badge>)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
