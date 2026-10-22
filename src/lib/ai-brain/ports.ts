import type { EventStatus, EventType, Profile, TaskInput } from "@/lib/types";
import type { IntegrationStatus } from "@/lib/types";
import type { AuditDecision, ErrorCategory, FALLBACK_REASONS, Intent, PipelineStage, ProcessedMessage, ProcessingStatus, RawEmail, RiskFlag, SourceProvider } from "./schema";

type FallbackReason = (typeof FALLBACK_REASONS)[number];

/**
 * Ports: everything the pipeline needs from the outside world. Each can be implemented by any
 * provider/database (Microsoft Graph, Gmail, Supabase, AWS, ...) without touching the AI logic.
 */

// A. Communication ingestion ---------------------------------------------------------------
export interface ProviderConnection {
  status: IntegrationStatus;
  last_sync_at: string | null;
  last_error: string | null;
  /** True only for fixtures. A synthetic provider must never be presented as a live connection. */
  synthetic: boolean;
}

export interface EmailProvider {
  readonly provider: SourceProvider;
  /** Honest connection state. Anything unverified is "pending_setup", never "connected". */
  connection(): Promise<ProviderConnection>;
  /** New messages after `cursor` (provider-defined, opaque). Read-only: adapters never send mail. */
  fetchNew(cursor: string | null, limit: number): Promise<{ messages: RawEmail[]; nextCursor: string | null }>;
}

// E. Task persistence ----------------------------------------------------------------------
export type TaskActor = { kind: "user"; profile: Profile } | { kind: "system"; id: string };

export interface TaskSinkContext {
  /** Idempotency key. The backend stores it as tasks.external_reference (unique per source). */
  dedupe_key: string;
  source: "email";
  actor: TaskActor;
}

export class TaskSinkDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSinkDenied";
  }
}

/**
 * Creates the task through the EXISTING task backend, under the actor's permissions (a real
 * backend must also enforce them itself). Must be idempotent on `dedupe_key`: a repeat returns the
 * existing task with `created: false`.
 */
export interface TaskSink {
  createTask(input: TaskInput, ctx: TaskSinkContext): Promise<{ task_id: string; created: boolean }>;
}

// F. Notification delivery -----------------------------------------------------------------
export interface Notifier {
  notify(n: { owner_id: string; title: string; task_id: string; dedupe_key: string }): Promise<{ sent: boolean; detail: string }>;
}

// G. Audit history -------------------------------------------------------------------------
/** Maps onto the dashboard's existing activity_events (email_received, message_classified, ...). */
export interface AuditEvent {
  /** Existing dashboard taxonomy (activity_events.event_type). */
  event_type: EventType;
  status: EventStatus;
  /** Built from the typed fields below by describeAudit(): fixed vocabulary, never message content. */
  description: string;
  stage: PipelineStage;
  at: string;
  /**
   * sourceRef(dedupe_key): short, non-reversible, stable per email. NEVER the dedupe key or Message-ID.
   * null only when no message could be identified (input rejected before it had an identity).
   */
  workflow_id: string | null;
  /** Dashboard task id, once a task exists. */
  task_id: string | null;
  classifier: { mode: "rules" | "llm"; fallback_reason: FallbackReason | null } | null;
  intent: Intent | null;
  outcome: ProcessingStatus | null;
  flags: RiskFlag[];
  error_category: ErrorCategory | null;
  /** The authenticated reviewer, or the system. Never inferred. */
  actor: { kind: "user" | "system"; id: string } | null;
  decision: AuditDecision | null;
}
export interface AuditSink {
  record(e: AuditEvent): Promise<void>;
}

// C/H. Job + review state ------------------------------------------------------------------
/**
 * Persistence for ProcessedMessage. A database implementation MUST make `claim` and `transition`
 * atomic (unique constraint on dedupe_key; conditional UPDATE ... WHERE status = ...). Never keep
 * this state only in memory in production.
 */
export interface ProcessingStore {
  /** Insert if absent. Returns the stored record and whether THIS call created it. */
  claim(record: ProcessedMessage): Promise<{ claimed: boolean; record: ProcessedMessage }>;
  get(dedupe_key: string): Promise<ProcessedMessage | null>;
  update(dedupe_key: string, patch: Partial<ProcessedMessage>): Promise<ProcessedMessage>;
  /** Compare-and-set on status. Returns null if the current status is not in `from`. */
  transition(dedupe_key: string, from: readonly ProcessingStatus[], patch: Partial<ProcessedMessage>): Promise<ProcessedMessage | null>;
  list(limit: number): Promise<ProcessedMessage[]>;
}
