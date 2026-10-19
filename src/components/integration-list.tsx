import { Plug } from "lucide-react";
import { IntegrationBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import { INTEGRATION_META, type Integration } from "@/lib/types";

export function IntegrationList({ items, detailed = false }: { items: Integration[]; detailed?: boolean }) {
  return (
    <ul className={detailed ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "divide-y divide-line -my-2"}>
      {items.map((i) => (
        <li key={i.provider} className={detailed ? "rounded-lg border border-line bg-surface p-4 shadow-card" : "flex items-center justify-between py-2.5 text-sm"}>
          {detailed ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium text-ink"><Plug size={16} className="text-muted" aria-hidden />{INTEGRATION_META[i.provider]}</span>
                <IntegrationBadge status={i.status} />
              </div>
              <p className="mt-3 text-xs text-muted">
                {i.status === "connected" ? `Last sync: ${i.last_sync_at ? formatDateTime(i.last_sync_at) : "not yet synced"}`
                  : i.status === "error" ? `Error: ${i.last_error ?? "unknown"}`
                  : i.status === "disconnected" ? "Disconnected. Reconnect to resume syncing."
                  : "No connection verified yet. Setup is required."}
              </p>
            </>
          ) : (
            <>
              <span className="text-ink">{INTEGRATION_META[i.provider]}</span>
              <IntegrationBadge status={i.status} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
