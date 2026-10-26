import Link from "next/link";
import { Building2 } from "lucide-react";
import { Badge, btn, Card, EmptyState } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { PROJECT_STATUS_LABEL } from "@/lib/precon/types";
import { preconPage } from "./_lib";

export default async function PreconOverviewPage() {
  const { precon, canManage } = await preconPage();
  const o = await precon.overview();
  // Only persisted counts. "Active developments" = not archived and status pre-construction, selling or under construction.
  const stats: [string, number][] = [
    ["Projects", o.projects], ["Active developments", o.active_developments], ["Inventory records", o.inventory_records],
    ["Available units", o.available_units], ["Documents", o.documents], ["Renderings", o.renderings],
  ];
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {stats.map(([label, n]) => (
          <div key={label} className="min-w-0 rounded-lg border border-line bg-surface p-4 shadow-card">
            <dt className="break-words text-xs font-medium uppercase tracking-wider text-muted">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold text-ink">{n.toLocaleString("en-CA")}</dd>
          </div>
        ))}
      </dl>
      <Card title="Recently updated projects" action={<Link href="/precon/projects" className="text-sm font-medium text-brand underline-offset-2 hover:underline">All projects</Link>}>
        {o.recent.length === 0 ? (
          <EmptyState icon={<Building2 size={20} aria-hidden />} title="No projects yet"
            action={canManage ? <Link href="/precon/projects/new" className={`${btn.base} ${btn.primary}`}>Create the first project</Link> : undefined}>
            {canManage ? "Create a project, then upload its brochure, floor plans and inventory." : "An administrator has not added any projects yet."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {o.recent.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <Link href={`/precon/projects/${p.id}`} className="break-words font-medium text-ink underline-offset-2 hover:underline">{p.name}</Link>
                  <p className="break-words text-sm text-muted">{[p.developer, p.city].filter(Boolean).join(" · ") || "No developer or city recorded"}</p>
                </div>
                <div className="flex items-center gap-2"><Badge tone="blue">{PROJECT_STATUS_LABEL[p.status]}</Badge><span className="text-xs text-muted">Updated {formatDate(p.updated_at)}</span></div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
