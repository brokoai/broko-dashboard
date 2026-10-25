// Broko AI Brain: Communication Agent (Phase 1 core). See docs/ai-brain/ARCHITECTURE.md.
export * from "./schema";
export { NormalizationError, canonicalMessageId, dedupeKey, htmlToText, normalizeEmail, removeQuotedText } from "./normalize";
export { scanForInjection } from "./injection";
export { groundAnalysis } from "./grounding";
export { parseOwnerRules, resolveOwner } from "./owners";
export { assessPriority, assessRisk, decide, proposeDeadline } from "./policy";
export {
  ClassificationError, LlmClassifier, LlmError, RuleBasedClassifier, SYSTEM_PROMPT, anthropicTransport, buildUserPrompt, extractJson, classifyWithInfo,
  type Classifier, type LlmRequest, type LlmTransport,
} from "./classifier";
export { CachingClassifier, FallbackClassifier, rulesSelection, selectClassifier, type ClassifierSelection } from "./classifier-select";
export { ActivityMetadataSchema, describeAudit, metadataOf, parseActivityMetadata, toActivityEvents } from "./activity";
export { buildTaskInput, sourceRef } from "./task-mapping";
export { isValidReviewId, reviewIdFor, toMessageView, type AiMessageView } from "./view";
export { loadAiBrainConfig, DEFAULT_MODEL, type AiBrainConfig } from "./config";
export { createModelTransport } from "./model-transport";
export type { AuditEvent, AuditSink, EmailProvider, Notifier, ProcessingStore, ProviderConnection, TaskActor, TaskSink, TaskSinkContext } from "./ports";
export { TaskSinkDenied } from "./ports";
export { JOB_DEFAULTS, JOB_ID_RE, backoffMs, isValidJobId, jobId, jobKey, type JobClaim, type JobRecord, type JobStore } from "./jobs";
export { InMemoryJobStore, SyntheticMessageFetcher } from "./memory-jobs";
export { AiWorker, TransientClassificationError, type DrainSummary, type WorkerConfig, type WorkerDeps, type WorkerRun } from "./worker";
export { auditEventKey, type MessageFetcher } from "./ports";
export { InMemoryAuditSink, InMemoryProcessingStore, SyntheticEmailProvider, UnconfiguredEmailProvider, UnconfiguredNotifier } from "./memory";
export { ingestFromProvider, processMessage, reviewMessage, type IngestSummary, type PipelineDeps, type PipelineResult, type ReviewDecision, type ReviewResult } from "./pipeline";
export { ChatInputError, MAX_MESSAGE_CHARS, SUGGESTED_PROMPTS, askBrain, routeIntent, type BrainChatContext, type ChatReply, type ChatTurn, type SourceReport } from "./chat";
export { DUPLICATE_OF_VIEWING, SYNTHETIC_EMAILS, SYNTHETIC_NOW, longEmail } from "./fixtures";
