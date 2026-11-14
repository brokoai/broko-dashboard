"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reviewKnowledgeAction } from "@/app/(app)/knowledge/actions";
import { btn, field } from "@/components/ui";
import type { KnowledgeStatus } from "@/lib/knowledge/types";

/**
 * Administrator controls for ONE item. The page only renders this for administrators, but that is a convenience: the server action,
 * the service, the repository and the database each refuse a non-administrator on their own.
 */
export function ReviewControls({ id, status }: { id: string; status: KnowledgeStatus }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const noteId = useId();
  if (status !== "proposed" && status !== "approved") return null;

  const run = (action: "approve" | "reject" | "expire") => {
    setError(null);
    if (action === "reject" && !note.trim()) { setError("Please give a reason before rejecting."); return; }
    start(async () => {
      const r = await reviewKnowledgeAction({ id, action, note });
      if (!r.ok) { setError(r.error); return; }
      setDone(action === "approve" ? "Approved. Broko AI can now use it." : action === "reject" ? "Rejected. It will not be used." : "Expired. Broko AI no longer uses it.");
      router.refresh();
    });
  };

  if (done) return <p role="status" className="mt-3 text-sm text-emerald-800">{done}</p>;
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <label htmlFor={noteId} className="block text-sm font-medium text-ink">{status === "proposed" ? "Note (required to reject)" : "Reason (optional)"}</label>
      <textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className={field} />
      <div className="flex flex-wrap items-center gap-2">
        {status === "proposed" ? (
          <>
            <button type="button" disabled={pending} onClick={() => run("approve")} className={`${btn.base} ${btn.primary}`}>{pending ? "Saving…" : "Approve"}</button>
            <button type="button" disabled={pending} onClick={() => run("reject")} className={`${btn.base} ${btn.secondary}`}>Reject</button>
          </>
        ) : (
          <button type="button" disabled={pending} onClick={() => run("expire")} className={`${btn.base} ${btn.secondary}`}>{pending ? "Saving…" : "Expire (stop using)"}</button>
        )}
      </div>
      {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
    </div>
  );
}
