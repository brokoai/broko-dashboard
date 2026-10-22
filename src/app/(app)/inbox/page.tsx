import { Inbox, ShieldAlert } from "lucide-react";
import { ActivityFeed } from "@/components/activity-feed";
import { AiInboxList } from "@/components/ai-inbox-list";
import { Card, EmptyState, PageTitle } from "@/components/ui";
import { getRepo, requireUser } from "@/lib/auth";
import type { EventType } from "@/lib/types";

const AI_EVENTS: EventType[] = ["email_received", "message_classified", "potential_task_identified", "notification_sent", "workflow_failed"];

export default async function InboxPage() {
  const user = await requireUser();
  const repo = await getRepo(user);

  if (!repo.aiInbox) {
    const events = (await repo.listActivity(100)).filter((e) => AI_EVENTS.includes(e.event_type));
    return (
      <>
        <PageTitle title="AI Inbox">Emails and messages processed by the AI, and the tasks it identifies. Only real processed records appear here.</PageTitle>
        <Card>
          {events.length === 0 ? (
            <EmptyState icon={<Inbox size={22} />} title="Nothing processed yet">
              The AI automation is not connected to this backend, so no email or message has been processed. Once a mail provider and persistent storage are connected, classified messages and suggested tasks will be listed here.
            </EmptyState>
          ) : <ActivityFeed events={events} />}
        </Card>
      </>
    );
  }

  if (user.role !== "admin") {
    return (
      <>
        <PageTitle title="AI Inbox">Review of AI-proposed tasks.</PageTitle>
        <Card>
          <EmptyState icon={<ShieldAlert size={22} />} title="Administrators only">
            AI-proposed tasks are reviewed by administrators. Tasks assigned to you appear under Tasks as usual.
          </EmptyState>
        </Card>
      </>
    );
  }

  const [view, people] = await Promise.all([repo.aiInbox.view(), repo.listPeople()]);
  const count = (...s: string[]) => view.messages.filter((m) => s.includes(m.status)).length;
  const stats = [
    ["Needs review", count("REVIEW_REQUIRED")], ["Tasks created", count("TASK_CREATED", "NOTIFICATION_SENT")],
    ["Rejected", count("REJECTED")], ["No action", count("NO_ACTION")], ["Duplicates suppressed", view.duplicates_suppressed],
  ] as const;
  return (
    <>
      <PageTitle title="AI Inbox">The AI reads incoming messages and proposes tasks. A person approves each one before anything is created.</PageTitle>
      {view.mode === "synthetic" && (
        <div role="note" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Synthetic sample messages. This is not a live mailbox.</p>
          <p className="mt-1">No Outlook or Gmail account is connected and nothing was fetched. These sample emails run through the same analysis and approval flow so you can see how it will work. No reply is ever sent to a sender.</p>
        </div>
      )}
      <p className="mb-4 text-sm text-fg" data-testid="classifier-mode">
        <span className="font-medium">Classifier:</span>{" "}
        {view.classifier.mode === "llm"
          ? `AI model (${view.classifier.model}), with automatic fallback to the rule-based classifier if the model is unavailable or returns invalid output.`
          : "Rule-based (deterministic keyword rules). No AI model is being called."}
        {view.classifier.note && <span className="block text-muted">{view.classifier.note}</span>}
        <span className="block text-muted">In both modes the model never chooses owners or approvals, and a person approves every task.</span>
      </p>
      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map(([label, n]) => (
          <div key={label} className="rounded-lg border border-line bg-surface p-3 shadow-card">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="text-xl font-semibold text-ink">{n}</dd>
          </div>
        ))}
      </dl>
      {view.messages.length === 0 ? (
        <Card><EmptyState icon={<Inbox size={22} />} title="Nothing to review">No messages have been processed.</EmptyState></Card>
      ) : <AiInboxList messages={view.messages} people={people} />}
    </>
  );
}
