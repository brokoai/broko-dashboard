import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ImportWizard } from "@/components/precon/import-wizard";
import { UUID_RE } from "@/lib/precon/files";
import { preconPage } from "../../_lib";

export const maxDuration = 60;

export default async function ImportPage({ params }: { params: Promise<{ documentId: string }> }) {
  const [{ documentId }, { precon, canManage }] = await Promise.all([params, preconPage()]);
  if (!UUID_RE.test(documentId)) notFound();
  const doc = await precon.getDocument(documentId);
  if (!doc) notFound();
  if (!canManage) redirect(`/precon/documents/${documentId}`);
  return (
    <>
      <Link href={`/precon/documents/${documentId}`} className="-ml-2 mb-1 inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> Back to document</Link>
      <h2 className="mb-4 break-words text-xl font-semibold tracking-tight text-ink">Import inventory from {doc.title}</h2>
      <ImportWizard documentId={doc.id} projectId={doc.project_id} />
    </>
  );
}
