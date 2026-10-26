import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText } from "lucide-react";
import { ArchiveButton, AskAboutProject } from "@/components/precon/action-buttons";
import { DocumentList } from "@/components/precon/document-list";
import { InventoryList } from "@/components/precon/inventory-list";
import { UploadPanel } from "@/components/precon/upload-panel";
import { Badge, btn, Card, EmptyState } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { UUID_RE } from "@/lib/precon/files";
import { PROJECT_STATUS_LABEL } from "@/lib/precon/types";
import { preconPage } from "../../_lib";

// Uploading runs text extraction in the "finish" server action, which can take a while for a large PDF.
export const maxDuration = 60;

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, { precon, canManage, now }] = await Promise.all([params, preconPage()]);
  if (!UUID_RE.test(id)) notFound();
  const project = await precon.getProject(id);
  if (!project) notFound();
  const [docs, units] = await Promise.all([precon.listDocuments(id), precon.listInventory({ project_id: id, sort: "price_asc" })]);
  const row = (label: string, value: string) => (
    <div className="min-w-0"><dt className="text-xs font-medium uppercase tracking-wider text-muted">{label}</dt><dd className="mt-1 break-words text-sm text-ink">{value}</dd></div>
  );
  return (
    <div className="space-y-4">
      <Link href="/precon/projects" className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> Back to projects</Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="break-words text-xl font-semibold tracking-tight text-ink sm:text-2xl">{project.name}</h2>
          <div className="mt-1 flex flex-wrap gap-1"><Badge tone="blue">{PROJECT_STATUS_LABEL[project.status]}</Badge>{project.archived_at && <Badge>Archived</Badge>}</div>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <AskAboutProject projectId={project.id} projectName={project.name} />
          {canManage && <Link href={`/precon/projects/${project.id}/edit`} className={`${btn.base} ${btn.secondary}`}>Edit</Link>}
          {canManage && <ArchiveButton projectId={project.id} archived={!!project.archived_at} />}
        </div>
      </div>

      <Card title="Details">
        <dl className="grid grid-cols-1 gap-5 min-[420px]:grid-cols-2 lg:grid-cols-4">
          {row("Developer", project.developer ?? "Not recorded")}
          {row("City", project.city ?? "Not recorded")}
          {row("Address", project.address ?? "Not recorded")}
          {row("Expected completion", formatDate(project.expected_completion))}
          {row("Last updated", formatDate(project.updated_at))}
        </dl>
        <h3 className="mt-6 text-xs font-medium uppercase tracking-wider text-muted">Description</h3>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{project.description || <span className="text-muted">No description.</span>}</p>
      </Card>

      <Card title={`Documents & renderings (${docs.length})`}>
        {docs.length === 0 ? (
          <EmptyState icon={<FileText size={20} aria-hidden />} title="No documents yet">
            {canManage ? "Upload a brochure, floor plans, a price sheet or renderings below." : "Nothing has been uploaded for this project yet."}
          </EmptyState>
        ) : <DocumentList docs={docs} />}
        {canManage && !project.archived_at && (
          <details className="mt-4 rounded-md border border-line p-3" open={docs.length === 0}>
            <summary className="min-h-11 cursor-pointer text-sm font-medium text-ink sm:min-h-0">Upload a document</summary>
            <div className="mt-3"><UploadPanel projectId={project.id} /></div>
          </details>
        )}
      </Card>

      <section aria-labelledby="inv-h" className="space-y-3">
        <h3 id="inv-h" className="text-base font-semibold text-ink">Inventory ({units.length})</h3>
        {units.length === 0 ? (
          <Card><EmptyState icon={<FileText size={20} aria-hidden />} title="No inventory recorded">
            {canManage ? "Upload a CSV or XLSX inventory sheet, then open it and choose “Import as inventory”." : "No units have been recorded for this project, so Broko AI cannot answer questions about availability or prices."}
          </EmptyState></Card>
        ) : <InventoryList items={units} canManage={canManage} showProject={false} now={now} />}
      </section>
    </div>
  );
}
