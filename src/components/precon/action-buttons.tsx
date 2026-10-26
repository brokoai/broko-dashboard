"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { reprocessAction, removeDocumentAction, setProjectArchived, verifyInventoryAction } from "@/app/(app)/precon/actions";
import { btn } from "@/components/ui";

/** One small control that runs a server action, shows its failure in place and refreshes the page on success. */
function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "That did not work.");
      else if (after) after();
      else router.refresh();
    });
  return { pending, error, run };
}

const Err = ({ error }: { error: string | null }) => (error ? <p role="alert" className="mt-1 break-words text-sm text-red-700">{error}</p> : null);

export function ArchiveButton({ projectId, archived }: { projectId: string; archived: boolean }) {
  const { pending, error, run } = useRun();
  return (
    <div>
      <button type="button" disabled={pending} className={`${btn.base} ${btn.secondary}`}
        onClick={() => { if (archived || window.confirm("Archive this project? It is hidden from the directory, the inventory list and Broko AI. Administrators can still open it and restore it. Nothing is deleted.")) run(() => setProjectArchived(projectId, !archived)); }}>
        {archived ? "Restore project" : "Archive project"}
      </button>
      <Err error={error} />
    </div>
  );
}

export function ReprocessButton({ documentId, label = "Reprocess" }: { documentId: string; label?: string }) {
  const { pending, error, run } = useRun();
  return (
    <div>
      <button type="button" disabled={pending} className={`${btn.base} ${btn.secondary}`} onClick={() => run(() => reprocessAction(documentId))}>{pending ? "Processing…" : label}</button>
      <Err error={error} />
    </div>
  );
}

export function RemoveDocumentButton({ documentId, projectId }: { documentId: string; projectId: string }) {
  const router = useRouter();
  const { pending, error, run } = useRun();
  return (
    <div>
      <button type="button" disabled={pending} className={`${btn.base} border border-red-200 bg-surface px-3.5 py-2 text-red-700 hover:bg-red-50`}
        onClick={() => { if (window.confirm("Remove this document? The file and its extracted text are deleted. This cannot be undone.")) run(() => removeDocumentAction(documentId), () => router.push(`/precon/projects/${projectId}`)); }}>
        {pending ? "Removing…" : "Remove"}
      </button>
      <Err error={error} />
    </div>
  );
}

export function VerifyButton({ unitId, verified }: { unitId: string; verified: boolean }) {
  const { pending, error, run } = useRun();
  return (
    <div>
      <button type="button" disabled={pending} className={`${btn.base} ${btn.secondary} !min-h-9 !px-2.5 !py-1 text-xs`} onClick={() => run(() => verifyInventoryAction(unitId, !verified))}>
        {verified ? "Unverify" : "Mark verified"}
      </button>
      <Err error={error} />
    </div>
  );
}

/** Opens the Broko AI chat with a question already scoped to this project. The id is re-validated on the server for every question. */
export function AskAboutProject({ projectId, projectName }: { projectId: string; projectName: string }) {
  return (
    <button type="button" className={`${btn.base} ${btn.primary}`}
      onClick={() => window.dispatchEvent(new CustomEvent("broko:ask-project", { detail: { projectId, projectName } }))}>
      <MessageCircle size={16} aria-hidden /> Ask Broko AI about this project
    </button>
  );
}
