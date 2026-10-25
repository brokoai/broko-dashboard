import type { ErrorCategory, JobStatus, MessageRef } from "./schema";
import { sourceRef } from "./task-mapping";

/**
 * Durable job model for background processing. Design and rationale: docs/ai-brain/NEXT_PHASE_ARCHITECTURE_AUDIT.md.
 *
 * A job holds a REFERENCE to a message, never its content. "completed" means the message was classified;
 * it never means approved. Approval is a separate human step.
 */

export const JOB_DEFAULTS = {
  maxAttempts: 3,
  /** Longer than fetch + classification time, so a healthy worker never loses its lease. */
  leaseMs: 60_000,
  /** The model call is aborted after this long (a timeout is a transient failure). */
  classifyTimeoutMs: 25_000,
  backoffBaseMs: 5_000,
  backoffCapMs: 300_000,
} as const;

/**
 * Stable identity of a job: the provider reference, so enqueueing the same message twice is the same job.
 * A compact JSON array, never a delimiter join: `["a|b","c"]` and `["a","b|c"]` are different keys. The SQL function
 * ai_enqueue_job builds the same text with array_to_json(array[...])::text, so correlation ids match across both.
 */
export const jobKey = (ref: MessageRef): string => JSON.stringify([ref.provider, ref.mailbox_ref, ref.source_message_id]);
/**
 * THE job identifier: 12 lower-case hex characters, a hash of the job key. It is what the UI shows and the browser sends, what a
 * JobRecord carries as `id`, and the only job id any database function accepts or returns (`ai_jobs.correlation_id`). The
 * database's internal row uuid is never used outside the database.
 */
export const jobId = (ref: MessageRef): string => sourceRef(jobKey(ref));
export const JOB_ID_RE = /^[0-9a-f]{12}$/;
export const isValidJobId = (v: unknown): v is string => typeof v === "string" && JOB_ID_RE.test(v);

/**
 * Exponential backoff with jitter: base * 2^(attempt-1), capped, scaled into [50%, 100%] by `jitter()` (0..1).
 * `attempt` is the attempt that just failed (1-based). Pass a deterministic jitter in tests.
 */
export function backoffMs(attempt: number, opts: { base?: number; cap?: number; jitter?: () => number } = {}): number {
  const base = opts.base ?? JOB_DEFAULTS.backoffBaseMs;
  const cap = opts.cap ?? JOB_DEFAULTS.backoffCapMs;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const raw = (opts.jitter ?? Math.random)();
  const j = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1; // a bad jitter source must never produce an invalid date
  return Math.round(exp * (0.5 + 0.5 * j));
}

export interface JobRecord {
  /** Stable, derived from the reference (see jobId). */
  id: string;
  ref: MessageRef;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  /** Hashed message identity (sourceRef of the dedupe key), known once the message has been read. */
  workflow_id: string | null;
  /** Message status reached (e.g. REVIEW_REQUIRED, NO_ACTION) or "duplicate". Never "approved". */
  outcome: string | null;
  error_category: ErrorCategory | null;
  /** True if an audit event of this job could not be recorded. Surfaced in the dashboard. */
  audit_failed: boolean;
  requeued_by: string | null;
  requeued_at: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

/** Proof of a lease. Every later write must present it; a stale holder is rejected (fencing). */
export interface JobClaim {
  job: JobRecord;
  worker_id: string;
  /** The attempt number this claim represents: the fencing token. */
  attempt: number;
}

/**
 * Persistence port for jobs. EVERY method must be atomic. A database implementation uses row locks
 * (`FOR UPDATE SKIP LOCKED`) and conditional updates; see supabase/proposed/0004_ai_jobs.proposed.sql.
 * The in-memory implementation exists for tests and the local harness only and is NOT durable.
 */
export interface JobStore {
  /** Idempotent on the reference: a repeat returns the existing job with created: false. */
  enqueue(ref: MessageRef, now: Date, opts?: { max_attempts?: number }): Promise<{ job: JobRecord; created: boolean }>;
  /**
   * Claims at most one eligible job: queued/retry_wait whose time has come, or processing whose lease expired.
   * An expired job with no attempts left is marked failed (processing_interrupted) and returned in `reaped`.
   */
  claim(workerId: string, now: Date, leaseMs: number): Promise<{ claim: JobClaim | null; reaped: JobRecord[] }>;
  /** All three are fenced: they return false (and change nothing) unless `claim` still owns the job. */
  complete(claim: JobClaim, r: { workflow_id: string | null; outcome: string; audit_failed: boolean }, now: Date): Promise<boolean>;
  retry(claim: JobClaim, r: { error_category: ErrorCategory; run_at: Date; workflow_id: string | null; audit_failed: boolean }, now: Date): Promise<boolean>;
  fail(claim: JobClaim, r: { error_category: ErrorCategory; workflow_id: string | null; audit_failed: boolean }, now: Date): Promise<boolean>;
  /** failed -> queued with attempts reset. Authorization (administrators only) is the caller's job. Returns false if not failed. */
  requeue(id: string, by: string, now: Date): Promise<boolean>;
  get(id: string): Promise<JobRecord | null>;
  list(limit: number): Promise<JobRecord[]>;
}
