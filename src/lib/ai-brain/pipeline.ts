import { checkTaskChange } from "@/lib/permissions";
import type { Profile } from "@/lib/types";
import { ClassificationError, LlmError, classifyWithInfo, type Classifier } from "./classifier";
import { groundAnalysis } from "./grounding";
import { scanForInjection } from "./injection";
import { dedupeKey, NormalizationError, normalizeEmail } from "./normalize";
import { resolveOwner } from "./owners";
import type { AuditEvent, AuditSink, EmailProvider, Notifier, ProcessingStore, TaskActor, TaskSink } from "./ports";
import { TaskSinkDenied } from "./ports";
import { assessPriority, assessRisk, decide, proposeDeadline } from "./policy";
import {
  MessageAnalysisSchema, type ClassifierInfo, type OwnerRule, type PipelineStage, type ProcessedMessage, type ProcessingPolicy, type RawEmail,
} from "./schema";
import { buildTaskInput, type TaskOverrides } from "./task-mapping";

/**
 * Email -> task pipeline:
 *   INGEST > NORMALIZE > CLASSIFY > VALIDATE > GROUND > ASSESS > OWNER > DECIDE > TASK > NOTIFY > AUDIT
 * Every stage has typed inputs/outputs; a failure in any stage is recorded (status FAILED, stage,
 * sanitised message) and audited, never thrown past the caller, never swallowed silently.
 *
 * Non-negotiables enforced here: no email is ever sent; no financial or compliance action is taken;
 * owners come from configuration; creation follows the policy; humans approve by default.
 */
export interface PipelineDeps {
  classifier: Classifier;
  store: ProcessingStore;
  audit: AuditSink;
  ownerRules: readonly OwnerRule[];
  /** User ids that may be assigned work (from the dashboard's people list). */
  assignable: ReadonlySet<string>;
  policy: ProcessingPolicy;
  /** Without a sink no task can be created: proposals stay in review. */
  taskSink?: TaskSink;
  notifier?: Notifier;
  now?: () => Date;
  tenant?: string;
  includeRecipients?: boolean;
}

export interface StageResult { stage: PipelineStage; ok: boolean; detail?: string }
export type PipelineOutcome = "processed" | "duplicate" | "invalid_input";
export interface PipelineResult { outcome: PipelineOutcome; record: ProcessedMessage | null; stages: StageResult[] }

const SYSTEM_ACTOR: TaskActor = { kind: "system", id: "broko-ai-brain" };

