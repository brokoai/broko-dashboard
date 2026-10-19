import { Users } from "lucide-react";
import { Avatar, Badge, Card, EmptyState, PageTitle } from "@/components/ui";
import { company } from "@/config/company";
import { getRepo, requireUser } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/types";

export default async function TeamPage() {
  const user = await requireUser();
  const members = await (await getRepo(user)).teamWorkload();
  return (
    <>
      <PageTitle title="Team Activity">Task counts per team member. Counts only — individual tasks stay visible only to their owner and administrators.</PageTitle>
      <Card title="Leadership" className="mb-4">
        <ul className="flex flex-wrap gap-6">
          {company.leadership.map((l) => (
            <li key={l.name} className="flex items-center gap-3"><Avatar name={l.name} size={36} /><span><span className="block text-sm font-semibold text-ink">{l.name}</span><span className="block text-xs text-muted">{l.title}</span></span></li>
          ))}
        </ul>
      </Card>
      <Card title="Workload">
        {members.length === 0 ? (
          <EmptyState icon={<Users size={22} />} title="No team members yet">Team members appear here once they have signed in and have a profile.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted"><tr><th className="py-2 font-medium">Member</th><th className="font-medium">Assigned</th><th className="font-medium">Open</th><th className="font-medium">Completed</th></tr></thead>
              <tbody className="divide-y divide-line">
                {members.map((m) => (
                  <tr key={m.member_id}>
                    <td className="py-3"><span className="flex items-center gap-3"><Avatar name={m.full_name} size={32} /><span><span className="block font-medium text-ink">{m.full_name}{m.member_id === user.id && " (you)"}</span><span className="block text-xs text-muted">{m.title ?? ROLE_LABEL[m.role]}</span></span></span></td>
                    <td>{m.assigned_count}</td><td>{m.open_count}</td><td>{m.completed_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {members.some((m) => m.role === "admin") && <p className="mt-4"><Badge>Administrators can see all tasks</Badge></p>}
      </Card>
    </>
  );
}
