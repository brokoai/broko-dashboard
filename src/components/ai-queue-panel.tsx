"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { processAiQueue, requeueAiJob } from "@/app/(app)/inbox/actions";
import { Badge, Card, btn, cx } from "@/components/ui";
import { jobStatusBadge, jobSummary, queueActive } from "@/lib/ai-presentation";
import type { AiJobView } from "@/lib/backend/types";

/**
 * Processing state of the background jobs. While anything is queued, running or waiting to retry, the page refreshes itself
 * (at most 20 times) so the reviewer sees progress without the page ever waiting on the model.
 */
export function AiQueuePanel({ jobs, queue, workerNote }: { jobs: AiJobView[]; queue: Record<string, number>; workerNote: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  const active = queueActive(queue);

  useEffect(() => {
    if (!active) return;
    let n = 0;
    const t = setInterval(() => { setNow(Date.now()); if (++n > 20) clearInterval(t); else router.refresh(); }, 3000);
    return () => clearInterval(t);
  }, [active, router]);

  const open = jobs.filter((j) => j.status !== "completed");
  const run = () => start(async () => { setError(""); const r = await processAiQueue(); if (r.error) setError(r.error); else router.refresh(); });
  const retry = (id: string) => start(async () => { setError(""); const r = await requeueAiJob(id); if (r.error) setError(r.error); else router.refresh(); });

  return (
    <Card title="Background processing" className="mb-4" action={<button type="button" disabled={pending} onClick={run} className={cx(btn.base, btn.secondary)}>Process queue now</button>}>
      <p className="mb-3 text-sm text-muted">{workerNote}</p>
      <ul className="mb-3 flex flex-wrap gap-2" aria-label="Job counts">
        {(["queued", "processing", "retry_wait", "completed", "failed"] as const).map((s) => (
          <li key={s}><Badge tone={jobStatusBadge(s).tone}>{jobStatusBadge(s).label}: {queue[s] ?? 0}</Badge></li>
        ))}
      </ul>
      {open.length === 0 ? (
        <p className="text-sm text-muted">Every message has been processed.</p>
      ) : (
        <ul className="divide-y divide-line">
          {open.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <span className="mr-2"><Badge tone={jobStatusBadge(j.status).tone}>{jobStatusBadge(j.status).label}</Badge></span>
                <span className="break-words">{jobSummary(j, now)}</span>
                <span className="ml-2 text-xs text-muted">ref {j.id}</span>
                {j.audit_failed && <span className="block text-xs text-brand-dark">Some audit events for this job could not be recorded.</span>}
              </div>
              {j.status === "failed" && <button type="button" disabled={pending} onClick={() => retry(j.id)} className={cx(btn.base, btn.secondary)}>Retry</button>}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-3 break-words text-sm text-brand-dark">{error}</p>}
    </Card>
  );
}
