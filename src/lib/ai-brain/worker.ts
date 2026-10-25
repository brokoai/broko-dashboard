import { ClassificationError, classifyWithInfo, type Classifier } from "./classifier";
import type { ClassifierSelection } from "./classifier-select";
import { describeAudit } from "./activity";
import { JOB_DEFAULTS, backoffMs, type JobClaim, type JobStore } from "./jobs";
import type { AuditEvent, MessageFetcher } from "./ports";
import { categoryFor, processMessage, type PipelineDeps } from "./pipeline";
import { MessageAnalysisSchema, type ClassifierInfo, type ErrorCategory, type NormalizedMessage } from "./schema";
import { sourceRef } from "./task-mapping";

/**
 * Background-processing worker, independent of Next.js page rendering. It claims one job at a time, reads the message
 * by reference, runs the existing pipeline, and records the outcome through fenced job-store calls.
 *
 * It decides nothing about approval: the best a job can reach is a message waiting for a human (REVIEW_REQUIRED) or
 * needing no action. A timeout, malformed model output, or a crash can only produce a retry or a terminal failure.
 *
 * Where it RUNS in production is an infrastructure decision that has not been made (see the architecture audit).
 */

export class TransientClassificationError extends Error {
  constructor() {
    super("the classifier was temporarily unavailable");
    this.name = "TransientClassificationError";
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TransientClassificationError()), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

/** Shared by every job a worker handles: after a transient model failure, other jobs stop calling a dead API for a while. */
class ModelHealth {
  private downUntil = 0;
  isDown(t: number) { return t < this.downUntil; }
  trip(t: number, ms: number) { this.downUntil = Math.max(this.downUntil, t + ms); }
}

/**
 * Per-attempt classification policy for model mode:
 *  - invalid output (not JSON, schema violation, attempts to set owners/approvals) -> rules immediately, never retried;
 *  - transient failure (unreachable, timeout) -> throw, so the job is retried with backoff;
 *  - transient failure on the LAST attempt -> rules (recorded as model_unavailable), so a message is not stuck because the model is down.
 */
class JobClassifier implements Classifier {
  readonly name = "job-classifier";
  readonly mode = "llm" as const;
  transient = false;

  constructor(
    private readonly primary: Classifier,
    private readonly fallback: Classifier,
    private readonly attempt: number,
    private readonly maxAttempts: number,
    private readonly timeoutMs: number,
    private readonly health: ModelHealth,
    private readonly now: () => Date,
    private readonly cooldownMs: number,
  ) {}

  async analyze(msg: NormalizedMessage): Promise<unknown> {
    return (await this.analyzeDetailed(msg)).analysis;
  }

  async analyzeDetailed(msg: NormalizedMessage): Promise<{ analysis: unknown; info: ClassifierInfo }> {
    const viaRules = async (reason: NonNullable<ClassifierInfo["fallback_reason"]>) => ({
      analysis: (await classifyWithInfo(this.fallback, msg)).analysis,
      info: { name: this.fallback.name, mode: "rules" as const, fallback_reason: reason },
    });
    try {
      // Circuit breaker: a recent outage means we do not even try (counted as a transient failure of this attempt).
      if (this.health.isDown(this.now().getTime())) throw new TransientClassificationError();
      const out = await withTimeout(classifyWithInfo(this.primary, msg), this.timeoutMs);
      if (!MessageAnalysisSchema.safeParse(out.analysis).success) return viaRules("model_output_invalid");
      return { analysis: out.analysis, info: { name: this.primary.name, mode: "llm", fallback_reason: null } };
    } catch (e) {
      if (e instanceof ClassificationError) return viaRules("model_output_invalid");
      this.transient = true;
      this.health.trip(this.now().getTime(), this.cooldownMs);
      if (this.attempt < this.maxAttempts) throw new TransientClassificationError();
      return viaRules("model_unavailable");
    }
  }
}

export interface WorkerConfig {
  leaseMs: number;
  classifyTimeoutMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  /** After a transient model failure, skip the model for this long (shared across jobs). */
  modelCooldownMs: number;
}

export interface WorkerDeps {
  jobs: JobStore;
  fetcher: MessageFetcher;
  /** Everything the pipeline needs except the classifier, which the worker supplies per attempt. */
  pipeline: Omit<PipelineDeps, "classifier" | "canRetry">;
  selection: ClassifierSelection;
  workerId?: string;
  now?: () => Date;
  config?: Partial<WorkerConfig>;
  /** Deterministic jitter in tests. */
  jitter?: () => number;
}

export type WorkerRun =
  | { kind: "idle"; reaped: number }
  | { kind: "completed" | "retry" | "failed" | "lost_lease"; job_id: string; attempt: number; reaped: number; outcome?: string; error_category?: ErrorCategory; next_attempt_at?: string };

export interface DrainSummary { runs: number; completed: number; retried: number; failed: number; lost_lease: number; reaped: number }

export class AiWorker {
  readonly workerId: string;
  private readonly cfg: WorkerConfig;
  private readonly now: () => Date;
  private readonly health = new ModelHealth();

