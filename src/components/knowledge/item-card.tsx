import type { ReactNode } from "react";
import { Badge } from "@/components/ui";
import { scanForInjection } from "@/lib/ai-brain/injection";
import { formatDate } from "@/lib/dates";
import { isStale, type ReplacementView } from "@/lib/knowledge/policy";
import { KIND_LABEL, SCOPE_LABEL, STATUS_LABEL, type KnowledgeItem, type KnowledgeStatus } from "@/lib/knowledge/types";

const TONE: Record<KnowledgeStatus, "amber" | "green" | "red" | "neutral"> = { proposed: "amber", approved: "green", rejected: "red", superseded: "neutral", expired: "neutral" };

/** Presentational and free of server imports. Item text is untrusted: React renders it as text, never as markup. */
export function StatusPill({ status }: { status: KnowledgeStatus }) {
  return <Badge tone={TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

/**
 * Says which older item a proposal replaces, by title, because approving it retires that item. The titles are untrusted text and are
 * rendered as text only. A proposal that would be refused (different scope, project or topic) is called out instead of hidden.
 */
export function ReplacementNotice({ view }: { view: ReplacementView }) {
  switch (view.kind) {
    case "none": return null;
    case "will_replace":
      return <p role="note" className="mt-2 break-words rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Replaces the approved item &ldquo;{view.title}&rdquo;. When an administrator approves this, &ldquo;{view.title}&rdquo; is marked superseded and Broko AI stops using it.</p>;
    case "mismatch":
      return <p role="note" className="mt-2 break-words rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">This names &ldquo;{view.title}&rdquo; as the item to replace, but that item applies to a different scope, project or topic. It cannot be approved. Reject it and ask for a new submission.</p>;
    case "inactive":
      return <p role="note" className="mt-2 break-words rounded-md border border-line bg-page px-3 py-2 text-sm text-muted">It was meant to replace &ldquo;{view.title}&rdquo;, which is no longer approved ({STATUS_LABEL[view.status].toLowerCase()}). Approving this will not change that item.</p>;
    case "unavailable":
      return <p role="note" className="mt-2 break-words rounded-md border border-line bg-page px-3 py-2 text-sm text-muted">It names an older item to replace, but that item could not be loaded.</p>;
    case "history":
      return <p className="mt-2 break-words text-xs text-muted">Replaces &ldquo;{view.title}&rdquo;.</p>;
  }
}

export function ItemCard({ item, projectName, now, replacement, children }: { item: KnowledgeItem; projectName?: string | null; now: Date; replacement?: ReplacementView; children?: ReactNode }) {
  const flagged = scanForInjection(item.title, item.body).suspected;
  const stale = item.status === "approved" && isStale(item, now);
  return (
    <article className="min-w-0 rounded-md border border-line bg-surface p-3 sm:p-4" aria-label={`${KIND_LABEL[item.kind]}: ${item.title}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={item.status} />
        <Badge tone="blue">{KIND_LABEL[item.kind]}</Badge>
        <Badge>{item.scope === "project" ? `Project: ${projectName ?? "unavailable"}` : SCOPE_LABEL[item.scope]}</Badge>
        {stale && <Badge tone="amber">Not reviewed for a long time</Badge>}
        {flagged && <Badge tone="red">Contains instruction-like wording</Badge>}
      </div>
      <h3 className="mt-2 break-words text-sm font-semibold text-ink">{item.title}</h3>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg [overflow-wrap:anywhere]">{item.body}</p>
      {replacement && <ReplacementNotice view={replacement} />}
      <p className="mt-2 break-words text-xs text-muted">
        {[
          item.author_name ? `Submitted by ${item.author_name}` : "Submitted", formatDate(item.created_at),
          item.reviewed_at ? `Reviewed${item.reviewer_name ? ` by ${item.reviewer_name}` : ""} ${formatDate(item.reviewed_at)}` : null,
          item.source_ref ? `Source: ${item.source_ref}` : null,
          item.expires_at ? `Expires ${formatDate(item.expires_at)}` : null,
        ].filter(Boolean).join(" · ")}
      </p>
      {item.review_note && <p className="mt-1 break-words text-xs text-muted">Reviewer note: {item.review_note}</p>}
      {children}
    </article>
  );
}
