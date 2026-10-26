import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { RemoveDocumentButton, ReprocessButton } from "@/components/precon/action-buttons";
import { DocStatusBadge } from "@/components/precon/document-list";
import { UploadPanel } from "@/components/precon/upload-panel";
import { Badge, btn, Card } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { extOf, humanSize, UUID_RE } from "@/lib/precon/files";
import { DETAIL_TEXT, DOC_KIND_LABEL } from "@/lib/precon/types";
import { preconPage } from "../../_lib";

export const maxDuration = 60;

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, { precon, canManage }] = await Promise.all([params, preconPage()]);
  if (!UUID_RE.test(id)) notFound();
  const doc = await precon.getDocument(id);
  if (!doc) notFound();
  const [project, pages] = await Promise.all([precon.getProject(doc.project_id), precon.documentPages(id)]);
  const ext = extOf(doc.filename);
  const isImage = ext === "jpg" || ext === "png" || ext === "webp";
  const importable = canManage && (ext === "csv" || ext === "xlsx") && doc.status === "processed";
  const row = (label: string, value: string) => (
    <div className="min-w-0"><dt className="text-xs font-medium uppercase tracking-wider text-muted">{label}</dt><dd className="mt-1 break-words text-sm text-ink">{value}</dd></div>
  );
  return (
    <div className="space-y-4">
      <Link href={project ? `/precon/projects/${project.id}` : "/precon/documents"} className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} aria-hidden /> Back to {project ? project.name : "documents"}
      </Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="break-words text-xl font-semibold tracking-tight text-ink sm:text-2xl">{doc.title}</h2>
          <div className="mt-1 flex flex-wrap gap-1"><Badge>{DOC_KIND_LABEL[doc.kind]}</Badge><DocStatusBadge status={doc.status} /></div>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {doc.has_file && <a href={`/precon/documents/${doc.id}/file`} target="_blank" rel="noopener noreferrer" className={`${btn.base} ${btn.secondary}`}>Open original</a>}
          {doc.has_file && <a href={`/precon/documents/${doc.id}/file?download=1`} className={`${btn.base} ${btn.secondary}`}>Download</a>}
          {importable && <Link href={`/precon/import/${doc.id}`} className={`${btn.base} ${btn.primary}`}>Import as inventory</Link>}
          {canManage && doc.has_file && <ReprocessButton documentId={doc.id} label={doc.status === "failed" || doc.status === "needs_reprocessing" ? "Retry processing" : "Reprocess"} />}
          {canManage && <RemoveDocumentButton documentId={doc.id} projectId={doc.project_id} />}
        </div>
      </div>

      {doc.status_detail && DETAIL_TEXT[doc.status_detail] && (
        <p role="note" className="break-words rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{DETAIL_TEXT[doc.status_detail]}</p>
      )}

      <Card title="Details">
        <dl className="grid grid-cols-1 gap-5 min-[420px]:grid-cols-2 lg:grid-cols-4">
          {row("File name", doc.filename)}
          {row("Size", humanSize(doc.size_bytes))}
          {row("Uploaded", `${formatDate(doc.created_at)}${doc.uploader_name ? ` by ${doc.uploader_name}` : ""}`)}
          {row("Processed", doc.processed_at ? formatDate(doc.processed_at) : "Not yet")}
          {row("Pages", doc.page_count === null ? "—" : String(doc.page_count))}
          {row("Passages indexed", String(doc.chunk_count))}
        </dl>
      </Card>

      {isImage && doc.has_file && (
        <Card title="Preview">
          {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL behind an authenticated redirect; next/image cannot optimise it */}
          <img src={`/precon/documents/${doc.id}/file`} alt={doc.title} className="mx-auto max-h-[70vh] max-w-full rounded border border-line object-contain" />
        </Card>
      )}

      {canManage && doc.has_file && (
        <Card title="Replace this document">
          <p className="mb-3 text-sm text-muted">The old document is removed only after the replacement has been uploaded and processed successfully.</p>
          <UploadPanel projectId={doc.project_id} replaces={doc.id} defaultKind={doc.kind} compact />
        </Card>
      )}

      <Card title="Extracted text">
        {pages.length === 0 ? (
          <p className="text-sm text-muted">{doc.status === "processed" ? "This document has no extracted text." : "Text appears here once the document has been processed."}</p>
        ) : (
          <div className="space-y-4">
            {pages.map((p, i) => (
              <section key={p.page ?? `x${i}`} id={p.page ? `p${p.page}` : undefined} className="scroll-mt-20 rounded-md p-2 target:bg-amber-50 target:ring-2 target:ring-amber-300">
                {p.page && <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Page {p.page}</h3>}
                <p className="whitespace-pre-wrap break-words text-sm text-ink">{p.text}</p>
              </section>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