  constructor(private readonly deps: WorkerDeps) {
    this.workerId = deps.workerId ?? `worker-${Math.random().toString(36).slice(2, 10)}`;
    this.cfg = { leaseMs: JOB_DEFAULTS.leaseMs, classifyTimeoutMs: JOB_DEFAULTS.classifyTimeoutMs, backoffBaseMs: JOB_DEFAULTS.backoffBaseMs, backoffCapMs: JOB_DEFAULTS.backoffCapMs, modelCooldownMs: 30_000, ...deps.config };
    this.now = deps.now ?? (() => new Date());
  }

  /** An audit event for something the pipeline cannot see (a reaped job, a fetch failure). Content-free, typed, idempotent. */
  private async audit(workflowId: string | null, category: ErrorCategory, status: "pending" | "failed", attempt: number): Promise<boolean> {
    const e = {
      event_type: "workflow_failed" as const, status, stage: "ingest" as const, workflow_id: workflowId, task_id: null, classifier: null, intent: null,
      outcome: "FAILED" as const, flags: [], error_category: category, actor: null, decision: null, attempt,
    };
    const event: AuditEvent = { ...e, description: describeAudit(e), at: this.now().toISOString() };
    try {
      await this.deps.pipeline.audit.record(event);
      return true;
    } catch {
      return false; // never expose the cause; the job records audit_failed
    }
  }

  /** Claims and processes at most one job. Never throws for a job-level problem. */
  async runOnce(): Promise<WorkerRun> {
    const now = this.now();
    const { claim, reaped } = await this.deps.jobs.claim(this.workerId, now, this.cfg.leaseMs);
    for (const j of reaped) await this.audit(j.workflow_id, "processing_interrupted", "failed", j.attempts);
    if (!claim) return { kind: "idle", reaped: reaped.length };
    return { ...(await this.process(claim)), reaped: reaped.length };
  }

