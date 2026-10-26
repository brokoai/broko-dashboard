import Link from "next/link";
import { FileText } from "lucide-react";
import { DocumentList } from "@/components/precon/document-list";
import { btn, Card, EmptyState, field } from "@/components/ui";
import { DOC_KINDS, DOC_KIND_LABEL, DOC_STATUS_LABEL, type DocKind, type DocStatus } from "@/lib/precon/types";
import { preconPage } from "../_lib";

type SP = { q?: string; project?: string; kind?: string; status?: string };

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, { precon }] = await Promise.all([searchParams, preconPage()]);
  const [projects, all] = await Promise.all([precon.listProjects(), precon.listDocuments()]);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const q = (sp.q ?? "").trim().toLowerCase();
  const kind = DOC_KINDS.includes(sp.kind as DocKind) ? (sp.kind as DocKind) : "";
  const status = sp.status && sp.status in DOC_STATUS_LABEL ? (sp.status as DocStatus) : "";
  const project = names.has(sp.project ?? "") ? sp.project! : "";
  const docs = all.filter((d) => (!q || `${d.title} ${d.filename}`.toLowerCase().includes(q)) && (!kind || d.kind === kind) && (!status || d.status === status) && (!project || d.project_id === project));
  const filtered = !!(q || kind || status || project);
  return (
    <div className="space-y-4">
      <form method="get" role="search" aria-label="Search documents" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-4">
          <label htmlFor="dq" className="mb-1 block text-xs font-medium text-muted">Search title or file name</label>
          <input id="dq" name="q" type="search" defaultValue={sp.q ?? ""} className={field} />
        </div>
        <div><label htmlFor="dp" className="mb-1 block text-xs font-medium text-muted">Project</label>
          <select id="dp" name="project" defaultValue={project} className={field}><option value="">All projects</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div><label htmlFor="dk" className="mb-1 block text-xs font-medium text-muted">Type</label>
          <select id="dk" name="kind" defaultValue={kind} className={field}><option value="">All types</option>{DOC_KINDS.map((k) => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}</select></div>
        <div><label htmlFor="ds" className="mb-1 block text-xs font-medium text-muted">Status</label>
          <select id="ds" name="status" defaultValue={status} className={field}><option value="">All statuses</option>{Object.entries(DOC_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="flex items-end gap-2">
          <button type="submit" className={`${btn.base} ${btn.primary}`}>Apply</button>
          {filtered && <Link href="/precon/documents" className={`${btn.base} ${btn.secondary}`}>Clear</Link>}
        </div>
      </form>
      <Card>
        {docs.length === 0 ? (
          <EmptyState icon={<FileText size={20} aria-hidden />} title={filtered ? "No documents match" : "No documents yet"}>
            {filtered ? "Try a different search or clear the filters." : "Open a project to upload its brochure, floor plans, price sheets and renderings."}
          </EmptyState>
        ) : <DocumentList docs={docs} projectNames={names} />}
      </Card>
    </div>
  );
}
