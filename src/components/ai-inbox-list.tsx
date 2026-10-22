"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { reviewAiMessage } from "@/app/(app)/inbox/actions";
import { Badge, Card, PriorityBadge, btn, cx, field } from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { PRIORITY_LABEL, TASK_PRIORITIES, type Person, type TaskPriority } from "@/lib/types";
import type { ProcessedMessage } from "@/lib/ai-brain";

type Tone = "neutral" | "red" | "amber" | "blue" | "green" | "dark";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  REVIEW_REQUIRED: { label: "Needs review", tone: "amber" },
  TASK_CREATED: { label: "Task created", tone: "green" },
  NOTIFICATION_SENT: { label: "Task created", tone: "green" },
  REJECTED: { label: "Rejected", tone: "neutral" },
  NO_ACTION: { label: "No action needed", tone: "neutral" },
  FAILED: { label: "Processing failed", tone: "red" },
  APPROVED: { label: "Approved", tone: "blue" },
  PROCESSING: { label: "Processing", tone: "blue" },
  RECEIVED: { label: "Received", tone: "blue" },
};

const text = (s: string) => s.replace(/[_:]/g, " ");
const REASON: Record<string, string> = {
  policy_requires_approval: "Every AI-proposed task needs a person's approval.",
  low_confidence: "The AI was not confident enough.",
  missing_information: "Some details are missing from the message.",
  no_owner: "No ownership rule matched, so nobody is assigned yet.",
  no_task_proposal: "The AI did not propose a task.",
  auto_create_denied: "Automatic creation was not permitted.",
  task_sink_unavailable: "No task backend is available.",
};
const reasonLabel = (r: string) =>
  REASON[r] ?? (r.startsWith("sensitive_intent:") ? `Sensitive topic (${text(r.slice(17))}). A person must decide.` : r.startsWith("risk:") ? `Risk flag: ${text(r.slice(5))}.` : text(r));

function ReviewForm({ m, people, onDone }: { m: ProcessedMessage; people: Person[]; onDone: (taskId: string | null) => void }) {
  const id = useId();
  const [assignee, setAssignee] = useState(m.owner.user_id ?? "");
  const [priority, setPriority] = useState<TaskPriority>(m.proposed_priority ?? "medium");
  const [due, setDue] = useState(m.proposed_due_at ? m.proposed_due_at.slice(0, 10) : "");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const submit = (action: "approve" | "reject") => start(async () => {
    setError("");
    const r = await reviewAiMessage(m.dedupe_key, action === "reject" ? { action } : { action, assigned_to: assignee || null, priority, due_at: due || null });
    if (r.error) setError(r.error); else onDone(r.taskId ?? null);
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit("approve"); }} className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3" aria-label={`Review: ${m.subject}`}>
      <div>
        <label htmlFor={`${id}-a`} className="mb-1 block text-xs font-medium text-muted">Assign to</label>
        <select id={`${id}-a`} className={field} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Unassigned</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.id === m.owner.user_id ? " (suggested)" : ""}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-p`} className="mb-1 block text-xs font-medium text-muted">Priority</label>
        <select id={`${id}-p`} className={field} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
          {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-d`} className="mb-1 block text-xs font-medium text-muted">Due date</label>
        <input id={`${id}-d`} type="date" className={field} value={due} onChange={(e) => setDue(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2 sm:col-span-3">
        <button type="submit" disabled={pending} className={cx(btn.base, btn.primary)}>Approve and create task</button>
        <button type="button" disabled={pending} onClick={() => submit("reject")} className={cx(btn.base, btn.secondary)}>Reject</button>
      </div>
      <p className="text-xs text-muted sm:col-span-3">Approving creates one task in the dashboard. No reply is sent to the sender.</p>
      {error && <p role="alert" className="break-words text-sm text-brand-dark sm:col-span-3">{error}</p>}
    </form>
  );
}

