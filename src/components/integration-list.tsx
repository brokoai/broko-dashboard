import { Plug } from "lucide-react";
import { IntegrationBadge } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import { INTEGRATION_META, type Integration } from "@/lib/types";

export function IntegrationList({ items, detailed = false }: { items: Integration[]; detailed?: boolean }) {
  return (
    <ul className={detailed ? "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" : "divide-y divide-line -my-2"}>
      {items.map((i) => (
        <li key={i.provider} className={detailed ? "min-w-0 rounded-lg border border-line bg-surface p-4 shadow-card" : "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5 text-sm"}>
          {detailed ? (
            <>
              {/* Name and status badge sit side by side and stack when there isn't room. */}
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
                <span className="flex min-w-0 items-center gap-2 font-medium text-ink"><Plug size={16} className="shrink-0 text-muted" aria-hidden /><span className="min-w-0 break-words">{INTEGRATION_META[i.provider]}</span></span>
                <IntegrationBadge status={i.status} />
              </div>
              <p className="mt-3 break-words text-xs text-muted">
                {i.status === "connected" ? `Last sync: ${i.last_sync_at ? formatDateTime(i.last_sync_at) : "not yet synced"}`
                  : i.status === "error" ? `Error: ${i.last_error ?? "unknown"}`
                  : i.status === "disconnected" ? "Disconnected. Reconnect to resume syncing."
                  : "No connection verified yet. Setup is required."}
              </p>
            </>
          ) : (
            <>
              <span className="min-w-0 break-words text-ink">{INTEGRATION_META[i.provider]}</span>
              <IntegrationBadge status={i.status} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
