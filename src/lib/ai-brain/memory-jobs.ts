import { JOB_DEFAULTS, jobId, type JobClaim, type JobRecord, type JobStore } from "./jobs";
import type { MessageFetcher } from "./ports";
import type { ErrorCategory, MessageRef, RawEmail } from "./schema";

/**
 * IN-MEMORY JOB STORE: tests and the local harness ONLY. Not durable (a restart loses every job), not shared between
 * processes or serverless instances, so it must never be presented as a production queue. It implements the same
 * contract a database store must (see JobStore); each method is atomic because it never awaits.
 */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly order = new Map<string, number>();
  private seq = 0;

  async enqueue(ref: MessageRef, now: Date, opts: { max_attempts?: number } = {}) {
    const id = jobId(ref);
    const existing = this.jobs.get(id);
    if (existing) return { job: structuredClone(existing), created: false };
    const iso = now.toISOString();
    const job: JobRecord = {
      id, ref: structuredClone(ref), status: "queued", attempts: 0, max_attempts: opts.max_attempts ?? JOB_DEFAULTS.maxAttempts,
      next_attempt_at: iso, lease_owner: null, lease_expires_at: null, workflow_id: null, outcome: null, error_category: null, audit_failed: false,
      requeued_by: null, requeued_at: null, enqueued_at: iso, started_at: null, finished_at: null, updated_at: iso,
    };
    this.jobs.set(id, job);
    this.order.set(id, this.seq++);
    return { job: structuredClone(job), created: true };
  }

  async claim(workerId: string, now: Date, leaseMs: number) {
    const t = now.getTime();
    const reaped: JobRecord[] = [];
    const candidates = [...this.jobs.values()].sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at) || this.order.get(a.id)! - this.order.get(b.id)!);
    for (const job of candidates) {
      const due = (job.status === "queued" || job.status === "retry_wait") && Date.parse(job.next_attempt_at) <= t;
      const abandoned = job.status === "processing" && job.lease_expires_at !== null && Date.parse(job.lease_expires_at) <= t;
      if (!due && !abandoned) continue;
      if (abandoned && job.attempts >= job.max_attempts) {
        // A worker took the last attempt and never reported back: do not loop forever.
        Object.assign(job, { status: "failed", error_category: "processing_interrupted", lease_owner: null, lease_expires_at: null, finished_at: now.toISOString(), updated_at: now.toISOString() });
        reaped.push(structuredClone(job));
        continue;
      }
      const attempt = job.attempts + 1;
      Object.assign(job, {
        status: "processing", attempts: attempt, lease_owner: workerId, lease_expires_at: new Date(t + leaseMs).toISOString(),
        started_at: job.started_at ?? now.toISOString(), error_category: null, updated_at: now.toISOString(),
      });
      const claim: JobClaim = { job: structuredClone(job), worker_id: workerId, attempt };
      return { claim, reaped };
    }
    return { claim: null, reaped };
  }

  /** The job, only if this claim still owns it (same worker, same attempt, still processing). */
  private owned(c: JobClaim): JobRecord | null {
    const job = this.jobs.get(c.job.id);
    return job && job.status === "processing" && job.lease_owner === c.worker_id && job.attempts === c.attempt ? job : null;
  }

  async complete(c: JobClaim, r: { workflow_id: string | null; outcome: string; audit_failed: boolean }, now: Date) {
    const job = this.owned(c);
    if (!job) return false;
    Object.assign(job, {
      status: "completed", workflow_id: r.workflow_id, outcome: r.outcome, audit_failed: job.audit_failed || r.audit_failed, error_category: null,
      lease_owner: null, lease_expires_at: null, finished_at: now.toISOString(), updated_at: now.toISOString(),
    });
    return true;
  }

  async retry(c: JobClaim, r: { error_category: ErrorCategory; run_at: Date; workflow_id: string | null; audit_failed: boolean }, now: Date) {
    const job = this.owned(c);
    if (!job || job.attempts >= job.max_attempts) return false; // no attempts left: the caller must fail() instead
    Object.assign(job, {
      status: "retry_wait", error_category: r.error_category, next_attempt_at: r.run_at.toISOString(), workflow_id: r.workflow_id ?? job.workflow_id,
      audit_failed: job.audit_failed || r.audit_failed, lease_owner: null, lease_expires_at: null, updated_at: now.toISOString(),
    });
    return true;
  }

  async fail(c: JobClaim, r: { error_category: ErrorCategory; workflow_id: string | null; audit_failed: boolean }, now: Date) {
    const job = this.owned(c);
    if (!job) return false;
    Object.assign(job, {
      status: "failed", error_category: r.error_category, workflow_id: r.workflow_id ?? job.workflow_id, audit_failed: job.audit_failed || r.audit_failed,
      lease_owner: null, lease_expires_at: null, finished_at: now.toISOString(), updated_at: now.toISOString(),
    });
    return true;
  }

  async requeue(id: string, by: string, now: Date) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "failed") return false;
    Object.assign(job, {
      status: "queued", attempts: 0, error_category: null, outcome: null, next_attempt_at: now.toISOString(),
      requeued_by: by, requeued_at: now.toISOString(), finished_at: null, updated_at: now.toISOString(),
    });
    return true;
  }

  async get(id: string) {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : null;
  }

  async list(limit: number) {
    return [...this.jobs.values()].sort((a, b) => this.order.get(a.id)! - this.order.get(b.id)!).slice(0, limit).map((j) => structuredClone(j));
  }
}

/** Fixture-backed fetcher (tests and the demo): the "provider" is a list of synthetic emails. */
export class SyntheticMessageFetcher implements MessageFetcher {
  private readonly byRef = new Map<string, RawEmail>();
  /** Test hook: make the next N fetches fail like a provider outage. */
  failNext = 0;
  fetches = 0;

  constructor(messages: readonly RawEmail[]) {
    for (const m of messages) this.byRef.set(`${m.provider}|${m.mailboxRef}|${m.id}`, m);
  }

  async fetch(ref: MessageRef) {
    this.fetches++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("provider unavailable");
    }
    return this.byRef.get(`${ref.provider}|${ref.mailbox_ref}|${ref.source_message_id}`) ?? null;
  }
}
