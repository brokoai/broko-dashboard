import { Plug } from "lucide-react";
import { IntegrationList } from "@/components/integration-list";
import { Card, EmptyState, PageTitle } from "@/components/ui";
import { getRepo, requireUser } from "@/lib/auth";

export default async function IntegrationsPage() {
  const user = await requireUser();
  const items = await (await getRepo(user)).listIntegrations();
  const none = items.every((i) => i.status !== "connected");
  return (
    <>
      <PageTitle title="Integrations">A card is shown for each planned integration. Status is “Pending Setup” until a real connection has been verified. No credentials are ever shown here.</PageTitle>
      {none && (
        <Card className="mb-4">
          <EmptyState icon={<Plug size={22} />} title="No integrations connected">
            Connections are set up outside the dashboard in a later phase. An integration only shows “Connected” after a real connection check succeeds; it can never be switched on by hand here.
          </EmptyState>
        </Card>
      )}
      <IntegrationList items={items} detailed />
    </>
  );
}