function MessageCard({ m, people, nameOf }: { m: ProcessedMessage; people: Person[]; nameOf: (id: string | null) => string }) {
  const [done, setDone] = useState<{ taskId: string | null } | null>(null);
  const st = STATUS[m.status] ?? { label: text(m.status), tone: "neutral" as Tone };
  const a = m.analysis;
  const taskId = m.task_id ?? done?.taskId ?? null;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold text-ink">{m.subject}</h3>
          <p className="break-words text-sm text-muted">From {m.sender_name ? `${m.sender_name} · ` : ""}{m.sender_email} · {formatDate(m.received_at)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="dark">Synthetic</Badge>
          {m.classifier?.fallback_reason && <Badge tone="amber">{m.classifier.fallback_reason === "model_unavailable" ? "Rule-based (model unavailable)" : "Rule-based (model output rejected)"}</Badge>}
          <Badge tone={st.tone}>{st.label}</Badge>
          {m.proposed_priority && <PriorityBadge priority={m.proposed_priority} />}
        </div>
      </div>

      {a && (
        <p className="mt-3 break-words text-sm text-fg">
          <span className="font-medium">AI summary:</span> {a.summary}{" "}
          <span className="text-muted">(intent: {text(a.intent)}, confidence {Math.round(a.confidence * 100)}%)</span>
        </p>
      )}

      {m.risk_flags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5" role="list" aria-label="Risk flags">
          {m.risk_flags.map((f) => <span key={f} role="listitem"><Badge tone={f === "sender_unverified" ? "amber" : "red"}>{text(f)}</Badge></span>)}
        </div>
      )}

      {m.status === "FAILED" && <p role="alert" className="mt-3 text-sm text-brand-dark">Processing failed at “{m.error?.stage}”. {m.error?.message}</p>}

      {a?.proposed_task && m.status !== "NO_ACTION" && (
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-muted">Proposed task: </dt><dd className="inline break-words">{a.proposed_task.title}</dd></div>
          <div><dt className="inline text-muted">Suggested owner: </dt><dd className="inline">{m.owner.user_id ? nameOf(m.owner.user_id) : "none"} <span className="text-muted">({m.owner.reason})</span></dd></div>
          <div><dt className="inline text-muted">Due: </dt><dd className="inline">{m.proposed_due_at ? formatDate(m.proposed_due_at) : "not stated"}</dd></div>
          {a.missing_information.length > 0 && <div><dt className="inline text-muted">Missing: </dt><dd className="inline">{a.missing_information.map(text).join(", ")}</dd></div>}
        </dl>
      )}

      {m.status === "REVIEW_REQUIRED" && !done && m.review_reasons.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium text-ink">Why this needs review</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-fg">{m.review_reasons.map((r) => <li key={r}>{reasonLabel(r)}</li>)}</ul>
          {m.grounding_notes.length > 0 && <p className="mt-2 text-muted">{m.grounding_notes.length} AI claim(s) were removed because the message did not support them.</p>}
        </details>
      )}

      {(m.status === "TASK_CREATED" || m.status === "NOTIFICATION_SENT" || done) && (
        <p className="mt-3 text-sm" role="status">
          Task created from this message. {taskId && <Link className="font-medium text-brand underline" href={`/tasks/${taskId}`}>View task</Link>}
          <span className="block text-muted">Notification: {m.notification.attempted || !done ? m.notification.detail : "not sent (notification adapter not configured)"}</span>
        </p>
      )}

      {m.status === "REVIEW_REQUIRED" && !done && <ReviewForm m={m} people={people} onDone={(id) => setDone({ taskId: id })} />}
    </Card>
  );
}

export function AiInboxList({ messages, people }: { messages: ProcessedMessage[]; people: Person[] }) {
  const names = new Map(people.map((p) => [p.id, p.full_name]));
  const nameOf = (id: string | null) => (id && names.get(id)) || "someone";
  const order: Record<string, number> = { REVIEW_REQUIRED: 0, FAILED: 1, TASK_CREATED: 2, NOTIFICATION_SENT: 2, REJECTED: 3, NO_ACTION: 4 };
  const sorted = [...messages].sort((x, y) => (order[x.status] ?? 5) - (order[y.status] ?? 5));
  return <div className="grid gap-4">{sorted.map((m) => <MessageCard key={m.dedupe_key} m={m} people={people} nameOf={nameOf} />)}</div>;
}
