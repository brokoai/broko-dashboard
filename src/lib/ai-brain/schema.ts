import { z } from "zod";

/**
 * Broko AI Brain: Communication Agent contracts.
 *
 * Everything the model produces is UNTRUSTED. It only becomes application data after passing
 * these strict schemas (unknown keys rejected, lengths bounded, enums closed) AND the grounding
 * checks in grounding.ts. Nothing here depends on an email provider or a database.
 */

// ---------------------------------------------------------------------------------- enums
export const SOURCE_PROVIDERS = ["microsoft_graph", "gmail", "synthetic"] as const;
export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];

export const INTENTS = [
  "viewing_request", "property_inquiry", "offer_or_negotiation", "document_request",
  "maintenance_issue", "complaint", "payment_or_invoice", "legal_or_compliance",
  "scheduling", "internal_request", "spam_or_irrelevant", "other", "unknown",
] as const;
export type Intent = (typeof INTENTS)[number];

/** Maps 1:1 onto the dashboard's existing TaskPriority (low/medium/high/urgent). */
export const URGENCIES = ["low", "normal", "high", "urgent"] as const;
export type Urgency = (typeof URGENCIES)[number];

export const RISK_FLAGS = [
  "financial", "legal_or_compliance", "personal_data", "sender_unverified", "ambiguous_request",
  "prompt_injection_suspected", "contains_attachment", "possible_phishing", "high_value", "escalation_or_threat",
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

export const MISSING_INFO = [
  "contact_name", "contact_email", "contact_phone", "property_reference",
  "preferred_date", "preferred_time", "requested_action", "client_identity",
] as const;
export type MissingInfo = (typeof MISSING_INFO)[number];

export const PROCESSING_STATUSES = [
  "RECEIVED", "PROCESSING", "NO_ACTION", "REVIEW_REQUIRED", "APPROVED",
  "REJECTED", "TASK_CREATED", "NOTIFICATION_SENT", "FAILED",
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const PIPELINE_STAGES = [
  "ingest", "normalize", "classify", "validate", "ground", "assess", "owner", "decide", "task", "notify", "audit",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const IntentSchema = z.enum(INTENTS);
export const UrgencySchema = z.enum(URGENCIES);
export const RiskFlagSchema = z.enum(RISK_FLAGS);
export const MissingInfoSchema = z.enum(MISSING_INFO);
export const ProcessingStatusSchema = z.enum(PROCESSING_STATUSES);

// ------------------------------------------------------------------------------ limits
export const LIMITS = {
  subject: 300,
  body: 8_000,
  senderName: 120,
  messageId: 512,
  attachmentNames: 10,
  attachmentName: 120,
  recipients: 20,
} as const;

// --------------------------------------------------------------- provider-neutral input
/** What an email provider adapter hands us. Provider-specific shapes never go past this type. */
export interface RawEmail {
  provider: SourceProvider;
  /** The provider's own message id (Graph `id`, Gmail `id`). */
  id: string;
  /** RFC 5322 Message-ID, stable across mailboxes; the preferred de-duplication key. */
  internetMessageId?: string | null;
  threadId?: string | null;
  /** Which monitored mailbox/account this came from (tenant/mailbox boundary). */
  mailboxRef: string;
  receivedAt: string | Date;
  from: { name?: string | null; address: string };
  to?: string[];
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  hasAttachments?: boolean;
  attachmentNames?: string[];
}

export const NormalizedMessageSchema = z.strictObject({
  provider: z.enum(SOURCE_PROVIDERS),
  source_message_id: z.string().min(1).max(LIMITS.messageId),
  internet_message_id: z.string().min(1).max(LIMITS.messageId).nullable(),
  thread_id: z.string().max(LIMITS.messageId).nullable(),
  mailbox_ref: z.string().min(1).max(200),
  received_at: z.iso.datetime(),
  sender: z.strictObject({ name: z.string().max(LIMITS.senderName).nullable(), email: z.email().max(254) }),
  /** Empty unless the organisation's policy allows storing recipients. */
  recipients: z.array(z.email().max(254)).max(LIMITS.recipients),
  subject: z.string().max(LIMITS.subject),
  body_text: z.string().max(LIMITS.body),
  body_truncated: z.boolean(),
  quoted_text_removed: z.boolean(),
  has_attachments: z.boolean(),
  attachment_names: z.array(z.string().max(LIMITS.attachmentName)).max(LIMITS.attachmentNames),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;

// ------------------------------------------------------------ AI output contract (UNTRUSTED)
const nullableText = (max: number) => z.string().trim().max(max).nullable();

/**
 * The only shape the model may return. Deliberately has NO owner, NO task id, NO status and NO
 * approval field: owners come from configured rules, status from policy, approval from a human.
 */
export const MessageAnalysisSchema = z.strictObject({
  requires_action: z.boolean(),
  intent: IntentSchema,
  summary: z.string().trim().min(1).max(500),
  requested_action: nullableText(300),
  urgency: UrgencySchema,
  /** Verbatim words from the message that justify high/urgent; checked by grounding. */
  urgency_evidence: nullableText(200),
  confidence: z.number().min(0).max(1),
  contact: z.strictObject({
    name: nullableText(120),
    email: z.email().max(254).nullable(),
    phone: nullableText(40),
  }),
  property_reference: nullableText(120),
  /** Only a date the message itself states, with the verbatim words that state it. */
  requested_date: z.strictObject({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    evidence: z.string().trim().min(3).max(200),
  }).nullable(),
  missing_information: z.array(MissingInfoSchema).max(8),
  risk_flags: z.array(RiskFlagSchema).max(8),
  proposed_task: z.strictObject({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(1500),
  }).nullable(),
  /** A question for a human to put to the sender; the system never sends it. */
  clarification_question: nullableText(300),
});
export type MessageAnalysis = z.infer<typeof MessageAnalysisSchema>;

// ------------------------------------------------------------------ owner rules (config)
const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,59}$/);

/**
 * Ownership is decided by explicit configuration, never by the model. Rules match on the
 * (validated, grounded) intent, property-reference prefix and urgency only: deliberately NOT on
 * free-text keywords, which a sender could use to steer assignment.
 */
export const OwnerRuleSchema = z.strictObject({
  id: slug,
  description: z.string().max(200).optional(),
  /** Higher wins. Ties break by id for determinism. */
  priority: z.number().int().min(0).max(1000),
  when: z.strictObject({
    intents: z.array(IntentSchema).min(1).max(13).optional(),
    property_prefix: z.string().min(1).max(40).optional(),
    min_urgency: UrgencySchema.optional(),
  }),
  /** A user id from the dashboard's people list. Validated against it at resolution time. */
  owner_id: z.string().min(1).max(100),
});
export type OwnerRule = z.infer<typeof OwnerRuleSchema>;

// --------------------------------------------------------------------------------- policy
export const ProcessingPolicySchema = z.strictObject({
  /** "never": every task proposal needs human approval (default). "low_risk": see decide(). */
  auto_create: z.enum(["never", "low_risk"]),
  min_confidence: z.number().min(0).max(1),
  always_review_intents: z.array(IntentSchema).max(13),
  /** Sender domains the organisation vouches for (e.g. its own). Everything else is unverified. */
  verified_sender_domains: z.array(z.string().min(3).max(100)).max(50),
  /** Optional business-rule deadlines (days after receipt). Empty = never invent a deadline. */
  sla_days: z.strictObject({
    low: z.number().int().min(0).max(365).optional(),
    normal: z.number().int().min(0).max(365).optional(),
    high: z.number().int().min(0).max(365).optional(),
    urgent: z.number().int().min(0).max(365).optional(),
  }),
  /** Characters of the original message kept on the record. 0 = keep none (default). */
  retain_excerpt_chars: z.number().int().min(0).max(500),
});
export type ProcessingPolicy = z.infer<typeof ProcessingPolicySchema>;

export const DEFAULT_POLICY: ProcessingPolicy = {
  auto_create: "never",
  min_confidence: 0.8,
  always_review_intents: ["payment_or_invoice", "legal_or_compliance", "offer_or_negotiation", "complaint"],
  verified_sender_domains: [],
  sla_days: {},
  retain_excerpt_chars: 0,
};

// ----------------------------------------------------------------- stored / traced record
export const OwnerDecisionSchema = z.strictObject({
  user_id: z.string().max(100).nullable(),
  rule_id: z.string().max(60).nullable(),
  reason: z.string().max(300),
});
export type OwnerDecision = z.infer<typeof OwnerDecisionSchema>;

/** One row per message: reference, job state, AI result, owner, decision, outcome. */
export const CLASSIFIER_MODES = ["rules", "llm"] as const;
export const FALLBACK_REASONS = ["model_output_invalid", "model_unavailable"] as const;
/** Which classifier produced an analysis, and whether the model was bypassed. Never contains prompts, keys or email text. */
export const ClassifierInfoSchema = z.strictObject({
  name: z.string().min(1).max(80),
  mode: z.enum(CLASSIFIER_MODES),
  fallback_reason: z.enum(FALLBACK_REASONS).nullable(),
});
export type ClassifierInfo = z.infer<typeof ClassifierInfoSchema>;

export const ProcessedMessageSchema = z.strictObject({
  dedupe_key: z.string().min(1).max(700),
  provider: z.enum(SOURCE_PROVIDERS),
  source_message_id: z.string().min(1).max(LIMITS.messageId),
  internet_message_id: z.string().max(LIMITS.messageId).nullable(),
  mailbox_ref: z.string().max(200),
  received_at: z.iso.datetime(),
  sender_name: z.string().max(LIMITS.senderName).nullable(),
  sender_email: z.email().max(254),
  subject: z.string().max(LIMITS.subject),
  excerpt: z.string().max(500).nullable(),
  status: ProcessingStatusSchema,
  analysis: MessageAnalysisSchema.nullable(),
  classifier: ClassifierInfoSchema.nullable(),
  /** What the grounding step changed or dropped (no message content). */
  grounding_notes: z.array(z.string().max(200)).max(20),
  risk_flags: z.array(RiskFlagSchema).max(12),
  owner: OwnerDecisionSchema,
  review_reasons: z.array(z.string().max(120)).max(12),
  proposed_priority: z.enum(["low", "medium", "high", "urgent"]).nullable(),
  proposed_due_at: z.iso.datetime().nullable(),
  task_id: z.string().max(100).nullable(),
  notification: z.strictObject({ attempted: z.boolean(), sent: z.boolean(), detail: z.string().max(200) }),
  reviewed_by: z.string().max(100).nullable(),
  error: z.strictObject({ stage: z.enum(PIPELINE_STAGES), message: z.string().max(300) }).nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type ProcessedMessage = z.infer<typeof ProcessedMessageSchema>;

/** Priority names used by the dashboard's task model. */
export const URGENCY_TO_PRIORITY = { low: "low", normal: "medium", high: "high", urgent: "urgent" } as const;