  /** Processes until no job is due (or `max` runs). Sequential by default; `concurrency` > 1 runs workers in parallel. */
  async drain(opts: { max?: number; concurrency?: number } = {}): Promise<DrainSummary> {
    const sum: DrainSummary = { runs: 0, completed: 0, retried: 0, failed: 0, lost_lease: 0, reaped: 0 };
    const max = opts.max ?? 100;
    const lane = async () => {
      while (sum.runs < max) {
        const r = await this.runOnce();
        sum.reaped += r.reaped;
        if (r.kind === "idle") return;
        sum.runs++;
        if (r.kind === "completed") sum.completed++;
        else if (r.kind === "retry") sum.retried++;
        else if (r.kind === "failed") sum.failed++;
        else sum.lost_lease++;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 1) }, lane));
    return sum;
  }

  private async finish(claim: JobClaim, kind: "retry" | "failed", category: ErrorCategory, workflowId: string | null, auditFailed: boolean): Promise<Omit<Extract<WorkerRun, { job_id: string }>, "reaped">> {
    const now = this.now();
    const base = { job_id: claim.job.id, attempt: claim.attempt, error_category: category };
    if (kind === "retry" && claim.attempt < claim.job.max_attempts) {
      const runAt = new Date(now.getTime() + backoffMs(claim.attempt, { base: this.cfg.backoffBaseMs, cap: this.cfg.backoffCapMs, jitter: this.deps.jitter }));
      const ok = await this.deps.jobs.retry(claim, { error_category: category, run_at: runAt, workflow_id: workflowId, audit_failed: auditFailed }, now);
      return ok ? { ...base, kind: "retry", next_attempt_at: runAt.toISOString() } : { ...base, kind: "lost_lease" };
    }
    const ok = await this.deps.jobs.fail(claim, { error_category: category, workflow_id: workflowId, audit_failed: auditFailed }, now);
    return ok ? { ...base, kind: "failed" } : { ...base, kind: "lost_lease" };
  }

  private async process(claim: JobClaim): Promise<Omit<Extract<WorkerRun, { job_id: string }>, "reaped">> {
    const { attempt } = claim;
    const max = claim.job.max_attempts;
    const willRetry = attempt < max;

    // 1. Read the message by reference. The body stays in memory for this call only.
    let raw;
    try {
      raw = await withTimeout(this.deps.fetcher.fetch(claim.job.ref), this.cfg.classifyTimeoutMs);
    } catch {
      const ok = await this.audit(claim.job.workflow_id, "internal_error", willRetry ? "pending" : "failed", attempt);
      return this.finish(claim, "retry", "internal_error", claim.job.workflow_id, !ok);
    }
    if (!raw) {
      const ok = await this.audit(claim.job.workflow_id, "invalid_input", "failed", attempt);
      return this.finish(claim, "failed", "invalid_input", claim.job.workflow_id, !ok); // the source message is gone: retrying cannot help
    }

    // 2. Classification policy for this attempt.
    const sel = this.deps.selection;
    const jobClassifier = sel.llm ? new JobClassifier(sel.llm.primary, sel.llm.fallback, attempt, max, this.cfg.classifyTimeoutMs, this.health, this.now, this.cfg.modelCooldownMs) : null;
    const classifier = jobClassifier ?? sel.classifier;
    const canRetry = (_stage: unknown, e: unknown) => e instanceof TransientClassificationError && willRetry;

    // 3. Run the existing pipeline. The lease holder may resume a record a crashed worker left behind.
    let res;
    try {
      res = await processMessage({ ...this.deps.pipeline, classifier, canRetry }, raw, { takeOver: true, attempt });
    } catch {
      const ok = await this.audit(claim.job.workflow_id, "internal_error", willRetry ? "pending" : "failed", attempt);
      return this.finish(claim, "retry", "internal_error", claim.job.workflow_id, !ok);
    }
    const auditFailed = !res.audit_ok;
    const record = res.record;
    const workflowId = record ? sourceRef(record.dedupe_key) : claim.job.workflow_id;

    if (res.outcome === "invalid_input") return this.finish(claim, "failed", "invalid_input", workflowId, auditFailed);
    if (res.outcome === "duplicate" || !record) {
      // The same source message already processed by an earlier attempt (e.g. a crash after the commit) keeps its real outcome;
      // a copy from another mailbox is a "duplicate".
      const ref = claim.job.ref;
      const sameSource = record !== null && record.mailbox_ref === ref.mailbox_ref && record.source_message_id === ref.source_message_id;
      const outcome = sameSource ? record.status : "duplicate";
      const ok = await this.deps.jobs.complete(claim, { workflow_id: workflowId, outcome, audit_failed: auditFailed }, this.now());
      return { kind: ok ? "completed" : "lost_lease", job_id: claim.job.id, attempt, outcome };
    }
    if (record.status === "FAILED") {
      const category = categoryFor(record.error?.stage ?? "classify", jobClassifier?.transient ? new TransientClassificationError() : undefined);
      // Only transient classifier failures are retried; anything else (e.g. invalid output from a custom classifier) is terminal.
      return this.finish(claim, jobClassifier?.transient ? "retry" : "failed", category, workflowId, auditFailed);
    }
    // Completed means "classified", never "approved". APPROVED is never reached by a worker.
    const ok = await this.deps.jobs.complete(claim, { workflow_id: workflowId, outcome: record.status, audit_failed: auditFailed }, this.now());
    return { kind: ok ? "completed" : "lost_lease", job_id: claim.job.id, attempt, outcome: record.status };
  }
}
