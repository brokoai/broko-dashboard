import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ProjectForm } from "@/components/precon/project-form";
import { Card } from "@/components/ui";
import { preconPage } from "../../_lib";

export default async function NewProjectPage() {
  const { canManage } = await preconPage();
  if (!canManage) redirect("/precon/projects");
  return (
    <>
      <Link href="/precon/projects" className="-ml-2 mb-3 inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> Back to projects</Link>
      <Card title="New project"><ProjectForm /></Card>
    </>
  );
}
