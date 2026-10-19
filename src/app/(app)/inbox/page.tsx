import { Inbox } from "lucide-react";
import { ActivityFeed } from "@/components/activity-feed";
import { Card, EmptyState, PageTitle } from "@/components/ui";
import { getRepo, requireUser } from "@/lib/auth";
import type { EventType } from "@/lib/types";

const AI_EVENTS: EventType[] = ["email_received", "message_classified", "potential_task_identified", "notification_sent", "workflow_failed"];

export default async function InboxPage() {
  const user = await requireUser();
  const events = (await (await getRepo(user)).listActivity(100)).filter((e) => AI_EVENTS.includes(e.event_type));
  return (
    <>
      <PageTitle title="AI Inbox">Emails and messages processed by the AI, and the tasks it identifies. Only real processed records appear here.</PageTitle>
      <Card>
        {events.length === 0 ? (
          <EmptyState icon={<Inbox size={22} />} title="Nothing processed yet">
            The AI automation is not connected in this phase, so no email or message has been processed. Once Outlook/Gmail and the n8n workflow are connected, classified messages and suggested tasks will be listed here.
          </EmptyState>
        ) : <ActivityFeed events={events} />}
      </Card>
    </>
  );
}
