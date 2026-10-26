"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { commitImportAction, previewImportAction } from "@/app/(app)/precon/actions";
import { Badge, btn, Card, field } from "@/components/ui";
import { DEFAULT_CURRENCY, FIELD_LABEL, IMPORT_FIELDS, type ImportField } from "@/lib/precon/import-fields";
import type { ImportPreview, RowStatus } from "@/lib/precon/inventory-import";
import type { ImportOutcome } from "@/lib/precon/service";

const SHOWN = 200;
const TONE: Record<RowStatus, "green" | "neutral" | "amber" | "red"> = { new: "green", duplicate: "neutral", conflict: "amber", error: "red" };
const LABEL: Record<RowStatus, string> = { new: "New", duplicate: "Already exists", conflict: "Differs from stored", error: "Error" };
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

/**
 * Review before commit. The browser only ever sends a document id and a column mapping; the server re-reads the stored file and
 * re-checks every row at commit time, so what is written is what the server validated, not what this screen displayed.
 */
export function ImportWizard({ documentId, projectId }: { documentId: string; projectId: string }) {
  const [pending, start] = useTransition();
  const [filename, setFilename] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<ImportField, number>>>({});
  const [mode, setMode] = useState<"insert_only" | "update_conflicts">("insert_only");
  const [skipErrors, setSkipErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  function load(m?: Partial<Record<ImportField, number>>) {
    start(async () => {
      setError(null);
      const r = await previewImportAction(documentId, m as Record<string, number> | undefined);
      if (!r.ok) return setError(r.error);
      setPreview(r.preview);
      setFilename(r.filename);
      setMapping(r.preview.mapping);
    });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once for this document
  useEffect(() => load(), [documentId]);

  function commit() {
    start(async () => {
      setError(null);
      const r = await commitImportAction({ documentId, mapping, mode, skipErrors });
      if (!r.ok) return setError(r.error);
      setOutcome(r.outcome);
    });
  }

  if (outcome) {
    return (
      <Card title="Import finished">
        <ul className="space-y-1 text-sm text-ink" role="status">
          <li>{outcome.inserted} new {outcome.inserted === 1 ? "record" : "records"} added (unverified until a person verifies them)</li>
          <li>{outcome.updated} existing {outcome.updated === 1 ? "record" : "records"} updated</li>
          <li>{outcome.skipped_duplicates} already existed, left as they were</li>
          <li>{outcome.skipped_conflicts} differed from stored values and were left unchanged</li>
          <li>{outcome.skipped_errors} rows with errors were skipped</li>
        </ul>
        <Link href={`/precon/projects/${projectId}`} className={`${btn.base} ${btn.primary} mt-4`}>View project inventory</Link>
      </Card>
    );
  }

  const p = preview;
  const canCommit = !!p && !p.blocking && (p.counts.new > 0 || (mode === "update_conflicts" && p.counts.conflict > 0)) && (p.counts.error === 0 || skipErrors);
  return (
    <div className="space-y-4">
      {error && <p role="alert" className="break-words rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {!p && !error && <p className="text-sm text-muted" role="status">Reading {filename || "the spreadsheet"}…</p>}
      {p && (
        <>
          <Card title="1. Match columns">
            <p className="mb-3 text-sm text-muted">Choose which column of <span className="break-all font-medium text-ink">{filename}</span> holds each field. Nothing is saved yet.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {IMPORT_FIELDS.map((f) => (
                <div key={f}>
                  <label htmlFor={`map-${f}`} className="mb-1 block text-xs font-medium text-muted">{FIELD_LABEL[f]}{f === "unit_number" ? " (required)" : ""}</label>
                  <select id={`map-${f}`} className={field} value={mapping[f] ?? ""} disabled={pending}
                    onChange={(e) => { const next = { ...mapping }; if (e.target.value === "") delete next[f]; else next[f] = Number(e.target.value); setMapping(next); }}>
                    <option value="">Not in this file</option>
                    {p.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <button type="button" disabled={pending} onClick={() => load(mapping)} className={`${btn.base} ${btn.secondary} mt-3`}>Update preview</button>
          </Card>

          <Card title="2. Review">
            {p.blocking && <p role="alert" className="mb-3 break-words text-sm font-medium text-red-700">{p.blocking}</p>}
            <ul className="mb-3 flex flex-wrap gap-2" aria-label="Summary">
              {(Object.keys(p.counts) as RowStatus[]).map((s) => <li key={s}><Badge tone={TONE[s]}>{p.counts[s]} {LABEL[s].toLowerCase()}</Badge></li>)}
            </ul>
            {p.notes.length > 0 && <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-muted">{p.notes.map((n) => <li key={n} className="break-words">{n}</li>)}</ul>}
            {p.unmapped.length > 0 && <p className="mb-3 text-sm text-muted">Not mapped: {p.unmapped.map((f) => FIELD_LABEL[f]).join(", ")}. These stay empty (never guessed).</p>}
            <ul className="space-y-2" aria-label="Rows">
              {p.rows.slice(0, SHOWN).map((r) => (
                <li key={r.line} className="min-w-0 rounded-md border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted">Row {r.line}</span><Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
                    {r.data && <span className="min-w-0 break-words">{show(r.data.unit_number)} · {show(r.data.unit_type)} · {r.data.price === null ? "no price" : `${r.data.price.toLocaleString("en-CA")} ${r.data.currency}`} · {r.data.availability}</span>}
                  </div>
                  {r.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-red-700">{r.errors.map((e) => <li key={e} className="break-words">{e}</li>)}</ul>}
                  {r.changes.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-amber-900">{r.changes.map((c) => <li key={c.field} className="break-words">{FIELD_LABEL[c.field as ImportField] ?? c.field}: {show(c.from)} → {show(c.to)}</li>)}</ul>
                  )}
                </li>
              ))}
            </ul>
            {p.rows.length > SHOWN && <p className="mt-2 text-sm text-muted">Showing the first {SHOWN} of {p.rows.length} rows. All rows are checked when you import.</p>}
          </Card>

          <Card title="3. Import">
            <p className="mb-3 text-sm text-muted">Currency defaults to {DEFAULT_CURRENCY} where the file has no currency column. Imported records are marked unverified.</p>
            <fieldset className="space-y-2">
              <legend className="sr-only">What to do with rows that differ from stored values</legend>
              <label className="flex min-h-11 items-start gap-2 text-sm sm:min-h-0"><input type="radio" name="mode" checked={mode === "insert_only"} onChange={() => setMode("insert_only")} className="mt-1 h-4 w-4" /> <span>Add new records only. Leave existing records untouched (recommended).</span></label>
              <label className="flex min-h-11 items-start gap-2 text-sm sm:min-h-0"><input type="radio" name="mode" checked={mode === "update_conflicts"} onChange={() => setMode("update_conflicts")} className="mt-1 h-4 w-4" /> <span>Also overwrite the fields shown above for {p.counts.conflict} existing {p.counts.conflict === 1 ? "record" : "records"}. They become unverified again.</span></label>
            </fieldset>
            {p.counts.error > 0 && (
              <label className="mt-3 flex min-h-11 items-start gap-2 text-sm sm:min-h-0"><input type="checkbox" checked={skipErrors} onChange={(e) => setSkipErrors(e.target.checked)} className="mt-1 h-4 w-4" /> <span>Skip the {p.counts.error} rows with errors and import the rest.</span></label>
            )}
            <div className="mt-4"><button type="button" disabled={!canCommit || pending} onClick={commit} className={`${btn.base} ${btn.primary}`}>{pending ? "Working…" : "Import"}</button></div>
          </Card>
        </>
      )}
    </div>
  );
}
