import Link from "next/link";
import { Badge } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { humanSize } from "@/lib/precon/files";
import { DETAIL_TEXT, DOC_KIND_LABEL, DOC_STATUS_LABEL, type DocStatus, type PreconDocument } from "@/lib/precon/types";

const TONE: Record<DocStatus, "green" | "amber" | "red" | "blue" | "neutral"> = { processed: "green", pending: "neutral", processing: "blue", needs_reprocessing: "amber", failed: "red" };

export const DocStatusBadge = ({ status }: { status: DocStatus }) => <Badge tone={TONE[status]}>{DOC_STATUS_LABEL[status]}</Badge>;

/** Stacked cards at every width: file names are long, so a table would force sideways scrolling on a phone. */
export function DocumentList({ docs, projectNames }: { docs: PreconDocument[]; projectNames?: Map<string, string> }) {
  return (
    <ul className="divide-y divide-line" aria-label="Documents">
      {docs.map((d) => (
        <li key={d.id} className="py-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <Link href={`/precon/documents/${d.id}`} className="min-w-0 break-words font-medium text-ink underline-offset-2 hover:underline">{d.title}</Link>
            <div className="flex flex-wrap gap-1"><Badge>{DOC_KIND_LABEL[d.kind]}</Badge><DocStatusBadge status={d.status} /></div>
          </div>
          <p className="mt-1 break-all text-sm text-muted">{d.filename} · {humanSize(d.size_bytes)}{projectNames?.get(d.project_id) ? ` · ${projectNames.get(d.project_id)}` : ""}</p>
          <p className="text-xs text-muted">
            Uploaded {formatDate(d.created_at)}{d.uploader_name ? ` by ${d.uploader_name}` : ""}
            {d.status === "processed" && d.chunk_count > 0 ? ` · ${d.chunk_count} passages indexed` : ""}
          </p>
          {d.status_detail && DETAIL_TEXT[d.status_detail] && <p className="mt-1 break-words text-xs text-amber-800">{DETAIL_TEXT[d.status_detail]}</p>}
        </li>
      ))}
    </ul>
  );
}
