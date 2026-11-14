import type { ReactNode } from "react";
import { BookOpen } from "lucide-react";
import { EmptyState, PageTitle } from "@/components/ui";
import { knowledgeContext } from "./_lib";

export default async function KnowledgeLayout({ children }: { children: ReactNode }) {
  const ctx = await knowledgeContext();
  return (
    <>
      <PageTitle title="Organizational Knowledge">Decisions, corrections, procedures and project notes that Broko AI can use once an administrator approves them.</PageTitle>
      {!ctx.repo ? (
        <EmptyState icon={<BookOpen size={20} aria-hidden />} title="Knowledge is not connected">
          This environment has no knowledge data connection yet. Nothing is shown and nothing can be saved. Broko AI keeps working without it.
        </EmptyState>
      ) : (
        <>
          {!ctx.repo.writable && (
            <p role="note" className="mb-4 break-words rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Sample data. These items are invented for the demo. Nothing you do here is saved, and submitting or reviewing is turned off.
            </p>
          )}
          {children}
        </>
      )}
    </>
  );
}
