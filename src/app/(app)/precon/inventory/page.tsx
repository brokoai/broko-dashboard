import Link from "next/link";
import { Building2 } from "lucide-react";
import { InventoryList } from "@/components/precon/inventory-list";
import { btn, Card, EmptyState, field } from "@/components/ui";
import { AVAILABILITIES, AVAILABILITY_LABEL, type Availability, type InventoryFilter, type InventorySort } from "@/lib/precon/types";
import { preconPage } from "../_lib";

type SP = { q?: string; project?: string; city?: string; beds?: string; availability?: string; min?: string; max?: string; sort?: string };
const SORTS: Record<InventorySort, string> = { price_asc: "Price: low to high", price_desc: "Price: high to low", updated_desc: "Recently updated", area_desc: "Largest area" };
const price = (s: string | undefined) => (s && /^\d{1,10}$/.test(s) ? Number(s) : undefined);

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, { precon, canManage, now }] = await Promise.all([searchParams, preconPage()]);
  const projects = await precon.listProjects();
  const cities = [...new Set(projects.map((p) => p.city).filter((c): c is string => !!c))].sort();
  const filter: InventoryFilter = {
    project_id: projects.some((p) => p.id === sp.project) ? sp.project : undefined,
    city: cities.includes(sp.city ?? "") ? sp.city : undefined,
    bedrooms: sp.beds && /^(10|\d)$/.test(sp.beds) ? Number(sp.beds) : undefined,
    availability: AVAILABILITIES.includes(sp.availability as Availability) ? (sp.availability as Availability) : undefined,
    min_price: price(sp.min), max_price: price(sp.max),
    sort: sp.sort && sp.sort in SORTS ? (sp.sort as InventorySort) : "price_asc",
  };
  const all = await precon.listInventory(filter);
  // Free-text search over the fields a person reads on screen. (Exact numbers come from the filters, not from text matching.)
  const q = (sp.q ?? "").trim().toLowerCase();
  const items = q ? all.filter((u) => [u.project_name, u.project_developer, u.project_city, u.unit_type, u.unit_number, u.source].some((v) => (v ?? "").toLowerCase().includes(q))) : all;
  const filtered = !!(q || filter.project_id || filter.city || filter.bedrooms !== undefined || filter.availability || filter.min_price !== undefined || filter.max_price !== undefined);

  return (
    <div className="space-y-4">
      <form method="get" role="search" aria-label="Filter inventory" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-4">
          <label htmlFor="iq" className="mb-1 block text-xs font-medium text-muted">Search</label>
          <input id="iq" name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Project, developer, city, unit type or source" className={field} />
        </div>
        <div className="col-span-2 lg:col-span-1"><label htmlFor="ip" className="mb-1 block text-xs font-medium text-muted">Project</label>
          <select id="ip" name="project" defaultValue={filter.project_id ?? ""} className={field}><option value="">All projects</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div className="col-span-2 lg:col-span-1"><label htmlFor="ic" className="mb-1 block text-xs font-medium text-muted">City</label>
          <select id="ic" name="city" defaultValue={filter.city ?? ""} className={field}><option value="">All cities</option>{cities.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
        <div><label htmlFor="ib" className="mb-1 block text-xs font-medium text-muted">Bedrooms</label>
          <select id="ib" name="beds" defaultValue={filter.bedrooms === undefined ? "" : String(filter.bedrooms)} className={field}><option value="">Any</option><option value="0">Studio</option>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></div>
        <div><label htmlFor="ia" className="mb-1 block text-xs font-medium text-muted">Availability</label>
          <select id="ia" name="availability" defaultValue={filter.availability ?? ""} className={field}><option value="">Any</option>{AVAILABILITIES.map((a) => <option key={a} value={a}>{AVAILABILITY_LABEL[a]}</option>)}</select></div>
        <div><label htmlFor="imin" className="mb-1 block text-xs font-medium text-muted">Min price</label>
          <input id="imin" name="min" inputMode="numeric" pattern="\d*" defaultValue={sp.min ?? ""} className={field} /></div>
        <div><label htmlFor="imax" className="mb-1 block text-xs font-medium text-muted">Max price</label>
          <input id="imax" name="max" inputMode="numeric" pattern="\d*" defaultValue={sp.max ?? ""} className={field} /></div>
        <div className="col-span-2 lg:col-span-1"><label htmlFor="is" className="mb-1 block text-xs font-medium text-muted">Sort by</label>
          <select id="is" name="sort" defaultValue={filter.sort} className={field}>{Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="col-span-2 flex items-end gap-2 lg:col-span-1">
          <button type="submit" className={`${btn.base} ${btn.primary}`}>Apply</button>
          {filtered && <Link href="/precon/inventory" className={`${btn.base} ${btn.secondary}`}>Clear</Link>}
        </div>
      </form>

      <p className="text-sm text-muted" role="status">{items.length} {items.length === 1 ? "unit" : "units"}{filtered ? " match" : ""}. A unit without a recorded price never matches a price filter.</p>
      {items.length === 0 ? (
        <Card><EmptyState icon={<Building2 size={20} aria-hidden />} title={filtered ? "No units match" : "No inventory yet"}>
          {filtered ? "Try wider filters, or clear them." : canManage ? "Open a project, upload a CSV or XLSX inventory sheet and import it." : "No units have been recorded yet. Nothing is estimated or filled in."}
        </EmptyState></Card>
      ) : <InventoryList items={items} canManage={canManage} now={now} />}
    </div>
  );
}
