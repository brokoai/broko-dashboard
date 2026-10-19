import Link from "next/link";
import { ActivityFeed } from "@/components/activity-feed";
import { BrandHeader } from "@/components/brand-header";
import { IntegrationList } from "@/components/integration-list";
import { KpiCards } from "@/components/kpi-cards";
import { TaskPanel } from "@/components/task-panel";
import { Card } from "@/components/ui";
import { getRepo, requireUser } from "@/lib/auth";

export default async function OverviewPage() {
  const user = await requireUser();
  const repo = await getRepo(user);
  const [tasks, counts, people, events, integrations] = await Promise.all([
    repo.listTasks(), repo.taskCounts(), repo.listPeople(), repo.listActivity(6), repo.listIntegrations(),
  ]);
  const connected = integrations.filter((i) => i.status === "connected").length;
  return (
    <>
      <BrandHeader />
      <KpiCards counts={counts} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2"><TaskPanel tasks={tasks} people={people} user={user} compact title="Tasks" /></div>
        <Card title="Activity" action={<Link href="/inbox" className="text-sm font-medium text-brand hover:underline">AI Inbox →</Link>}>
          <ActivityFeed events={events} />
        </Card>
      </div>
      <Card className="mt-4" title="Integrations" action={<Link href="/integrations" className="text-sm font-medium text-brand hover:underline">Manage →</Link>}>
        {connected === 0 && <p className="mb-3 text-sm text-muted">No integrations are connected yet. Each one stays “Pending Setup” until a real connection is verified.</p>}
        <IntegrationList items={integrations} />
      </Card>
    </>
  );
}
