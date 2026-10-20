import { Card, PageTitle } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/types";

export default async function SettingsPage() {
  const user = await requireUser();
  const row = (l: string, v: string) => (
    <div className="min-w-0"><dt className="text-xs font-medium uppercase tracking-wider text-muted">{l}</dt><dd className="mt-1 break-words text-sm text-ink">{v}</dd></div>
  );
  return (
    <>
      <PageTitle title="Profile & settings">Your account details come from your profile record. Role and title can only be changed by an administrator.</PageTitle>
      <Card title="Your profile">
        <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {row("Name", user.full_name || "—")}
          {row("Email", user.email ?? "—")}
          {row("Access level", ROLE_LABEL[user.role])}
          {row("Title", user.title ?? "—")}
        </dl>
      </Card>
    </>
  );
}