/** Only messages from errors we raise ourselves are shown; anything else is reduced to a generic line. */
function safeMessage(e: unknown): string {
  if (e instanceof NormalizationError || e instanceof ClassificationError || e instanceof LlmError || e instanceof TaskSinkDenied) return e.message.slice(0, 280);
  return "unexpected internal error";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function emit(deps: PipelineDeps, key: string, stage: PipelineStage, event_type: AuditEvent["event_type"], status: AuditEvent["status"], description: string, meta: AuditEvent["meta"] = {}) {
  try {
    await deps.audit.record({ event_type, status, description: clip(description, 200), dedupe_key: key, stage, at: (deps.now?.() ?? new Date()).toISOString(), meta: { origin: "ai_brain", ...meta } });
  } catch {
    // The audit sink being down must not corrupt processing state; the record itself is the source of truth.
  }
}

// -------------------------------------------------------------------------------- processing
export async function processMessage(deps: PipelineDeps, raw: RawEmail, opts: { retryFailed?: boolean } = {}): Promise<PipelineResult> {
  const nowIso = () => (deps.now?.() ?? new Date()).toISOString();
  const stages: StageResult[] = [{ stage: "ingest", ok: true }];

  // NORMALIZE ------------------------------------------------------------------------------
  let normalized: ReturnType<typeof normalizeEmail>;
  try {
    normalized = normalizeEmail(raw, { includeRecipients: deps.includeRecipients, now: deps.now?.() });
    stages.push({ stage: "normalize", ok: true });
  } catch (e) {
    stages.push({ stage: "normalize", ok: false, detail: safeMessage(e) });
    await emit(deps, "invalid", "normalize", "workflow_failed", "failed", "Message rejected: it could not be normalised", { reason: safeMessage(e) });
    return { outcome: "invalid_input", record: null, stages };
  }
  const { message, signals } = normalized;
  const key = dedupeKey(message, deps.tenant);

  // IDEMPOTENCY: claim exactly once --------------------------------------------------------
  const t = nowIso();
  const initial: ProcessedMessage = {
    dedupe_key: key, provider: message.provider, source_message_id: message.source_message_id,
    internet_message_id: message.internet_message_id, mailbox_ref: message.mailbox_ref, received_at: message.received_at,
    sender_name: message.sender.name, sender_email: message.sender.email, subject: message.subject,
    excerpt: deps.policy.retain_excerpt_chars > 0 ? message.body_text.slice(0, deps.policy.retain_excerpt_chars) : null,
    status: "PROCESSING", analysis: null, classifier: null, grounding_notes: [], risk_flags: [],
    owner: { user_id: null, rule_id: null, reason: "not yet resolved" }, review_reasons: [],
    proposed_priority: null, proposed_due_at: null, task_id: null,
    notification: { attempted: false, sent: false, detail: "no notification attempted" },
    reviewed_by: null, error: null, created_at: t, updated_at: t,
  };
  const claim = await deps.store.claim(initial);
  if (!claim.claimed) {
    if (opts.retryFailed && claim.record.status === "FAILED") {
      const retry = await deps.store.transition(key, ["FAILED"], { status: "PROCESSING", error: null });
      if (!retry) return { outcome: "duplicate", record: claim.record, stages };
    } else {
      return { outcome: "duplicate", record: claim.record, stages };
    }
  } else {
    await emit(deps, key, "ingest", "email_received", "processed", `Email received: "${clip(message.subject, 80)}"`, { provider: message.provider });
  }

  const fail = async (stage: PipelineStage, e: unknown): Promise<PipelineResult> => {
    const detail = safeMessage(e);
    stages.push({ stage, ok: false, detail });
    const record = await deps.store.update(key, { status: "FAILED", error: { stage, message: detail } });
    await emit(deps, key, stage, "workflow_failed", "failed", `Processing failed at ${stage}`, { stage, reason: detail });
    return { outcome: "processed", record, stages };
  };

  // CLASSIFY (untrusted output) ------------------------------------------------------------
  let rawAnalysis: unknown;
  let classifierInfo: ClassifierInfo;
  try {
    const out = await classifyWithInfo(deps.classifier, message);
    rawAnalysis = out.analysis;
    classifierInfo = out.info;
    stages.push({ stage: "classify", ok: true, detail: out.info.fallback_reason ? `${out.info.name} (fallback: ${out.info.fallback_reason})` : out.info.name });
  } catch (e) {
    return fail("classify", e);
  }

  // VALIDATE (strict; unknown keys, wrong types and out-of-range values are rejected) -------
  const parsed = MessageAnalysisSchema.safeParse(rawAnalysis);
  if (!parsed.success) {
    return fail("validate", new ClassificationError(`model output failed validation: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ")}`));
  }
  stages.push({ stage: "validate", ok: true });

  // GROUND (drop whatever the message does not actually support) ---------------------------
  const grounded = groundAnalysis(message, parsed.data);
  stages.push({ stage: "ground", ok: true, detail: `${grounded.notes.length} adjustment(s)` });
  const analysis = grounded.analysis;

  // ASSESS ----------------------------------------------------------------------------------
  const injection = scanForInjection(message.subject, message.body_text, signals.hidden_text, message.sender.name, ...message.attachment_names);
  const flags = assessRisk({ message, analysis, injection, policy: deps.policy });
  const priority = assessPriority(analysis, flags);
  const deadline = proposeDeadline(analysis, message, deps.policy);
  stages.push({ stage: "assess", ok: true, detail: `${flags.length} risk flag(s)` });

  // OWNER (configuration, never the model) --------------------------------------------------
  const owner = resolveOwner({ analysis, rules: deps.ownerRules, assignable: deps.assignable });
  stages.push({ stage: "owner", ok: true, detail: owner.rule_id ?? "none" });

  // DECIDE ----------------------------------------------------------------------------------
  const decision = decide({ analysis, flags, owner, policy: deps.policy });
  stages.push({ stage: "decide", ok: true, detail: decision.status });

  let record = await deps.store.update(key, {
    analysis, classifier: classifierInfo, grounding_notes: grounded.notes.slice(0, 20), risk_flags: flags, owner, review_reasons: decision.reasons.slice(0, 12),
    proposed_priority: analysis.requires_action ? priority : null, proposed_due_at: analysis.requires_action ? deadline.due_at : null,
    status: decision.status,
  });
  await emit(deps, key, "decide", "message_classified", "processed", `Classified as ${analysis.intent} (confidence ${analysis.confidence.toFixed(2)})`, { intent: analysis.intent, status: decision.status, flags: flags.length });
  if (analysis.requires_action && analysis.proposed_task) {
    await emit(deps, key, "decide", "potential_task_identified", "processed", `Potential task: ${clip(analysis.proposed_task.title, 120)}`, { owner_rule: owner.rule_id });
  }

  // TASK + NOTIFY, only for policy-approved low-risk messages --------------------------------
  if (decision.status === "APPROVED") {
    if (!deps.taskSink) {
      record = await deps.store.update(key, { status: "REVIEW_REQUIRED", review_reasons: [...record.review_reasons, "task_sink_unavailable"].slice(0, 12) });
      return { outcome: "processed", record, stages };
    }
    try {
      record = await createTaskAndNotify(deps, record, SYSTEM_ACTOR, {}, stages);
    } catch (e) {
      // Not FAILED: the analysis is fine. A human can still approve it.
      stages.push({ stage: "task", ok: false, detail: safeMessage(e) });
      record = await deps.store.update(key, { status: "REVIEW_REQUIRED", review_reasons: [...record.review_reasons, "auto_create_denied"].slice(0, 12), error: { stage: "task", message: safeMessage(e) } });
      await emit(deps, key, "task", "workflow_failed", "failed", "Automatic task creation was not permitted; sent for review", { reason: safeMessage(e) });
    }
  }
  return { outcome: "processed", record, stages };
}

async function createTaskAndNotify(deps: PipelineDeps, record: ProcessedMessage, actor: TaskActor, overrides: TaskOverrides, stages: StageResult[]): Promise<ProcessedMessage> {
  const key = record.dedupe_key;
  const input = buildTaskInput(record, overrides);
  const created = await deps.taskSink!.createTask(input, { dedupe_key: key, source: "email", actor });
  stages.push({ stage: "task", ok: true, detail: created.created ? "created" : "already existed" });
  let next = await deps.store.update(key, { status: "TASK_CREATED", task_id: created.task_id, error: null });
  await emit(deps, key, "task", "task_created", "processed", `Task created from email: ${clip(input.title, 120)}`, { task_id: created.task_id, created: created.created, assigned: input.assigned_to !== null });

  // NOTIFY: attempted only when there is an owner AND a configured adapter. Never claimed otherwise.
  if (input.assigned_to && deps.notifier && created.created) {
    let n: { sent: boolean; detail: string };
    try {
      n = await deps.notifier.notify({ owner_id: input.assigned_to, title: input.title, task_id: created.task_id, dedupe_key: key });
    } catch {
      n = { sent: false, detail: "notification adapter error" };
    }
    stages.push({ stage: "notify", ok: n.sent, detail: n.detail });
    next = await deps.store.update(key, { notification: { attempted: true, sent: n.sent, detail: clip(n.detail, 200) }, ...(n.sent ? { status: "NOTIFICATION_SENT" as const } : {}) });
    await emit(deps, key, "notify", n.sent ? "notification_sent" : "workflow_failed", n.sent ? "processed" : "failed", n.sent ? "Owner notified" : "Owner could not be notified", { detail: clip(n.detail, 100) });
  } else {
    next = await deps.store.update(key, { notification: { attempted: false, sent: false, detail: !input.assigned_to ? "no owner to notify" : !deps.notifier ? "notification adapter not configured" : "task already existed; not re-notified" } });
  }
  return next;
}

// ----------------------------------------------------------------------------- human review
export type ReviewDecision =
  | ({ action: "approve"; by: Profile } & TaskOverrides)
  | { action: "reject"; by: Profile; reason?: string };

export type ReviewResult =
  | { ok: true; record: ProcessedMessage }
  | { ok: false; error: "not_found" | "forbidden" | "not_reviewable" | "invalid_override" | "task_failed"; message: string; record?: ProcessedMessage };

/**
 * Applies a human decision to a REVIEW_REQUIRED message. Authorization is the dashboard's own:
 * only administrators review, and assignment is checked with the existing permission rule
 * (checkTaskChange). The AI workflow gets no way around it. Approving twice (or concurrently)
 * creates one task: the status change is compare-and-set.
 */
export async function reviewMessage(deps: PipelineDeps, dedupe: string, decision: ReviewDecision): Promise<ReviewResult> {
  const rec = await deps.store.get(dedupe);
  if (!rec) return { ok: false, error: "not_found", message: "Message not found." };
  if (decision.by.role !== "admin") return { ok: false, error: "forbidden", message: "Only administrators can review AI-proposed tasks." };

  if (decision.action === "reject") {
    const next = await deps.store.transition(dedupe, ["REVIEW_REQUIRED"], { status: "REJECTED", reviewed_by: decision.by.id });
    if (!next) return { ok: false, error: "not_reviewable", message: "This message is no longer awaiting review.", record: rec };
    await emit(deps, dedupe, "audit", "message_classified", "processed", "Proposal rejected by a reviewer", { reviewed_by: decision.by.id, decision: "rejected" });
    return { ok: true, record: next };
  }

  const by = decision.by;
  const overrides: TaskOverrides = { assigned_to: decision.assigned_to, due_at: decision.due_at, priority: decision.priority };
  if (!deps.taskSink) return { ok: false, error: "task_failed", message: "Task creation is not available: no task backend is connected.", record: rec };
  if (overrides.assigned_to && !deps.assignable.has(overrides.assigned_to)) return { ok: false, error: "invalid_override", message: "That person cannot be assigned work.", record: rec };
  if (overrides.due_at && !/^\d{4}-\d{2}-\d{2}T/.test(overrides.due_at)) return { ok: false, error: "invalid_override", message: "Invalid due date.", record: rec };

  const input = buildTaskInput(rec, overrides);
  const denied = checkTaskChange(by, null, { assigned_to: input.assigned_to });
  if (denied) return { ok: false, error: "forbidden", message: denied, record: rec };

  // Claim the approval atomically: the loser of a race gets "not_reviewable".
  const claimed = await deps.store.transition(dedupe, ["REVIEW_REQUIRED"], { status: "APPROVED", reviewed_by: by.id });
  if (!claimed) return { ok: false, error: "not_reviewable", message: "This message is no longer awaiting review.", record: rec };
  await emit(deps, dedupe, "audit", "message_classified", "processed", "Proposal approved by a reviewer", { reviewed_by: by.id, decision: "approved" });

  const stages: StageResult[] = [];
  try {
    const record = await createTaskAndNotify(deps, claimed, { kind: "user", profile: by }, overrides, stages);
    return { ok: true, record };
  } catch (e) {
    // Put it back so a reviewer can retry; the task backend (not this code) is the source of truth.
    const back = await deps.store.update(dedupe, { status: "REVIEW_REQUIRED", error: { stage: "task", message: safeMessage(e) } });
    await emit(deps, dedupe, "task", "workflow_failed", "failed", "Task creation failed after approval", { reason: safeMessage(e) });
    return { ok: false, error: e instanceof TaskSinkDenied ? "forbidden" : "task_failed", message: safeMessage(e), record: back };
  }
}

// ------------------------------------------------------------------------------ batch ingest
export interface IngestSummary { skipped?: "provider_not_connected"; processed: number; duplicates: number; failed: number; invalid: number; nextCursor: string | null }

/** Pulls from a provider and processes each message independently (one bad message never stops the rest). */
export async function ingestFromProvider(deps: PipelineDeps, provider: EmailProvider, cursor: string | null, limit = 25): Promise<IngestSummary> {
  const conn = await provider.connection();
  if (conn.status !== "connected" && !conn.synthetic) {
    return { skipped: "provider_not_connected", processed: 0, duplicates: 0, failed: 0, invalid: 0, nextCursor: cursor };
  }
  const batch = await provider.fetchNew(cursor, Math.min(Math.max(limit, 1), 100));
  const sum: IngestSummary = { processed: 0, duplicates: 0, failed: 0, invalid: 0, nextCursor: batch.nextCursor };
  for (const m of batch.messages) {
    const r = await processMessage(deps, m);
    if (r.outcome === "duplicate") sum.duplicates++;
    else if (r.outcome === "invalid_input") sum.invalid++;
    else if (r.record?.status === "FAILED") sum.failed++;
    else sum.processed++;
  }
  return sum;
}

