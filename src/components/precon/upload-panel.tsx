"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { beginUploadAction, finishUploadAction } from "@/app/(app)/precon/actions";
import { btn, field } from "@/components/ui";
import { ACCEPT_ATTR, checkUploadMeta, humanSize, MAX_UPLOAD_BYTES } from "@/lib/precon/files";
import { DETAIL_TEXT, DOC_KINDS, DOC_KIND_LABEL, type DocKind } from "@/lib/precon/types";

type Phase = { name: "idle" } | { name: "uploading"; pct: number } | { name: "processing" } | { name: "done"; message: string } | { name: "error"; message: string };

/** PUT the raw file straight to private storage (the browser never talks to our server with file bytes), reporting progress. */
function putFile(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    // The anon key is public by design (it ships to every browser); the signed URL's token is what authorizes this upload.
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (anon) xhr.setRequestHeader("apikey", anon);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`storage ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(file);
  });
}

export function UploadPanel({ projectId, replaces, defaultKind = "brochure", compact = false }: { projectId: string; replaces?: string; defaultKind?: DocKind; compact?: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<DocKind>(defaultKind);
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const busy = phase.name === "uploading" || phase.name === "processing";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) return setPhase({ name: "error", message: "Choose a file first." });
    // Convenience only: the server repeats every one of these checks, and also checks the file's real content.
    const check = checkUploadMeta(file.name, file.type, file.size, kind);
    if (!check.ok) return setPhase({ name: "error", message: check.message });
    setPhase({ name: "uploading", pct: 0 });
    const begun = await beginUploadAction({ projectId, filename: file.name, mime: file.type || check.mime, size: file.size, kind, title: title || undefined });
    if (!begun.ok) return setPhase({ name: "error", message: begun.error });
    try {
      await putFile(begun.uploadUrl, file, (pct) => setPhase({ name: "uploading", pct }));
    } catch {
      return setPhase({ name: "error", message: "The upload did not complete. Please try again." });
    }
    setPhase({ name: "processing" });
    const done = await finishUploadAction({ documentId: begun.documentId, ...(replaces ? { replaces } : {}) });
    if (!done.ok) return setPhase({ name: "error", message: done.error });
    if (input.current) input.current.value = "";
    setTitle("");
    const note = done.status === "failed" ? `Uploaded, but not searchable: ${DETAIL_TEXT[done.detail ?? ""] ?? "processing failed"}` : done.detail && DETAIL_TEXT[done.detail] ? `Uploaded. ${DETAIL_TEXT[done.detail]}` : "Uploaded and processed.";
    setPhase({ name: "done", message: note });
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2" aria-busy={busy}>
      <div className="sm:col-span-2">
        <label htmlFor={`up-file-${replaces ?? "new"}`} className="mb-1 block text-sm font-medium text-ink">{replaces ? "Replacement file" : "File"}</label>
        <input id={`up-file-${replaces ?? "new"}`} ref={input} type="file" accept={ACCEPT_ATTR} disabled={busy} className={`${field} file:mr-3 file:rounded file:border-0 file:bg-brand-soft file:px-3 file:py-1 file:text-sm file:text-brand-dark`} />
        <p className="mt-1 text-xs text-muted">PDF, JPG, PNG, WebP, TXT, CSV or XLSX, up to {humanSize(MAX_UPLOAD_BYTES)}.</p>
      </div>
      {!compact && (
        <>
          <div>
            <label htmlFor="up-kind" className="mb-1 block text-sm font-medium text-ink">Type</label>
            <select id="up-kind" value={kind} onChange={(e) => setKind(e.target.value as DocKind)} disabled={busy} className={field}>
              {DOC_KINDS.map((k) => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="up-title" className="mb-1 block text-sm font-medium text-ink">Title (optional)</label>
            <input id="up-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} disabled={busy} className={field} />
          </div>
        </>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={busy} className={`${btn.base} ${btn.primary}`}>{busy ? "Working…" : replaces ? "Upload replacement" : "Upload"}</button>
        <div role="status" aria-live="polite" className="min-w-0 break-words text-sm">
          {phase.name === "uploading" && (
            <span className="flex items-center gap-2 text-muted">
              <progress max={100} value={phase.pct} aria-label="Upload progress" className="h-2 w-32" /> {phase.pct}%
            </span>
          )}
          {phase.name === "processing" && <span className="text-muted">Reading and indexing the document…</span>}
          {phase.name === "done" && <span className="text-emerald-800">{phase.message}</span>}
          {phase.name === "error" && <span role="alert" className="text-red-700">{phase.message}</span>}
        </div>
      </div>
    </form>
  );
}
