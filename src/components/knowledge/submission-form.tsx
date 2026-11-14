"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewKnowledgeAction, submitKnowledgeAction } from "@/app/(app)/knowledge/actions";
import { Badge, btn, field } from "@/components/ui";
import { KNOWLEDGE_KINDS, KIND_LABEL, LIMITS, SCOPE_LABEL, type KnowledgeKind } from "@/lib/knowledge/types";
import type { SubmissionPreview } from "@/lib/knowledge/service";

interface Values { kind: KnowledgeKind; scope: "organization" | "project"; project_id: string; title: string; body: string; topic: string; source_ref: string; supersedes_id: string; expires_on: string }
const EMPTY = (kind: KnowledgeKind): Values => ({ kind, scope: "organization", project_id: "", title: "", body: "", topic: "", source_ref: "", supersedes_id: "", expires_on: "" });

/**
 * Two steps on purpose: write it, see exactly what will be sent for review, then confirm. Nothing is saved at the first step, and
 * what is saved is only ever a PROPOSAL.
 */
export function SubmissionForm({ projects, startAsCorrection, replaces }: { projects: { id: string; name: string }[]; startAsCorrection?: boolean; replaces?: { id: string; title: string } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [v, setV] = useState<Values>({ ...EMPTY(startAsCorrection || replaces ? "correction" : "procedure"), supersedes_id: replaces?.id ?? "" });
  const [preview, setPreview] = useState<SubmissionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const label = "mb-1 block text-sm font-medium text-ink";
  const set = <K extends keyof Values>(k: K, val: Values[K]) => { setSent(false); setV((p) => ({ ...p, [k]: val })); };
  const payload = () => ({ ...v, project_id: v.scope === "project" ? v.project_id : "" });

  const onPreview = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await previewKnowledgeAction(payload());
      if (!r.ok) { setError(r.error); return; }
      setPreview(r.preview);
    });
  };
  const onSubmit = () => {
    setError(null);
    start(async () => {
      const r = await submitKnowledgeAction(payload());
      if (!r.ok) { setError(r.error); return; }
      setPreview(null); setV(EMPTY("procedure")); setSent(true); if (replaces) router.replace("/knowledge");
      router.refresh();
    });
  };

  if (preview) {
    return (
      <div className="space-y-3" aria-live="polite">
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{preview.statement}</p>
        <div className="min-w-0 rounded-md border border-line p-3">
          <div className="flex flex-wrap gap-2"><Badge tone="blue">{preview.kind_label}</Badge><Badge>{preview.project_name ? `Project: ${preview.project_name}` : preview.scope_label}</Badge>{preview.flagged && <Badge tone="red">Contains instruction-like wording</Badge>}</div>
          <h3 className="mt-2 break-words text-sm font-semibold text-ink">{preview.input.title}</h3>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{preview.input.body}</p>
          {preview.input.source_ref && <p className="mt-2 break-words text-xs text-muted">Source: {preview.input.source_ref}</p>}
          {preview.input.expires_on && <p className="text-xs text-muted">Expires {preview.input.expires_on}</p>}
        </div>
        {preview.flagged && <p role="note" className="text-sm text-red-800">This wording looks like an instruction. It will be shown to the reviewer as text and is never obeyed.</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={pending} onClick={onSubmit} className={`${btn.base} ${btn.primary}`}>{pending ? "Submitting…" : "Submit for review"}</button>
          <button type="button" disabled={pending} onClick={() => setPreview(null)} className={`${btn.base} ${btn.secondary}`}>Edit</button>
        </div>
        {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={onPreview} className="grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
      {replaces && <p role="note" className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 sm:col-span-2">This will replace the approved item &ldquo;{replaces.title}&rdquo; only if an administrator approves it. Until then the old item stays in use.</p>}
      <div>
        <label htmlFor={id("kind")} className={label}>What is it?</label>
        <select id={id("kind")} value={v.kind} onChange={(e) => { const kind = e.target.value as KnowledgeKind; set("kind", kind); if (kind === "project_note") set("scope", "project"); }} className={field}>
          {KNOWLEDGE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={id("scope")} className={label}>Who does it apply to?</label>
        <select id={id("scope")} value={v.scope} disabled={v.kind === "project_note"} onChange={(e) => set("scope", e.target.value as Values["scope"])} className={field}>
          <option value="organization">{SCOPE_LABEL.organization}</option>
          <option value="project" disabled={projects.length === 0}>{SCOPE_LABEL.project}</option>
        </select>
      </div>
      {v.scope === "project" && (
        <div className="sm:col-span-2">
          <label htmlFor={id("project")} className={label}>Project</label>
          <select id={id("project")} required value={v.project_id} onChange={(e) => set("project_id", e.target.value)} className={field}>
            <option value="">Choose a project…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      <div className="sm:col-span-2">
        <label htmlFor={id("title")} className={label}>Title</label>
        <input id={id("title")} required minLength={LIMITS.title.min} maxLength={LIMITS.title.max} value={v.title} onChange={(e) => set("title", e.target.value)} className={field} />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor={id("body")} className={label}>{v.kind === "correction" ? "What is the correct information?" : "Details"}</label>
        <textarea id={id("body")} required minLength={LIMITS.body.min} maxLength={LIMITS.body.max} rows={5} value={v.body} onChange={(e) => set("body", e.target.value)} className={field} aria-describedby={id("hint")} />
        <p id={id("hint")} className="mt-1 text-xs text-muted">Write the fact itself. Never include passwords, keys, card numbers or personal identifiers. {v.body.length}/{LIMITS.body.max}</p>
      </div>
      <div>
        <label htmlFor={id("topic")} className={label}>Topic (optional)</label>
        <input id={id("topic")} maxLength={LIMITS.topic} value={v.topic} onChange={(e) => set("topic", e.target.value)} className={field} placeholder="e.g. reservation-deposit" />
      </div>
      <div>
        <label htmlFor={id("expires")} className={label}>Expires on (optional)</label>
        <input id={id("expires")} type="date" value={v.expires_on} onChange={(e) => set("expires_on", e.target.value)} className={field} />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor={id("source")} className={label}>Where does this come from? (optional)</label>
        <input id={id("source")} maxLength={LIMITS.sourceRef} value={v.source_ref} onChange={(e) => set("source_ref", e.target.value)} className={field} placeholder="e.g. Team meeting, 20 Oct" />
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={`${btn.base} ${btn.primary}`}>{pending ? "Checking…" : "Preview"}</button>
        <p className="text-xs text-muted">You will see exactly what is sent before anything is saved.</p>
      </div>
      {sent && <p role="status" className="text-sm text-emerald-800 sm:col-span-2">Submitted for review. It will not be used by Broko AI until an administrator approves it.</p>}
      {error && <p role="alert" className="min-w-0 break-words text-sm text-red-700 sm:col-span-2">{error}</p>}
    </form>
  );
}
