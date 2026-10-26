import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { Badge, btn, Card, EmptyState, field } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL, type PreconProject, type ProjectStatus } from "@/lib/precon/types";
import { preconPage } from "../_lib";

type SP = { q?: string; status?: string; city?: string; sort?: string; archived?: string };
const SORTS: Record<string, (a: PreconProject, b: PreconProject) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
  completion: (a, b) => (a.expected_completion ?? "9999").localeCompare(b.expected_completion ?? "9999"),
};

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, { precon, canManage, user }] = await Promise.all([searchParams, preconPage()]);
  const includeArchived = sp.archived === "1" && user.role === "admin";
  const all = await precon.listProjects({ includeArchived });
  const q = (sp.q ?? "").trim().toLowerCase();
  const status = PROJECT_STATUSES.includes(sp.status as ProjectStatus) ? (sp.status as ProjectStatus) : "";
  const cities = [...new Set(all.map((p) => p.city).filter((c): c is string => !!c))].sort();
  const city = cities.includes(sp.city ?? "") ? sp.city! : "";
  const sort = sp.sort && sp.sort in SORTS ? sp.sort : "name";
  const rows = all
    .filter((p) => (!q || [p.name, p.developer, p.city, p.address, p.description].some((v) => (v ?? "").toLowerCase().includes(q))) && (!status || p.status === status) && (!city || p.city === city))
    .sort(SORTS[sort]);
  const filtered = !!(q || status || city || includeArchived);

  return (
    <div className="space-y-4">
      <form method="get" role="search" aria-label="Search projects" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="sm:col-span-2">
          <label htmlFor="pq" className="mb-1 block text-xs font-medium text-muted">Search</label>
          <input id="pq" name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Name, developer, city or address" className={field} />
        </div>
        <div>
          <label htmlFor="ps" className="mb-1 block text-xs font-medium text-muted">Status</label>
          <select id="ps" name="status" defaultValue={status} className={field}>
            <option value="">All statuses</option>
            {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{PROJECT_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="pc" className="mb-1 block text-xs font-medium text-muted">City</label>
          <select id="pc" name="city" defaultValue={city} className={field}>
            <option value="">All cities</option>
            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="po" className="mb-1 block text-xs font-medium text-muted">Sort by</label>
          <select id="po" name="sort" defaultValue={sort} className={field}>
            <option value="name">Name</option><option value="updated">Recently updated</option><option value="completion">Expected completion</option>
          </select>
        </div>
        {user.role === "admin" && (
          <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0"><input type="checkbox" name="archived" value="1" defaultChecked={includeArchived} className="h-4 w-4" /> Include archived</label>
        )}
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-4">
          <button type="submit" className={`${btn.base} ${btn.primary}`}>Apply</button>
          {filtered && <Link href="/precon/projects" className={`${btn.base} ${btn.secondary}`}>Clear</Link>}
          {canManage && <Link href="/precon/projects/new" className={`${btn.base} ${btn.secondary} sm:ml-auto`}><Plus size={16} aria-hidden /> New project</Link>}
        </div>
      </form>

      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Building2 size={20} aria-hidden />} title={filtered ? "No projects match" : "No projects yet"}
            action={!filtered && canManage ? <Link href="/precon/projects/new" className={`${btn.base} ${btn.primary}`}>Create a project</Link> : undefined}>
            {filtered ? "Try a different search or clear the filters." : canManage ? "Create a project to start adding documents and inventory." : "An administrator has not added any projects yet."}
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-label="Projects">
          {rows.map((p) => (
            <li key={p.id} className="min-w-0 rounded-lg border border-line bg-surface p-4 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <Link href={`/precon/projects/${p.id}`} className="min-w-0 break-words text-base font-semibold text-ink underline-offset-2 hover:underline">{p.name}</Link>
                <div className="flex gap-1"><Badge tone="blue">{PROJECT_STATUS_LABEL[p.status]}</Badge>{p.archived_at && <Badge>Archived</Badge>}</div>
              </div>
              <p className="mt-1 break-words text-sm text-muted">{[p.developer, p.city].filter(Boolean).join(" · ") || "No developer or city recorded"}</p>
              {p.address && <p className="break-words text-sm text-muted">{p.address}</p>}
              {p.description && <p className="mt-2 line-clamp-2 break-words text-sm text-fg">{p.description}</p>}
              <p className="mt-2 text-xs text-muted">Expected completion {formatDate(p.expected_completion)} · Updated {formatDate(p.updated_at)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
