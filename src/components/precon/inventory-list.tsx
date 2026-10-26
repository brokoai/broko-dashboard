import Link from "next/link";
import { VerifyButton } from "@/components/precon/action-buttons";
import { Badge } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { areaLabel, bathsLabel, bedsLabel, isStale, money } from "@/lib/precon/format";
import { AVAILABILITY_LABEL, type Availability, type InventoryListItem } from "@/lib/precon/types";

const TONE: Record<Availability, "green" | "amber" | "neutral" | "blue"> = { available: "green", reserved: "amber", sold: "neutral", unknown: "blue" };

function Flags({ u, now }: { u: InventoryListItem; now: number }) {
  return (
    <>
      {u.verified_at ? <Badge tone="green">Verified</Badge> : <Badge>Unverified</Badge>}
      {isStale(u.updated_at, now) && <Badge tone="amber">May be outdated</Badge>}
    </>
  );
}

/** Desktop: a table. Phone and tablet: one stacked card per unit, so there is never a wide table to scroll. */
export function InventoryList({ items, canManage, showProject = true, now }: { items: InventoryListItem[]; canManage: boolean; showProject?: boolean; now: number }) {
  const showUnit = items.some((u) => u.unit_number);
  return (
    <>
      <ul className="space-y-3 lg:hidden" aria-label="Inventory">
        {items.map((u) => (
          <li key={u.id} className="min-w-0 rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-base font-semibold text-ink">{money(u.price, u.currency)}</p>
                <p className="break-words text-sm text-fg">{u.unit_type ?? bedsLabel(u)}{u.unit_number ? ` · Unit ${u.unit_number}` : ""}</p>
              </div>
              <Badge tone={TONE[u.availability]}>{AVAILABILITY_LABEL[u.availability]}</Badge>
            </div>
            {showProject && (
              <p className="mt-1 break-words text-sm text-muted">
                <Link href={`/precon/projects/${u.project_id}`} className="underline underline-offset-2">{u.project_name}</Link>
                {u.project_developer ? ` · ${u.project_developer}` : ""}{u.project_city ? ` · ${u.project_city}` : ""}
              </p>
            )}
            <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <div><dt className="text-xs text-muted">Bedrooms</dt><dd>{bedsLabel(u)}</dd></div>
              <div><dt className="text-xs text-muted">Bathrooms</dt><dd>{bathsLabel(u.bathrooms)}</dd></div>
              <div><dt className="text-xs text-muted">Area</dt><dd>{areaLabel(u.area_sqft)}</dd></div>
              <div className="col-span-3"><dt className="text-xs text-muted">Expected occupancy</dt><dd>{formatDate(u.expected_occupancy)}</dd></div>
            </dl>
            <p className="mt-3 break-words text-xs text-muted">Source: {u.source} · Updated {formatDate(u.updated_at)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2"><Flags u={u} now={now} />{canManage && <VerifyButton unitId={u.id} verified={!!u.verified_at} />}</div>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto rounded-lg border border-line bg-surface lg:block">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Inventory</caption>
          <thead className="border-b border-line bg-page text-xs uppercase tracking-wider text-muted">
            <tr>
              {showProject && <th scope="col" className="px-3 py-2 font-medium">Project</th>}
              {showUnit && <th scope="col" className="px-3 py-2 font-medium">Unit</th>}
              <th scope="col" className="px-3 py-2 font-medium">Type</th>
              <th scope="col" className="px-3 py-2 font-medium">Bed / bath</th>
              <th scope="col" className="px-3 py-2 font-medium">Area</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Price</th>
              <th scope="col" className="px-3 py-2 font-medium">Availability</th>
              <th scope="col" className="px-3 py-2 font-medium">Occupancy</th>
              <th scope="col" className="px-3 py-2 font-medium">Source / updated</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((u) => (
              <tr key={u.id} className="align-top">
                {showProject && (
                  <td className="px-3 py-2">
                    <Link href={`/precon/projects/${u.project_id}`} className="font-medium text-ink underline-offset-2 hover:underline">{u.project_name}</Link>
                    <div className="text-xs text-muted">{[u.project_developer, u.project_city].filter(Boolean).join(" · ")}</div>
                  </td>
                )}
                {showUnit && <td className="px-3 py-2">{u.unit_number ?? "—"}</td>}
                <td className="px-3 py-2">{u.unit_type ?? "—"}</td>
                <td className="whitespace-nowrap px-3 py-2">{bedsLabel(u)} / {bathsLabel(u.bathrooms)}</td>
                <td className="whitespace-nowrap px-3 py-2">{areaLabel(u.area_sqft)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium">{money(u.price, u.currency)}</td>
                <td className="px-3 py-2"><Badge tone={TONE[u.availability]}>{AVAILABILITY_LABEL[u.availability]}</Badge></td>
                <td className="whitespace-nowrap px-3 py-2">{formatDate(u.expected_occupancy)}</td>
                <td className="px-3 py-2 text-xs text-muted">{u.source}<br />{formatDate(u.updated_at)}</td>
                <td className="px-3 py-2"><div className="flex flex-wrap items-center gap-1"><Flags u={u} now={now} />{canManage && <VerifyButton unitId={u.id} verified={!!u.verified_at} />}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
