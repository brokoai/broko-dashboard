import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ProjectForm } from "@/components/precon/project-form";
import { Card } from "@/components/ui";
import { UUID_RE } from "@/lib/precon/files";
import { preconPage } from "../../../_lib";

export default async function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, { precon, canManage }] = await Promise.all([params, preconPage()]);
  if (!UUID_RE.test(id)) notFound();
  const project = await precon.getProject(id);
  if (!project) notFound();
  if (!canManage) redirect(`/precon/projects/${id}`);
  return (
    <>
      <Link href={`/precon/projects/${id}`} className="-ml-2 mb-3 inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> Back to project</Link>
      <Card title="Edit project"><ProjectForm project={project} /></Card>
    </>
  );
}
