import type { ReactNode } from "react";
import { Building2 } from "lucide-react";
import { PreconTabs } from "@/components/precon/precon-tabs";
import { EmptyState, PageTitle } from "@/components/ui";
import { preconContext } from "./_lib";

export default async function PreconLayout({ children }: { children: ReactNode }) {
  const ctx = await preconContext();
  return (
    <>
      <PageTitle title="Pre-Construction Advisor">Projects, documents and GTA inventory, available to Broko AI with sources.</PageTitle>
      {!ctx.repo ? (
        <EmptyState icon={<Building2 size={20} aria-hidden />} title="Pre-Construction is not connected">
          This environment has no Pre-Construction data connection yet. Nothing is shown and nothing can be saved.
        </EmptyState>
      ) : (
        <>
          {!ctx.repo.writable && (
            <p role="note" className="mb-4 break-words rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Sample data. These projects, documents and prices are invented for the demo, and this section is read-only here.
            </p>
          )}
          <PreconTabs />
          {children}
        </>
      )}
    </>
  );
}
